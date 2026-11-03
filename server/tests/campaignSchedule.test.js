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
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { waitForCampaignDispatch } from '../src/services/campaignDispatch.service.js';
import {
  pollScheduledCampaigns,
  getSchedulerIntervalMs,
  startCampaignScheduler,
  stopCampaignScheduler,
  isCampaignSchedulerRunning,
  DEFAULT_SCHEDULER_INTERVAL_MS,
} from '../src/services/campaignScheduler.service.js';
import { scheduleCampaignSchema } from '../src/validators/campaign.validator.js';

const quietLogger = { log() {}, warn() {}, error() {} };
const inFuture = (ms = 3600_000) => new Date(Date.now() + ms).toISOString();

describe('Scheduler config and validation (no DB)', () => {
  it('resolves the poll interval with a safe default', () => {
    assert.equal(getSchedulerIntervalMs({}), DEFAULT_SCHEDULER_INTERVAL_MS);
    assert.equal(getSchedulerIntervalMs({ CAMPAIGN_SCHEDULER_INTERVAL_MS: 'abc' }), DEFAULT_SCHEDULER_INTERVAL_MS);
    assert.equal(getSchedulerIntervalMs({ CAMPAIGN_SCHEDULER_INTERVAL_MS: '10' }), DEFAULT_SCHEDULER_INTERVAL_MS);
    assert.equal(getSchedulerIntervalMs({ CAMPAIGN_SCHEDULER_INTERVAL_MS: '5000' }), 5000);
  });

  it('schedule schema rejects past, malformed and missing dates', () => {
    const id = new mongoose.Types.ObjectId().toString();
    const parse = (body) => scheduleCampaignSchema.safeParse({ params: { id }, body });
    assert.equal(parse({ scheduledAt: inFuture() }).success, true);
    assert.equal(parse({ scheduledAt: new Date(Date.now() - 1000).toISOString() }).success, false);
    assert.equal(parse({ scheduledAt: 'not-a-date' }).success, false);
    assert.equal(parse({}).success, false);
    assert.equal(parse({ scheduledAt: inFuture(), extra: 1 }).success, false);
  });

  it('scheduler start/stop is idempotent', async () => {
    startCampaignScheduler({ emailService: {}, intervalMs: 60000, logger: quietLogger });
    startCampaignScheduler({ emailService: {}, intervalMs: 60000, logger: quietLogger });
    assert.equal(isCampaignSchedulerRunning(), true);
    await stopCampaignScheduler();
    assert.equal(isCampaignSchedulerRunning(), false);
    await stopCampaignScheduler();
  });
});

