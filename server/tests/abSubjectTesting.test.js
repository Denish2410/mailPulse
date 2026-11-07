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
import Delivery from '../src/models/Delivery.js';
import TrackingEvent from '../src/models/TrackingEvent.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { waitForCampaignDispatch } from '../src/services/campaignDispatch.service.js';
import { getCampaignVariantStats } from '../src/services/tracking.service.js';
import { createCampaignSchema, updateCampaignSchema } from '../src/validators/campaign.validator.js';

describe('A/B subject validation (no DB)', () => {
  it('accepts an optional subjectB and defaults it to empty', () => {
    const base = { name: 'Test campaign', subject: 'Hello' };
    const none = createCampaignSchema.safeParse({ body: base });
    assert.equal(none.success, true);
    assert.equal(none.data.body.subjectB, '');
    const withB = createCampaignSchema.safeParse({ body: { ...base, subjectB: '  Hi there  ' } });
    assert.equal(withB.data.body.subjectB, 'Hi there');
    assert.equal(createCampaignSchema.safeParse({ body: { ...base, subjectB: 'x'.repeat(201) } }).success, false);
  });

  it('allows updating only subjectB', () => {
    const id = new mongoose.Types.ObjectId().toString();
    assert.equal(updateCampaignSchema.safeParse({ params: { id }, body: { subjectB: 'New' } }).success, true);
    assert.equal(updateCampaignSchema.safeParse({ params: { id }, body: {} }).success, false);
  });
});

describe('A/B subject testing', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `ab-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let user;
  let token;
  let contacts = [];
  let transport;

  const useTransport = () => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({
      transport,
      from: 'MailPulse Test <no-reply@mailpulse.test>',
    });
  };
  const request = (method, urlPath, body) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const makeCampaign = (overrides = {}) =>
    Campaign.create({
      userId: user._id,
      name: 'AB Campaign',
      subject: 'Subject A',
      subjectB: 'Subject B',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'draft',
      recipientIds: contacts.map((c) => c._id),
      ...overrides,
    });
  const cleanup = async () => {
    await Delivery.deleteMany({ userId: user._id });
    await TrackingEvent.deleteMany({ userId: user._id });
    await Campaign.deleteMany({ userId: user._id });
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[A/B Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      user = await User.create({
        name: 'AB One',
        email: `${prefix}@example.com`,
        passwordHash: await hashPassword('StrongPassword123!'),
      });
      token = signAccessToken(user);
      contacts = await Contact.insertMany(
        Array.from({ length: 4 }, (_, i) => ({
          userId: user._id,
          name: `Person ${i}`,
          email: `${prefix}-p${i}@example.com`,
        }))
      );
    }
  });

  beforeEach(async () => {
    useTransport();
    if (isDbConnected) await cleanup();
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await cleanup();
      await Contact.deleteMany({ userId: user._id });
      await User.deleteMany({ _id: user._id });
      await mongoose.disconnect();
    }
  });

  it('creates, updates, clears and duplicates a campaign with subjectB', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    let res = await request('POST', '/api/v1/campaigns', { name: 'AB created', subject: 'A', subjectB: 'B' });
    assert.equal(res.status, 201);
    const created = (await res.json()).data.campaign;
    assert.equal(created.subjectB, 'B');

    res = await request('PATCH', `/api/v1/campaigns/${created.id}`, { subjectB: 'B2' });
    assert.equal((await res.json()).data.campaign.subjectB, 'B2');

    res = await request('POST', `/api/v1/campaigns/${created.id}/duplicate`);
    assert.equal((await res.json()).data.campaign.subjectB, 'B2');

    res = await request('PATCH', `/api/v1/campaigns/${created.id}`, { subjectB: '' });
    assert.equal((await res.json()).data.campaign.subjectB, '');
  });

  it('sends each arm its own subject and splits evenly', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await makeCampaign();
    const res = await request('POST', `/api/v1/campaigns/${c._id}/send`, { confirm: true });
    assert.equal(res.status, 202);
    await waitForCampaignDispatch(c._id);

    const deliveries = await Delivery.find({ campaignId: c._id }).lean();
    assert.equal(deliveries.filter((d) => d.variant === 'A').length, 2);
    assert.equal(deliveries.filter((d) => d.variant === 'B').length, 2);

    const variantByEmail = new Map(deliveries.map((d) => [d.email, d.variant]));
    assert.equal(transport.count, 4);
    for (const mail of transport.sentEmails) {
      const expected = variantByEmail.get(mail.to) === 'B' ? 'Subject B' : 'Subject A';
      assert.equal(mail.subject, expected);
    }
  });

  it('sends everyone subject A when no variant B is set', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await makeCampaign({ subjectB: '' });
    await request('POST', `/api/v1/campaigns/${c._id}/send`, { confirm: true });
    await waitForCampaignDispatch(c._id);

    assert.equal(await Delivery.countDocuments({ campaignId: c._id, variant: 'B' }), 0);
    assert.ok(transport.sentEmails.every((m) => m.subject === 'Subject A'));
  });

  it('reports per-arm results and names the leader by open rate', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await makeCampaign({ status: 'sent' });
    const rows = [
      { contact: contacts[0], variant: 'A' },
      { contact: contacts[1], variant: 'A' },
      { contact: contacts[2], variant: 'B' },
      { contact: contacts[3], variant: 'B' },
    ];
    await Delivery.insertMany(
      rows.map(({ contact, variant }) => ({
        campaignId: c._id,
        userId: user._id,
        contactId: contact._id,
        email: contact.email,
        variant,
        status: 'sent',
      }))
    );
    const open = (contact) =>
      TrackingEvent.create({
        campaignId: c._id,
        userId: user._id,
        recipientId: contact._id,
        recipientEmail: contact.email,
        eventType: 'open',
      });
    await open(contacts[2]);
    await open(contacts[3]);
    await open(contacts[3]); // repeat opens count once
    await open(contacts[0]);

    const stats = await getCampaignVariantStats(c);
    const [a, b] = stats.arms;
    assert.deepEqual([a.sent, a.uniqueOpens, a.openRate], [2, 1, 50]);
    assert.deepEqual([b.sent, b.uniqueOpens, b.openRate], [2, 2, 100]);
    assert.equal(stats.leader, 'B');

    const res = await request('GET', `/api/v1/campaigns/${c._id}/analytics`);
    assert.equal((await res.json()).data.analytics.variants.leader, 'B');
  });

  it('has no variants block for a plain campaign and no leader on a tie', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const plain = await makeCampaign({ subjectB: '' });
    assert.equal(await getCampaignVariantStats(plain), null);

    const tie = await makeCampaign({ status: 'sent' });
    await Delivery.insertMany([
      { campaignId: tie._id, userId: user._id, contactId: contacts[0]._id, email: contacts[0].email, variant: 'A', status: 'sent' },
      { campaignId: tie._id, userId: user._id, contactId: contacts[1]._id, email: contacts[1].email, variant: 'B', status: 'sent' },
    ]);
    assert.equal((await getCampaignVariantStats(tie)).leader, null);
  });
});
