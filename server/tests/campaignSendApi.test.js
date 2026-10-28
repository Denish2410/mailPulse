import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

// Ensure deterministic test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';
// Route limiter reads env lazily; raise it for the integration suite
process.env.CAMPAIGN_SEND_RATE_LIMIT_MAX = '1000';
// Guarantee no SMTP configuration can be picked up from a developer's local .env
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
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import {
  createEmailService,
  createMockTransport,
  InvalidMessageError,
  EmailConfigurationError,
  EmailTransportError,
} from '../src/services/email.service.js';
import {
  waitForCampaignDispatch,
  resumeInterruptedDispatches,
  reapStalledCampaigns,
  getWatchdogConfig,
  getSendConcurrency,
  toDeliveryErrorCode,
  DEFAULT_SEND_CONCURRENCY,
  MAX_SEND_CONCURRENCY,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_WATCHDOG_INTERVAL_MS,
} from '../src/services/campaignDispatch.service.js';
import { MAX_CAMPAIGN_RECIPIENTS } from '../src/models/Campaign.js';
import {
  getCampaignSendRateLimitConfig,
  DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_MAX,
  DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_WINDOW_MS,
} from '../src/middleware/campaignSendRateLimiter.js';
import {
  sendCampaignSchema,
  getCampaignDeliveriesSchema,
  createCampaignSchema,
  updateCampaignSchema,
} from '../src/validators/campaign.validator.js';

/**
 * Mock transport that fails for selected addresses and records everything else.
 */
const createSelectiveTransport = (failingAddresses = []) => {
  const inner = createMockTransport();
  const failing = new Set(failingAddresses.map((a) => a.toLowerCase()));
  return {
    get count() {
      return inner.count;
    },
    get sentEmails() {
      return inner.sentEmails;
    },
    async sendMail(mailOptions) {
      if (failing.has(String(mailOptions.to).toLowerCase())) {
        throw new Error('Simulated SMTP 550 mailbox unavailable');
      }
      return inner.sendMail(mailOptions);
    },
  };
};

