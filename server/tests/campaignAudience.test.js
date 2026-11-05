import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';
process.env.CAMPAIGN_SEND_RATE_LIMIT_MAX = '1000';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Segment from '../src/models/Segment.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { waitForCampaignDispatch } from '../src/services/campaignDispatch.service.js';
import { applyAudienceSchema } from '../src/validators/campaign.validator.js';

describe('Audience validator (no DB)', () => {
  const id = new mongoose.Types.ObjectId().toString();
  const parse = (body) => applyAudienceSchema.safeParse({ params: { id }, body });

  it('requires exactly one source and validates inputs', () => {
    assert.equal(parse({}).success, false);
    assert.equal(parse({ tags: ['vip'], segmentId: id }).success, false);
    assert.equal(parse({ tags: [] }).success, false);
    assert.equal(parse({ tags: ['bad!'] }).success, false);
    assert.equal(parse({ segmentId: 'nope' }).success, false);
    assert.equal(parse({ tags: ['vip'], mode: 'merge' }).success, false);
    const ok = parse({ tags: ['VIP', 'vip'] });
    assert.equal(ok.success, true);
    assert.deepEqual(ok.data.body.tags, ['vip']);
    assert.equal(ok.data.body.mode, 'replace');
    assert.equal(parse({ segmentId: id, mode: 'add' }).success, true);
  });
});

describe('Campaign audience API', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `aud-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userOne;
  let userTwo;
  let tokenOne;
  let tokenTwo;
  let transport;
  const c = {};

  const request = (method, urlPath, { token = tokenOne, body } = {}) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const makeCampaign = (overrides = {}) =>
    Campaign.create({
      userId: userOne._id,
      name: 'Audience Campaign',
      subject: 'Hello {{firstName | "there"}}',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      ...overrides,
    });

  const ids = () => [userOne._id, userTwo._id];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Audience Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      userOne = await User.create({ name: 'Aud One', email: `${prefix}-one@example.com`, passwordHash });
      userTwo = await User.create({ name: 'Aud Two', email: `${prefix}-two@example.com`, passwordHash });
      tokenOne = signAccessToken(userOne);
      tokenTwo = signAccessToken(userTwo);
      const mk = (name, tags, extra = {}, userId = userOne._id) =>
        Contact.create({ userId, name, email: `${prefix}-${name.toLowerCase()}@example.com`, tags, ...extra });
      c.alice = await mk('Alice', ['vip']);
      c.bobby = await mk('Bobby', ['vip', 'lead']);
      c.carol = await mk('Carol', ['lead']);
      c.erin = await mk('Erin', ['vip'], { isUnsubscribed: true });
      c.zed = await mk('Zed', ['vip'], {}, userTwo._id);
    }
  });

  beforeEach(async () => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
    if (isDbConnected) {
      await Campaign.deleteMany({ userId: { $in: ids() } });
      await Segment.deleteMany({ userId: { $in: ids() } });
      await Delivery.deleteMany({ userId: { $in: ids() } });
    }
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Delivery.deleteMany({ userId: { $in: ids() } });
      await Campaign.deleteMany({ userId: { $in: ids() } });
      await Segment.deleteMany({ userId: { $in: ids() } });
      await Contact.deleteMany({ userId: { $in: ids() } });
      await User.deleteMany({ _id: { $in: ids() } });
      await mongoose.disconnect();
    }
  });

  const apply = (campaignId, body, token) =>
    request('POST', `/api/v1/campaigns/${campaignId}/audience`, { token, body });

  it('fills recipients from tags, skipping unsubscribed and foreign contacts', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const campaign = await makeCampaign({ recipientIds: [c.carol._id] });
    const res = await apply(campaign._id, { tags: ['VIP'] });
    assert.equal(res.status, 200);
    const data = (await res.json()).data;
    assert.equal(data.matched, 2);
    assert.deepEqual(data.campaign.recipientIds.sort(), [String(c.alice._id), String(c.bobby._id)].sort());
  });

  it('adds to existing recipients in add mode without duplicates', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const campaign = await makeCampaign({ recipientIds: [c.alice._id, c.carol._id] });
    const res = await apply(campaign._id, { tags: ['vip'], mode: 'add' });
    const data = (await res.json()).data;
    assert.equal(data.recipientsCount, 3);
    assert.deepEqual(
      data.campaign.recipientIds.sort(),
      [c.alice, c.bobby, c.carol].map((x) => String(x._id)).sort()
    );
  });

  it('applies a saved segment and 404s for foreign segments', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const segment = await Segment.create({
      userId: userOne._id,
      name: 'Leads',
      criteria: { tagsAny: ['lead'], tagsAll: [], tagsNone: [] },
    });
    const campaign = await makeCampaign();
    let res = await apply(campaign._id, { segmentId: String(segment._id) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.recipientsCount, 2);

    const foreign = await Campaign.create({ userId: userTwo._id, name: 'Foreign', subject: 'S' });
    res = await apply(foreign._id, { segmentId: String(segment._id) }, tokenTwo);
    assert.equal(res.status, 404);
  });

  it('locks non-draft campaigns and enforces ownership', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const scheduled = await makeCampaign({ status: 'scheduled', scheduledAt: new Date(Date.now() + 3600000) });
    assert.equal((await apply(scheduled._id, { tags: ['vip'] })).status, 409);
    assert.equal((await Campaign.findById(scheduled._id)).recipientIds.length, 0);

    const draft = await makeCampaign();
    assert.equal((await apply(draft._id, { tags: ['vip'] }, tokenTwo)).status, 404);
  });

  it('applied audiences go through the normal send with personalization', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const campaign = await makeCampaign();
    await apply(campaign._id, { tags: ['vip'] });
    const res = await request('POST', `/api/v1/campaigns/${campaign._id}/send`, { body: { confirm: true } });
    assert.equal(res.status, 202);
    await waitForCampaignDispatch(campaign._id);

    const recipients = transport.sentEmails.map((m) => m.to).sort();
    assert.deepEqual(recipients, [c.alice.email, c.bobby.email].sort());
    assert.ok(!recipients.includes(c.erin.email));
    assert.ok(transport.sentEmails.every((m) => /^Hello (Alice|Bobby)$/.test(m.subject)));
  });
});