describe('Scheduled campaigns API and worker', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `sched-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let user;
  let token;
  let otherUser;
  let suspended;
  let contact;
  let transport;

  const useTransport = () => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({
      transport,
      from: 'MailPulse Test <no-reply@mailpulse.test>',
    });
    return app.locals.emailService;
  };

  const request = (method, urlPath, { tok = token, body } = {}) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(tok && { Authorization: `Bearer ${tok}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const makeCampaign = (overrides = {}) =>
    Campaign.create({
      userId: user._id,
      name: 'Scheduled Campaign',
      subject: 'Hello',
      textContent: 'Body text',
      htmlContent: '<p>Body</p>',
      status: 'draft',
      recipientIds: [contact._id],
      ...overrides,
    });

  const cleanup = async () => {
    const ids = [user._id, otherUser._id, suspended._id];
    await Delivery.deleteMany({ userId: { $in: ids } });
    await Campaign.deleteMany({ userId: { $in: ids } });
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Campaign Schedule Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      user = await User.create({ name: 'Sched One', email: `${prefix}-one@example.com`, passwordHash });
      otherUser = await User.create({ name: 'Sched Two', email: `${prefix}-two@example.com`, passwordHash });
      suspended = await User.create({
        name: 'Sched Suspended',
        email: `${prefix}-sus@example.com`,
        passwordHash,
      });
      token = signAccessToken(user);
      contact = await Contact.create({
        userId: user._id,
        name: 'Alice',
        email: `${prefix}-alice@example.com`,
      });
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
      await User.deleteMany({ _id: { $in: [user._id, otherUser._id, suspended._id] } });
      await mongoose.disconnect();
    }
  });

  describe('state machine', () => {
    it('draft -> scheduled -> rescheduled -> draft', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await makeCampaign();

      const first = inFuture(3600_000);
      let res = await request('POST', `/api/v1/campaigns/${c._id}/schedule`, { body: { scheduledAt: first } });
      assert.equal(res.status, 200);
      let json = await res.json();
      assert.equal(json.data.campaign.status, 'scheduled');
      assert.equal(new Date(json.data.campaign.scheduledAt).toISOString(), first);

      const second = inFuture(7200_000);
      res = await request('POST', `/api/v1/campaigns/${c._id}/schedule`, { body: { scheduledAt: second } });
      assert.equal(res.status, 200);
      json = await res.json();
      assert.equal(json.data.campaign.status, 'scheduled');
      assert.equal(new Date(json.data.campaign.scheduledAt).toISOString(), second);

      res = await request('POST', `/api/v1/campaigns/${c._id}/cancel-schedule`);
      assert.equal(res.status, 200);
      json = await res.json();
      assert.equal(json.data.campaign.status, 'draft');
      assert.equal(json.data.campaign.scheduledAt, null);

      res = await request('POST', `/api/v1/campaigns/${c._id}/cancel-schedule`);
      assert.equal(res.status, 409);
      assert.equal(transport.count, 0);
    });

    it('rejects past and malformed dates with 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await makeCampaign();
      for (const scheduledAt of [new Date(Date.now() - 60000).toISOString(), 'garbage']) {
        const res = await request('POST', `/api/v1/campaigns/${c._id}/schedule`, { body: { scheduledAt } });
        assert.equal(res.status, 400);
      }
      assert.equal((await Campaign.findById(c._id)).status, 'draft');
    });

    it('returns 422 when not ready, 503 when SMTP is unconfigured, 404 for foreign campaigns', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const notReady = await makeCampaign({ recipientIds: [] });
      let res = await request('POST', `/api/v1/campaigns/${notReady._id}/schedule`, {
        body: { scheduledAt: inFuture() },
      });
      assert.equal(res.status, 422);

      const ready = await makeCampaign();
      app.locals.emailService = createEmailService({ transport: null });
      res = await request('POST', `/api/v1/campaigns/${ready._id}/schedule`, {
        body: { scheduledAt: inFuture() },
      });
      assert.equal(res.status, 503);
      assert.equal((await Campaign.findById(ready._id)).status, 'draft');

      useTransport();
      res = await request('POST', `/api/v1/campaigns/${ready._id}/schedule`, {
        tok: signAccessToken(otherUser),
        body: { scheduledAt: inFuture() },
      });
      assert.equal(res.status, 404);
    });

    it('refuses to schedule sent campaigns', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await makeCampaign({ status: 'sent' });
      const res = await request('POST', `/api/v1/campaigns/${c._id}/schedule`, {
        body: { scheduledAt: inFuture() },
      });
      assert.equal(res.status, 409);
    });
  });

  describe('locks', () => {
    it('PATCH and DELETE return 409 while scheduled', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await makeCampaign({ status: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000) });

      let res = await request('PATCH', `/api/v1/campaigns/${c._id}`, { body: { name: 'Changed name' } });
      assert.equal(res.status, 409);
      res = await request('DELETE', `/api/v1/campaigns/${c._id}`);
      assert.equal(res.status, 409);

      const stored = await Campaign.findById(c._id);
      assert.equal(stored.name, 'Scheduled Campaign');
      assert.equal(stored.status, 'scheduled');
    });
  });

  describe('background worker', () => {
    it('dispatches due campaigns and leaves future ones untouched', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const due = await makeCampaign({ status: 'scheduled', scheduledAt: new Date(Date.now() - 1000) });
      const future = await makeCampaign({ status: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000) });

      const result = await pollScheduledCampaigns({
        emailService: app.locals.emailService,
        logger: quietLogger,
      });
      assert.equal(result.dispatched, 1);
      await waitForCampaignDispatch(due._id);

      assert.equal((await Campaign.findById(due._id)).status, 'sent');
      assert.equal(await Delivery.countDocuments({ campaignId: due._id, status: 'sent' }), 1);
      assert.equal(transport.count, 1);

      const stillFuture = await Campaign.findById(future._id);
      assert.equal(stillFuture.status, 'scheduled');
      assert.equal(await Delivery.countDocuments({ campaignId: future._id }), 0);
    });

    it('does not double-dispatch on concurrent polls', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const due = await makeCampaign({ status: 'scheduled', scheduledAt: new Date(Date.now() - 1000) });
      const opts = { emailService: app.locals.emailService, logger: quietLogger };
      const results = await Promise.all([pollScheduledCampaigns(opts), pollScheduledCampaigns(opts)]);
      await waitForCampaignDispatch(due._id);

      assert.equal(results.reduce((n, r) => n + r.dispatched, 0), 1);
      assert.equal(await Delivery.countDocuments({ campaignId: due._id }), 1);
      assert.equal(transport.count, 1);
    });

    it('fails due campaigns that are no longer ready or whose owner is suspended', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const unready = await makeCampaign({
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 1000),
        recipientIds: [],
      });
      const suspendedContact = await Contact.create({
        userId: suspended._id,
        name: 'Sus',
        email: `${prefix}-suscontact@example.com`,
      });
      const susCampaign = await Campaign.create({
        userId: suspended._id,
        name: 'Suspended Owner',
        subject: 'Hi',
        textContent: 'x',
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 1000),
        recipientIds: [suspendedContact._id],
      });
      await User.updateOne({ _id: suspended._id }, { $set: { status: 'suspended' } });

      const result = await pollScheduledCampaigns({
        emailService: app.locals.emailService,
        logger: quietLogger,
      });
      assert.equal(result.failed, 2);
      assert.equal((await Campaign.findById(unready._id)).status, 'failed');
      assert.equal((await Campaign.findById(susCampaign._id)).status, 'failed');
      assert.equal(transport.count, 0);
      await Contact.deleteMany({ _id: suspendedContact._id });
    });
  });
});
