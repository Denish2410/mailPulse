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

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { waitForCampaignDispatch } from '../src/services/campaignDispatch.service.js';
import { buildDispatchManifest } from '../src/utils/dispatchManifest.js';
import { runQueuedSend } from './helpers/queuedSend.js';

/**
 * Send and schedule requests must be refused (422) when the eligible recipients could not be stored
 * as a dispatch manifest. The real limits cannot be reached through the API with valid data (the
 * largest legal manifest fits them by design), so these tests LOWER the limits through
 * `app.locals.dispatchManifestLimits`; the builder never lets a caller raise one.
 */
describe('Dispatch manifest limits on send and schedule requests', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const testPrefix = `manifestlimits-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  let owner;
  let ownerToken;
  let otherTenant;
  let otherToken;
  let contacts;
  let foreignContact;
  let transport;

  const request = (method, urlPath, { token, body } = {}) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const postSend = (campaignId, token = ownerToken) =>
    request('POST', `/api/v1/campaigns/${campaignId}/send`, { token, body: { confirm: true } });

  const postSchedule = (campaignId, token = ownerToken) =>
    request('POST', `/api/v1/campaigns/${campaignId}/schedule`, {
      token,
      body: { scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    });

  const createCampaign = (overrides = {}) =>
    Campaign.create({
      userId: owner._id,
      name: 'Manifest Limits Campaign',
      subject: 'Hello',
      textContent: 'Hello from MailPulse',
      htmlContent: '<p>Hello from MailPulse</p>',
      status: 'draft',
      recipientIds: contacts.map((c) => c._id),
      ...overrides,
    });

  const setLimits = (limits) => {
    app.locals.dispatchManifestLimits = limits;
  };

  const manifestBytes = () => buildDispatchManifest(contacts).bytes;

  /** A refused request changes nothing: still a draft, no deliveries, nothing sent. */
  const assertUntouched = async (campaignId) => {
    const stored = await Campaign.findById(campaignId).lean();
    assert.equal(stored.status, 'draft');
    assert.equal(stored.scheduledAt ?? null, null);
    assert.equal(await Delivery.countDocuments({ campaignId }), 0);
    assert.equal(transport.count, 0);
  };

  /** The response must not contain any recipient name, address or contact id. */
  const assertNoRecipientData = (bodyText) => {
    for (const person of [...contacts, foreignContact]) {
      assert.ok(!bodyText.includes(person.email), 'response contains a recipient address');
      assert.ok(!bodyText.includes(person.name), 'response contains a recipient name');
      assert.ok(!bodyText.includes(String(person._id)), 'response contains a contact id');
    }
  };

  const assertManifestRefusal = async (res, messagePattern) => {
    assert.equal(res.status, 422);
    const text = await res.text();
    assertNoRecipientData(text);
    const data = JSON.parse(text);
    assert.equal(data.success, false);
    assert.ok(Array.isArray(data.errors));
    const issue = data.errors.find((e) => e.path === 'campaign.recipientIds');
    assert.ok(issue, 'expected an issue on campaign.recipientIds');
    assert.match(issue.message, messagePattern);
    return data;
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init();
      await Contact.init();
      await Campaign.init();
      await Delivery.init();
    } catch (err) {
      console.warn(`[Manifest Limits Tests] MongoDB unavailable: ${err.message}`);
      isDbConnected = false;
    }

    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      owner = await User.create({ name: 'Manifest Owner', email: `${testPrefix}-owner@example.com`, passwordHash });
      ownerToken = signAccessToken(owner);
      otherTenant = await User.create({ name: 'Other Tenant', email: `${testPrefix}-other@example.com`, passwordHash });
      otherToken = signAccessToken(otherTenant);

      contacts = await Contact.insertMany(
        ['Aurelia Quillfeather', 'Bartholomew Zinnwald', 'Cassiopeia Vandermolen'].map((name, i) => ({
          userId: owner._id,
          name,
          email: `${testPrefix}-recipient-${i}@example.com`,
        }))
      );
      foreignContact = await Contact.create({
        userId: otherTenant._id,
        name: 'Foreign Xylophonist',
        email: `${testPrefix}-foreign@example.com`,
      });
    }
  });

  beforeEach(() => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({
      transport,
      from: 'MailPulse Test <no-reply@mailpulse.test>',
    });
  });

  afterEach(async () => {
    delete app.locals.dispatchManifestLimits;
    if (isDbConnected) {
      const ids = [owner._id, otherTenant._id];
      const campaigns = await Campaign.find({ userId: { $in: ids } }).select('_id').lean();
      await Promise.all(campaigns.map((c) => waitForCampaignDispatch(c._id)));
      await Delivery.deleteMany({ userId: { $in: ids } });
      await Campaign.deleteMany({ userId: { $in: ids } });
    }
  });

  after(async () => {
    delete app.locals.emailService;
    delete app.locals.dispatchManifestLimits;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (isDbConnected) {
      const ids = [owner._id, otherTenant._id];
      await Delivery.deleteMany({ userId: { $in: ids } });
      await Campaign.deleteMany({ userId: { $in: ids } });
      await Contact.deleteMany({ userId: { $in: ids } });
      await User.deleteMany({ _id: { $in: ids } });
      await mongoose.disconnect();
    }
  });

  describe('POST /api/v1/campaigns/:id/send', () => {
    it('still accepts and dispatches a campaign within the limits (behaviour unchanged)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaign();

      const res = await postSend(campaign._id);
      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.data.queuedRecipients, contacts.length);

      await runQueuedSend(campaign._id);
      assert.equal(transport.count, contacts.length);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, status: 'sent' }), contacts.length);
      assert.equal((await Campaign.findById(campaign._id).lean()).status, 'sent');
    });

    it('returns 422 when the recipient count exceeds the manifest recipient limit', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      setLimits({ maxRecipients: contacts.length - 1 });
      const campaign = await createCampaign();

      const res = await postSend(campaign._id);
      const data = await assertManifestRefusal(res, /too many recipients/i);
      assert.equal(data.message, 'Campaign is not ready for sending.');
      await assertUntouched(campaign._id);
    });

    it('returns 422 when the measured manifest size is one byte over the limit, and accepts it at the limit', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const bytes = manifestBytes();

      setLimits({ maxManifestBytes: bytes - 1 });
      const refused = await createCampaign();
      await assertManifestRefusal(await postSend(refused._id), /recipient list is too large/i);
      await assertUntouched(refused._id);

      setLimits({ maxManifestBytes: bytes });
      const accepted = await createCampaign({ name: 'Exactly At The Limit' });
      assert.equal((await postSend(accepted._id)).status, 202);
      await runQueuedSend(accepted._id);
      assert.equal(transport.count, contacts.length);
    });

    it('returns 422 when the campaign document plus its manifest exceeds the document limit', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      setLimits({ maxDocumentBytes: manifestBytes() + 1 });
      const campaign = await createCampaign();

      await assertManifestRefusal(await postSend(campaign._id), /content and recipient list are too large/i);
      await assertUntouched(campaign._id);
    });

    it('does not let another tenant learn anything about the campaign or its limits', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      setLimits({ maxRecipients: 1 });
      const campaign = await createCampaign();

      const res = await postSend(campaign._id, otherToken);
      assert.equal(res.status, 404);
      assertNoRecipientData(await res.text());
      await assertUntouched(campaign._id);
    });

    it("never counts, reveals or sends to another tenant's contact listed on the campaign", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      // The owner's three contacts fit a limit of three; the foreign contact must not count
      // toward it, appear in any response, or receive anything.
      setLimits({ maxRecipients: contacts.length });
      const campaign = await createCampaign({
        recipientIds: [...contacts.map((c) => c._id), foreignContact._id],
      });

      const res = await postSend(campaign._id);
      const text = await res.text();
      assert.ok(!text.includes(foreignContact.email));
      assert.ok(!text.includes(foreignContact.name));
      assert.ok(!/too many recipients/i.test(text), 'a foreign contact was counted toward the limit');

      await runQueuedSend(campaign._id);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, contactId: foreignContact._id }), 0);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, email: foreignContact.email }), 0);
      assert.ok(transport.sentEmails.every((mail) => mail.to !== foreignContact.email));
    });
  });

  describe('POST /api/v1/campaigns/:id/schedule', () => {
    it('still schedules a campaign within the limits (behaviour unchanged)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaign();

      const res = await postSchedule(campaign._id);
      assert.equal(res.status, 200);
      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'scheduled');
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
      assert.equal(transport.count, 0);
    });

    it('returns 422 when the recipient count exceeds the manifest recipient limit', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      setLimits({ maxRecipients: contacts.length - 1 });
      const campaign = await createCampaign();

      const res = await postSchedule(campaign._id);
      const data = await assertManifestRefusal(res, /too many recipients/i);
      assert.equal(data.message, 'Campaign is not ready for scheduling.');
      await assertUntouched(campaign._id);
    });

    it('returns 422 when the measured manifest size is one byte over the limit, and accepts it at the limit', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const bytes = manifestBytes();

      setLimits({ maxManifestBytes: bytes - 1 });
      const refused = await createCampaign();
      await assertManifestRefusal(await postSchedule(refused._id), /recipient list is too large/i);
      await assertUntouched(refused._id);

      setLimits({ maxManifestBytes: bytes });
      const accepted = await createCampaign({ name: 'Exactly At The Limit' });
      assert.equal((await postSchedule(accepted._id)).status, 200);
      assert.equal((await Campaign.findById(accepted._id).lean()).status, 'scheduled');
    });

    it('returns 422 when the campaign document plus its manifest exceeds the document limit', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      setLimits({ maxDocumentBytes: manifestBytes() + 1 });
      const campaign = await createCampaign();

      await assertManifestRefusal(await postSchedule(campaign._id), /content and recipient list are too large/i);
      await assertUntouched(campaign._id);
    });

    it('does not let another tenant learn anything about the campaign or its limits', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      setLimits({ maxRecipients: 1 });
      const campaign = await createCampaign();

      const res = await postSchedule(campaign._id, otherToken);
      assert.equal(res.status, 404);
      assertNoRecipientData(await res.text());
      await assertUntouched(campaign._id);
    });
  });
});