describe('Campaign Send API (POST /api/v1/campaigns/:id/send)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const testPrefix = `sendapi-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  let userOne;
  let tokenOne;
  let userTwo;
  let tokenTwo;
  let suspendedUser;
  let tokenSuspended;
  let contactA;
  let contactB;
  let foreignContact;

  let transport;

  const useTransport = (t) => {
    transport = t;
    app.locals.emailService = createEmailService({
      transport: t,
      from: 'MailPulse Test <no-reply@mailpulse.test>',
    });
  };

  const request = (method, urlPath, { token, body } = {}) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const postSend = (campaignId, { token, body = { confirm: true } } = {}) =>
    request('POST', `/api/v1/campaigns/${campaignId}/send`, { token, body });

  const createCampaignFor = (user, overrides = {}) =>
    Campaign.create({
      userId: user._id,
      name: 'Launch Campaign',
      subject: 'Big Launch',
      textContent: 'Hello from MailPulse',
      htmlContent: '<p>Hello from <strong>MailPulse</strong></p>',
      status: 'draft',
      recipientIds: [],
      ...overrides,
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init();
      await Contact.init();
      await Campaign.init();
      await Delivery.init();
    } catch (err) {
      console.warn(`[Campaign Send API Tests] MongoDB unavailable: ${err.message}`);
      isDbConnected = false;
    }

    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');

      userOne = await User.create({
        name: 'Sender One',
        email: `${testPrefix}-one@example.com`,
        passwordHash,
      });
      tokenOne = signAccessToken(userOne);

      userTwo = await User.create({
        name: 'Other Tenant',
        email: `${testPrefix}-two@example.com`,
        passwordHash,
      });
      tokenTwo = signAccessToken(userTwo);

      suspendedUser = await User.create({
        name: 'Suspended Sender',
        email: `${testPrefix}-suspended@example.com`,
        passwordHash,
        status: 'suspended',
      });
      tokenSuspended = signAccessToken(suspendedUser);

      contactA = await Contact.create({
        userId: userOne._id,
        name: 'Alice Recipient',
        email: `${testPrefix}-alice@example.com`,
      });
      contactB = await Contact.create({
        userId: userOne._id,
        name: 'Bob Recipient',
        email: `${testPrefix}-bob@example.com`,
      });
      foreignContact = await Contact.create({
        userId: userTwo._id,
        name: 'Foreign Contact',
        email: `${testPrefix}-foreign@example.com`,
      });
    }
  });

  beforeEach(async () => {
    useTransport(createMockTransport());

    if (isDbConnected) {
      const ids = [userOne._id, userTwo._id, suspendedUser._id];
      await Delivery.deleteMany({ userId: { $in: ids } });
      await Campaign.deleteMany({ userId: { $in: ids } });
    }
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (isDbConnected) {
      const ids = [userOne._id, userTwo._id, suspendedUser._id];
      await Delivery.deleteMany({ userId: { $in: ids } });
      await Campaign.deleteMany({ userId: { $in: ids } });
      await Contact.deleteMany({ userId: { $in: ids } });
      await User.deleteMany({ _id: { $in: ids } });
      await mongoose.disconnect();
    }
  });

  describe('1. Authentication, validation and ownership', () => {
    it('Returns 401 without a token and sends nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      const res = await postSend(campaign._id);
      assert.equal(res.status, 401);
      assert.equal(transport.count, 0);
    });

    it('Returns 400 when confirm is missing or not true', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
        const res = await postSend(campaign._id, { token: tokenOne, body });
        assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be rejected`);
      }

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'draft');
      assert.equal(transport.count, 0);
    });

    it('Rejects attempts to supply recipients or content with 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      for (const extra of [
        { recipientIds: [foreignContact._id.toString()] },
        { to: 'attacker@example.com' },
        { subject: 'Injected' },
      ]) {
        const res = await postSend(campaign._id, {
          token: tokenOne,
          body: { confirm: true, ...extra },
        });
        assert.equal(res.status, 400);
      }
      assert.equal(transport.count, 0);
    });

    it("Returns 404 for another user's campaign and sends nothing", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      const res = await postSend(campaign._id, { token: tokenTwo });
      assert.equal(res.status, 404);
      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'draft');
      assert.equal(transport.count, 0);
    });

    it('Returns 403 for a suspended account', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contact = await Contact.create({
        userId: suspendedUser._id,
        name: 'Suspended Contact',
        email: `${testPrefix}-sc@example.com`,
      });
      const campaign = await createCampaignFor(suspendedUser, { recipientIds: [contact._id] });

      const res = await postSend(campaign._id, { token: tokenSuspended });
      assert.equal(res.status, 403);
      assert.equal(transport.count, 0);
    });
  });

  describe('2. Fail-closed preconditions', () => {
    it('Returns 422 with issues when the campaign has no eligible recipients', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [] });

      const res = await postSend(campaign._id, { token: tokenOne });
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.ok(Array.isArray(data.errors));
      assert.ok(data.errors.some((e) => /eligible recipient/i.test(e.message)));

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'draft');
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
    });

    it('Returns 422 when the campaign has no content', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id],
        textContent: '   ',
        htmlContent: '',
      });

      const res = await postSend(campaign._id, { token: tokenOne });
      assert.equal(res.status, 422);
      assert.equal(transport.count, 0);
    });

    it('Returns 503 and leaves the draft untouched when email is not configured', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      // No injected transport + NODE_ENV=test => assertConfigured() throws
      app.locals.emailService = createEmailService();
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      const res = await postSend(campaign._id, { token: tokenOne });
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.message, 'Email sending is not configured.');

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'draft');
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
    });
  });

  describe('3. Successful dispatch', () => {
    it('Sends exactly one email per eligible recipient and marks the campaign sent', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const deletedContactId = new mongoose.Types.ObjectId();
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id, deletedContactId],
      });

      const res = await postSend(campaign._id, { token: tokenOne });
      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.queuedRecipients, 2);
      assert.equal(data.data.campaign.status, 'sending');
      assert.equal(data.data.campaign.stats.total, 2);

      await waitForCampaignDispatch(campaign._id);

      assert.equal(transport.count, 2);
      const destinations = transport.sentEmails.map((m) => m.to).sort();
      assert.deepEqual(destinations, [contactA.email, contactB.email].sort());
      for (const mail of transport.sentEmails) {
        assert.equal(mail.subject, 'Big Launch');
        assert.equal(mail.text, 'Hello from MailPulse');
      }

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'sent');
      assert.ok(stored.sendStartedAt);
      assert.ok(stored.sendCompletedAt);
      assert.deepEqual(
        { total: stored.stats.total, sent: stored.stats.sent, failed: stored.stats.failed },
        { total: 2, sent: 2, failed: 0 }
      );

      const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
      assert.equal(deliveries.length, 2);
      for (const d of deliveries) {
        assert.equal(d.status, 'sent');
        assert.equal(d.attempts, 1);
        assert.ok(d.messageId);
        assert.ok(d.sentAt);
      }
    });

    it('Returns 409 for a second send and never sends twice', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      assert.equal((await postSend(campaign._id, { token: tokenOne })).status, 202);
      await waitForCampaignDispatch(campaign._id);

      const again = await postSend(campaign._id, { token: tokenOne });
      assert.equal(again.status, 409);
      assert.equal(transport.count, 1);
    });

    it('Concurrent send requests dispatch the campaign only once', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id],
      });

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => postSend(campaign._id, { token: tokenOne }))
      );
      const statuses = responses.map((r) => r.status).sort();
      assert.equal(statuses.filter((s) => s === 202).length, 1);
      assert.ok(statuses.filter((s) => s !== 202).every((s) => s === 409));

      await waitForCampaignDispatch(campaign._id);
      assert.equal(transport.count, 2);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 2);
    });

    it('Locks the campaign: edit and delete return 409 after sending', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      await postSend(campaign._id, { token: tokenOne });
      await waitForCampaignDispatch(campaign._id);

      const patch = await request('PATCH', `/api/v1/campaigns/${campaign._id}`, {
        token: tokenOne,
        body: { subject: 'Changed after send' },
      });
      assert.equal(patch.status, 409);

      const del = await request('DELETE', `/api/v1/campaigns/${campaign._id}`, {
        token: tokenOne,
      });
      assert.equal(del.status, 409);

      const testEmail = await request('POST', `/api/v1/campaigns/${campaign._id}/test-email`, {
        token: tokenOne,
        body: {},
      });
      assert.equal(testEmail.status, 422);

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.subject, 'Big Launch');
    });
  });

  describe('4. Delivery failures', () => {
    it('Records per-recipient failures with a sanitized code and still marks the campaign sent', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      useTransport(createSelectiveTransport([contactB.email]));
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id],
      });

      assert.equal((await postSend(campaign._id, { token: tokenOne })).status, 202);
      await waitForCampaignDispatch(campaign._id);

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'sent');
      assert.equal(stored.stats.sent, 1);
      assert.equal(stored.stats.failed, 1);

      const failed = await Delivery.findOne({ campaignId: campaign._id, status: 'failed' }).lean();
      assert.equal(failed.email, contactB.email);
      assert.equal(failed.errorCode, 'TRANSPORT_ERROR');
      assert.ok(!JSON.stringify(failed).includes('550'), 'raw provider error must not be stored');
    });

    it('Marks the campaign failed when no recipient is accepted', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      useTransport(createSelectiveTransport([contactA.email, contactB.email]));
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id],
      });

      await postSend(campaign._id, { token: tokenOne });
      await waitForCampaignDispatch(campaign._id);

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'failed');
      assert.equal(stored.stats.failed, 2);
      assert.equal(stored.stats.sent, 0);
    });
  });

  describe('5. Delivery log (GET /api/v1/campaigns/:id/deliveries)', () => {
    it('Returns a summary, paginated deliveries, and supports status filtering', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      useTransport(createSelectiveTransport([contactB.email]));
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id],
      });
      await postSend(campaign._id, { token: tokenOne });
      await waitForCampaignDispatch(campaign._id);

      const res = await request('GET', `/api/v1/campaigns/${campaign._id}/deliveries`, {
        token: tokenOne,
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.campaignStatus, 'sent');
      assert.equal(data.data.summary.total, 2);
      assert.equal(data.data.summary.sent, 1);
      assert.equal(data.data.summary.failed, 1);
      assert.equal(data.data.deliveries.length, 2);
      assert.equal(data.data.pagination.total, 2);
      for (const d of data.data.deliveries) {
        assert.ok(!('messageId' in d), 'internal message IDs are not exposed');
        assert.ok(!('userId' in d));
      }

      const filtered = await request(
        'GET',
        `/api/v1/campaigns/${campaign._id}/deliveries?status=failed`,
        { token: tokenOne }
      );
      const filteredData = await filtered.json();
      assert.equal(filteredData.data.deliveries.length, 1);
      assert.equal(filteredData.data.deliveries[0].errorCode, 'TRANSPORT_ERROR');
    });

    it("Returns 404 for another user's campaign and 400 for an invalid status", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      const foreign = await request('GET', `/api/v1/campaigns/${campaign._id}/deliveries`, {
        token: tokenTwo,
      });
      assert.equal(foreign.status, 404);

      const invalid = await request(
        'GET',
        `/api/v1/campaigns/${campaign._id}/deliveries?status=bounced`,
        { token: tokenOne }
      );
      assert.equal(invalid.status, 400);
    });

    it('Returns an empty log for a draft', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactA._id] });

      const res = await request('GET', `/api/v1/campaigns/${campaign._id}/deliveries`, {
        token: tokenOne,
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.data.campaignStatus, 'draft');
      assert.equal(data.data.summary.total, 0);
      assert.deepEqual(data.data.deliveries, []);
    });
  });

  describe('6. Resuming interrupted dispatches', () => {
    it('Fails in-flight deliveries as INTERRUPTED, sends pending ones, and finalizes', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id],
        status: 'sending',
        sendStartedAt: new Date(),
        stats: { total: 2, sent: 0, failed: 0 },
      });
      await Delivery.create([
        {
          campaignId: campaign._id,
          userId: userOne._id,
          contactId: contactA._id,
          email: contactA.email,
          name: contactA.name,
          status: 'processing',
          attempts: 1,
        },
        {
          campaignId: campaign._id,
          userId: userOne._id,
          contactId: contactB._id,
          email: contactB.email,
          name: contactB.name,
          status: 'pending',
        },
      ]);

      const resumed = await resumeInterruptedDispatches({
        emailService: app.locals.emailService,
        logger: { log: () => {}, error: () => {} },
      });
      assert.ok(resumed >= 1);
      await waitForCampaignDispatch(campaign._id);

      // Only the pending recipient is sent; the in-flight one is never re-sent
      assert.equal(transport.count, 1);
      assert.equal(transport.sentEmails[0].to, contactB.email);

      const interrupted = await Delivery.findOne({
        campaignId: campaign._id,
        contactId: contactA._id,
      }).lean();
      assert.equal(interrupted.status, 'failed');
      assert.equal(interrupted.errorCode, 'INTERRUPTED');

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'sent');
      assert.equal(stored.stats.sent, 1);
      assert.equal(stored.stats.failed, 1);
    });
  });

  describe('7. Recipient cap', () => {
    it(`Rejects creating a campaign with more than ${MAX_CAMPAIGN_RECIPIENTS} recipient IDs`, async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const recipientIds = Array.from({ length: MAX_CAMPAIGN_RECIPIENTS + 1 }, () =>
        new mongoose.Types.ObjectId().toString()
      );

      const res = await request('POST', '/api/v1/campaigns', {
        token: tokenOne,
        body: { name: 'Too big', subject: 'Hi', textContent: 'Hello', recipientIds },
      });
      assert.equal(res.status, 400);
      assert.equal(await Campaign.countDocuments({ userId: userOne._id }), 0);
    });

    it('Refuses to send a legacy draft that resolves to more recipients than the cap', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const emailPrefix = `${testPrefix}-bulk`;
      const contacts = await Contact.insertMany(
        Array.from({ length: MAX_CAMPAIGN_RECIPIENTS + 1 }, (_, i) => ({
          userId: userOne._id,
          name: `Bulk ${i}`,
          email: `${emailPrefix}-${i}@example.com`,
        }))
      );

      try {
        // Written directly to the collection, as a draft saved before the cap existed would be
        const now = new Date();
        const { insertedId } = await Campaign.collection.insertOne({
          userId: userOne._id,
          name: 'Legacy oversized draft',
          subject: 'Hello',
          textContent: 'Hello everyone',
          htmlContent: '',
          status: 'draft',
          recipientIds: contacts.map((c) => c._id),
          stats: { total: 0, sent: 0, failed: 0 },
          createdAt: now,
          updatedAt: now,
        });

        const res = await postSend(insertedId, { token: tokenOne });
        assert.equal(res.status, 422);
        const body = await res.json();
        assert.ok(body.errors.some((e) => e.path === 'campaign.recipientIds'));

        const stored = await Campaign.findById(insertedId).lean();
        assert.equal(stored.status, 'draft', 'nothing was locked');
        assert.equal(await Delivery.countDocuments({ campaignId: insertedId }), 0);
        assert.equal(transport.count, 0);
      } finally {
        await Contact.deleteMany({ userId: userOne._id, email: { $regex: `^${emailPrefix}-` } });
      }
    });
  });

  describe('8. Database failures after the transport accepted a message', () => {
    it('Records PERSIST_ERROR (never TRANSPORT_ERROR), keeps the messageId, and never re-sends', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id],
      });

      // Every attempt to record ONE chosen delivery as 'sent' fails
      const originalUpdateOne = Delivery.updateOne.bind(Delivery);
      let victimId = null;
      t.mock.method(Delivery, 'updateOne', (filter, update, ...rest) => {
        if (update?.$set?.status === 'sent') {
          victimId = victimId ?? String(filter._id);
          if (String(filter._id) === victimId) {
            return Promise.reject(Object.assign(new Error('write failed'), { name: 'MongoNetworkError' }));
          }
        }
        return originalUpdateOne(filter, update, ...rest);
      });

      const res = await postSend(campaign._id, { token: tokenOne });
      assert.equal(res.status, 202);
      await waitForCampaignDispatch(campaign._id);
      t.mock.restoreAll();

      assert.equal(transport.count, 2, 'each recipient handed to the transport exactly once');

      const victim = await Delivery.findById(victimId).lean();
      assert.equal(victim.status, 'failed');
      assert.equal(victim.errorCode, 'PERSIST_ERROR');
      assert.ok(victim.messageId, 'messageId kept for reconciliation');

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'sent');
      assert.equal(stored.stats.sent, 1);
      assert.equal(stored.stats.failed, 1);
    });

    it('A failed stats increment does not stall the campaign or change delivery records', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id],
      });

      const originalUpdateOne = Campaign.updateOne.bind(Campaign);
      t.mock.method(Campaign, 'updateOne', (filter, update, ...rest) => {
        if (update?.$inc) {
          return Promise.reject(new Error('stats write failed'));
        }
        return originalUpdateOne(filter, update, ...rest);
      });

      const res = await postSend(campaign._id, { token: tokenOne });
      assert.equal(res.status, 202);
      await waitForCampaignDispatch(campaign._id);
      t.mock.restoreAll();

      const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
      assert.ok(deliveries.every((d) => d.status === 'sent'));

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'sent', 'finalized despite the failed increments');
      assert.equal(stored.stats.sent, 2, 'stats recomputed from delivery records');
    });
  });

  describe('9. Stalled-campaign watchdog', () => {
    const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
    const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

    const seedDelivery = (campaign, contact, status) => ({
      campaignId: campaign._id,
      userId: userOne._id,
      contactId: contact._id,
      email: contact.email,
      name: contact.name,
      status,
      attempts: status === 'pending' ? 0 : 1,
    });

    it('Recovers a campaign stalled past the timeout: INTERRUPTED for in-flight, pending sent', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id, contactB._id],
        status: 'sending',
        sendStartedAt: minutesAgo(30),
        stats: { total: 2, sent: 0, failed: 0 },
      });
      await Delivery.create([
        seedDelivery(campaign, contactA, 'processing'),
        seedDelivery(campaign, contactB, 'pending'),
      ]);

      const recovered = await reapStalledCampaigns({
        emailService: app.locals.emailService,
        logger: silentLogger,
        stallTimeoutMs: 15 * 60 * 1000,
      });
      assert.equal(recovered, 1);
      await waitForCampaignDispatch(campaign._id);

      assert.equal(transport.count, 1);
      assert.equal(transport.sentEmails[0].to, contactB.email);
      const interrupted = await Delivery.findOne({ campaignId: campaign._id, contactId: contactA._id }).lean();
      assert.equal(interrupted.errorCode, 'INTERRUPTED');
      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'sent');
    });

    it('Leaves a campaign that started recently alone', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id],
        status: 'sending',
        sendStartedAt: minutesAgo(1),
        stats: { total: 1, sent: 0, failed: 0 },
      });
      await Delivery.create([seedDelivery(campaign, contactA, 'processing')]);

      const recovered = await reapStalledCampaigns({
        emailService: app.locals.emailService,
        logger: silentLogger,
        stallTimeoutMs: 15 * 60 * 1000,
      });
      assert.equal(recovered, 0);
      const delivery = await Delivery.findOne({ campaignId: campaign._id }).lean();
      assert.equal(delivery.status, 'processing', 'not failed while it may still be in flight');
      assert.equal(transport.count, 0);
    });

    it('Overlapping startup recovery and watchdog sweep never fail an in-flight delivery', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id],
        status: 'sending',
        sendStartedAt: minutesAgo(30),
        stats: { total: 1, sent: 0, failed: 0 },
      });
      await Delivery.create([seedDelivery(campaign, contactA, 'pending')]);

      // Hold the transport so the claimed delivery stays 'processing'
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const inner = createMockTransport();
      useTransport({
        get count() {
          return inner.count;
        },
        get sentEmails() {
          return inner.sentEmails;
        },
        async sendMail(mailOptions) {
          await gate;
          return inner.sendMail(mailOptions);
        },
      });

      // Make the SECOND recovery's "fail processing rows" update land late, after the first
      // recovery's worker has already claimed the delivery
      const originalUpdateMany = Delivery.updateMany.bind(Delivery);
      let calls = 0;
      t.mock.method(Delivery, 'updateMany', async (...args) => {
        calls += 1;
        if (calls === 2) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return originalUpdateMany(...args);
      });

      await Promise.all([
        resumeInterruptedDispatches({ emailService: app.locals.emailService, logger: silentLogger }),
        reapStalledCampaigns({
          emailService: app.locals.emailService,
          logger: silentLogger,
          stallTimeoutMs: 15 * 60 * 1000,
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const inFlight = await Delivery.findOne({ campaignId: campaign._id }).lean();
      assert.notEqual(inFlight.errorCode, 'INTERRUPTED', 'in-flight delivery must not be failed');

      release();
      await waitForCampaignDispatch(campaign._id);
      t.mock.restoreAll();

      const done = await Delivery.findOne({ campaignId: campaign._id }).lean();
      assert.equal(done.status, 'sent');
      assert.equal(transport.count, 1);
    });

    it('Returns a stalled campaign that never got deliveries to draft', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        recipientIds: [contactA._id],
        status: 'sending',
        sendStartedAt: minutesAgo(30),
        stats: { total: 1, sent: 0, failed: 0 },
      });

      const recovered = await reapStalledCampaigns({
        emailService: app.locals.emailService,
        logger: silentLogger,
        stallTimeoutMs: 15 * 60 * 1000,
      });
      assert.equal(recovered, 1);

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'draft');
      assert.equal(stored.sendStartedAt, null);
      assert.equal(transport.count, 0);
    });
  });
});

describe('Campaign dispatch helpers (no database)', () => {
  it('getWatchdogConfig applies defaults and rejects invalid values', () => {
    assert.deepEqual(getWatchdogConfig({}), {
      stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
      intervalMs: DEFAULT_WATCHDOG_INTERVAL_MS,
    });
    assert.deepEqual(
      getWatchdogConfig({ CAMPAIGN_STALL_TIMEOUT_MS: '-1', CAMPAIGN_WATCHDOG_INTERVAL_MS: 'soon' }),
      { stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS, intervalMs: DEFAULT_WATCHDOG_INTERVAL_MS }
    );
    assert.deepEqual(
      getWatchdogConfig({ CAMPAIGN_STALL_TIMEOUT_MS: '60000', CAMPAIGN_WATCHDOG_INTERVAL_MS: '1000' }),
      { stallTimeoutMs: 60000, intervalMs: 1000 }
    );
  });

  it('create and update schemas cap recipientIds', () => {
    const ids = (n) => Array.from({ length: n }, () => new mongoose.Types.ObjectId().toString());
    const base = { name: 'Capped', subject: 'Hi' };

    assert.equal(
      createCampaignSchema.safeParse({ body: { ...base, recipientIds: ids(MAX_CAMPAIGN_RECIPIENTS) } }).success,
      true
    );
    assert.equal(
      createCampaignSchema.safeParse({ body: { ...base, recipientIds: ids(MAX_CAMPAIGN_RECIPIENTS + 1) } }).success,
      false
    );

    const id = new mongoose.Types.ObjectId().toString();
    assert.equal(
      updateCampaignSchema.safeParse({ params: { id }, body: { recipientIds: ids(MAX_CAMPAIGN_RECIPIENTS + 1) } }).success,
      false
    );
  });

  it('Campaign schema rejects saving more recipients than the cap', () => {
    const doc = new Campaign({
      userId: new mongoose.Types.ObjectId(),
      name: 'Capped',
      subject: 'Hi',
      recipientIds: Array.from({ length: MAX_CAMPAIGN_RECIPIENTS + 1 }, () => new mongoose.Types.ObjectId()),
    });
    const error = doc.validateSync();
    assert.ok(error?.errors?.recipientIds, 'recipientIds validation error expected');
  });

  it('toDeliveryErrorCode never produces PERSIST_ERROR (it is only set after transport acceptance)', () => {
    assert.notEqual(toDeliveryErrorCode(new Error('E11000')), 'PERSIST_ERROR');
  });
  it('getSendConcurrency applies defaults and bounds', () => {
    assert.equal(getSendConcurrency({}), DEFAULT_SEND_CONCURRENCY);
    assert.equal(getSendConcurrency({ CAMPAIGN_SEND_CONCURRENCY: '3' }), 3);
    assert.equal(getSendConcurrency({ CAMPAIGN_SEND_CONCURRENCY: '0' }), DEFAULT_SEND_CONCURRENCY);
    assert.equal(getSendConcurrency({ CAMPAIGN_SEND_CONCURRENCY: 'abc' }), DEFAULT_SEND_CONCURRENCY);
    assert.equal(getSendConcurrency({ CAMPAIGN_SEND_CONCURRENCY: '999' }), MAX_SEND_CONCURRENCY);
  });

  it('toDeliveryErrorCode maps email errors to sanitized codes', () => {
    assert.equal(toDeliveryErrorCode(new InvalidMessageError('x')), 'INVALID_MESSAGE');
    assert.equal(toDeliveryErrorCode(new EmailConfigurationError('x')), 'CONFIGURATION_ERROR');
    assert.equal(toDeliveryErrorCode(new EmailTransportError()), 'TRANSPORT_ERROR');
    assert.equal(toDeliveryErrorCode(new Error('socket hang up')), 'UNKNOWN_ERROR');
  });

  it('Campaign send rate limit config falls back to defaults on invalid values', () => {
    assert.deepEqual(getCampaignSendRateLimitConfig({}), {
      windowMs: DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_WINDOW_MS,
      max: DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_MAX,
    });
    assert.deepEqual(
      getCampaignSendRateLimitConfig({
        CAMPAIGN_SEND_RATE_LIMIT_WINDOW_MS: '60000',
        CAMPAIGN_SEND_RATE_LIMIT_MAX: '-4',
      }),
      { windowMs: 60000, max: DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_MAX }
    );
  });

  it('sendCampaignSchema requires confirm: true and rejects extra keys', () => {
    const id = new mongoose.Types.ObjectId().toString();
    assert.equal(
      sendCampaignSchema.safeParse({ params: { id }, body: { confirm: true } }).success,
      true
    );
    assert.equal(sendCampaignSchema.safeParse({ params: { id }, body: {} }).success, false);
    assert.equal(
      sendCampaignSchema.safeParse({ params: { id }, body: { confirm: true, cc: 'a@b.co' } })
        .success,
      false
    );
  });

  it('getCampaignDeliveriesSchema coerces pagination and bounds limit', () => {
    const id = new mongoose.Types.ObjectId().toString();
    const ok = getCampaignDeliveriesSchema.safeParse({
      params: { id },
      query: { page: '2', limit: '50', status: 'sent' },
    });
    assert.equal(ok.success, true);
    assert.equal(ok.data.query.page, 2);
    assert.equal(ok.data.query.limit, 50);

    const defaults = getCampaignDeliveriesSchema.safeParse({ params: { id }, query: {} });
    assert.equal(defaults.data.query.page, 1);
    assert.equal(defaults.data.query.limit, 20);

    assert.equal(
      getCampaignDeliveriesSchema.safeParse({ params: { id }, query: { limit: '101' } }).success,
      false
    );
  });
});
