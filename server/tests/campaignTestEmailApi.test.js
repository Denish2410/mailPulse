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
// The route limiter reads env lazily on first request. Raise it for the integration suite;
// limiter behavior itself is verified deterministically in the isolated unit tests below.
process.env.TEST_EMAIL_RATE_LIMIT_MAX = '1000';
// Guarantee no SMTP configuration can be picked up from a developer's local .env
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { AppError, errorHandler } from '../src/middleware/errorHandler.js';
import {
  createTestEmailRateLimiter,
  getTestEmailRateLimitConfig,
  DEFAULT_TEST_EMAIL_RATE_LIMIT_MAX,
  DEFAULT_TEST_EMAIL_RATE_LIMIT_WINDOW_MS,
  TEST_EMAIL_RATE_LIMIT_MESSAGE,
} from '../src/middleware/testEmailRateLimiter.js';
import { buildTestEmailSubject } from '../src/controllers/campaign.controller.js';

describe('Campaign Test Email API (POST /api/v1/campaigns/:id/test-email)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const testPrefix = `testemailapi-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  let userOne;
  let tokenOne;
  let userTwo;
  let tokenTwo;
  let suspendedUser;
  let tokenSuspended;
  let contactOne;

  let mockTransport;

  const postTestEmail = (campaignId, { token, body } = {}) =>
    fetch(`${baseUrl}/api/v1/campaigns/${campaignId}/test-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const createCampaignFor = (user, overrides = {}) =>
    Campaign.create({
      userId: user._id,
      name: 'Test Email Campaign',
      subject: 'October Newsletter',
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
    } catch (err) {
      console.warn(`[Campaign Test Email API Tests] MongoDB unavailable: ${err.message}`);
      isDbConnected = false;
    }

    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');

      userOne = await User.create({
        name: 'Test Email Owner',
        email: `${testPrefix}-owner@example.com`,
        passwordHash,
      });
      tokenOne = signAccessToken(userOne);

      userTwo = await User.create({
        name: 'Other Tenant',
        email: `${testPrefix}-other@example.com`,
        passwordHash,
      });
      tokenTwo = signAccessToken(userTwo);

      suspendedUser = await User.create({
        name: 'Suspended User',
        email: `${testPrefix}-suspended@example.com`,
        passwordHash,
        status: 'suspended',
      });
      tokenSuspended = signAccessToken(suspendedUser);

      contactOne = await Contact.create({
        userId: userOne._id,
        name: 'Real Recipient',
        email: `${testPrefix}-recipient@example.com`,
      });
    }
  });

  beforeEach(async () => {
    // Fresh, isolated in-memory transport for every test: no network, no shared state
    mockTransport = createMockTransport();
    app.locals.emailService = createEmailService({
      transport: mockTransport,
      from: 'MailPulse Test <no-reply@mailpulse.test>',
    });

    if (isDbConnected) {
      await Campaign.deleteMany({
        userId: { $in: [userOne._id, userTwo._id, suspendedUser._id] },
      });
    }
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (isDbConnected) {
      const ids = [userOne._id, userTwo._id, suspendedUser._id];
      await Campaign.deleteMany({ userId: { $in: ids } });
      await Contact.deleteMany({ userId: { $in: ids } });
      await User.deleteMany({ _id: { $in: ids } });
      await mongoose.disconnect();
    }
  });

  describe('1. Authentication and request validation', () => {
    it('Returns 401 without a token and sends nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne);

      const res = await postTestEmail(campaign._id);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(mockTransport.count, 0);
    });

    it('Returns 401 with an invalid token and sends nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne);

      const res = await postTestEmail(campaign._id, { token: 'invalid.jwt.token' });
      assert.equal(res.status, 401);
      assert.equal(mockTransport.count, 0);
    });

    it('Returns 400 for an invalid campaign ID format', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await postTestEmail('not-an-object-id', { token: tokenOne });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(Array.isArray(data.errors));
      assert.equal(mockTransport.count, 0);
    });

    it('Rejects unknown body keys (recipients, recipientIds, cc, bcc) with 400 and sends nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactOne._id] });

      for (const body of [
        { recipients: ['attacker@example.com'] },
        { recipientIds: [contactOne._id.toString()] },
        { cc: 'attacker@example.com' },
        { bcc: 'attacker@example.com' },
      ]) {
        const res = await postTestEmail(campaign._id, { token: tokenOne, body });
        assert.equal(res.status, 400, `Expected 400 for body ${JSON.stringify(body)}`);
      }
      assert.equal(mockTransport.count, 0);
    });

    it('Rejects a "to" address different from the account email with 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne);

      const res = await postTestEmail(campaign._id, {
        token: tokenOne,
        body: { to: 'someone-else@example.com' },
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.errors[0].path, 'body.to');
      assert.equal(mockTransport.count, 0);
    });

    it('Rejects malformed and multi-address "to" values with 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne);

      for (const to of [
        'not-an-email',
        `${userOne.email},attacker@example.com`,
        `${userOne.email}\r\nBcc: attacker@example.com`,
        42,
      ]) {
        const res = await postTestEmail(campaign._id, { token: tokenOne, body: { to } });
        assert.equal(res.status, 400, `Expected 400 for to=${JSON.stringify(to)}`);
      }
      assert.equal(mockTransport.count, 0);
    });

    it('Accepts a "to" matching the account email case-insensitively', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne);

      const res = await postTestEmail(campaign._id, {
        token: tokenOne,
        body: { to: `  ${userOne.email.toUpperCase()}  ` },
      });
      assert.equal(res.status, 200);
      assert.equal(mockTransport.count, 1);
      assert.equal(mockTransport.lastSentEmail.to, userOne.email.toLowerCase());
    });
  });

  describe('2. Ownership and account state', () => {
    it('Returns 404 for a nonexistent campaign and sends nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await postTestEmail(new mongoose.Types.ObjectId(), { token: tokenOne });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.message, 'Campaign not found.');
      assert.equal(mockTransport.count, 0);
    });

    it("Returns the same 404 for another user's campaign and sends nothing", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const foreignCampaign = await createCampaignFor(userTwo);

      const res = await postTestEmail(foreignCampaign._id, { token: tokenOne });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.message, 'Campaign not found.');
      assert.equal(mockTransport.count, 0);
    });

    it('Returns 403 for a suspended account and sends nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(suspendedUser);

      const res = await postTestEmail(campaign._id, { token: tokenSuspended });
      assert.equal(res.status, 403);
      assert.equal(mockTransport.count, 0);
    });
  });

  describe('3. Content preconditions', () => {
    it('Returns 422 when text and HTML content are both empty or whitespace', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, {
        textContent: '   ',
        htmlContent: '\n\t ',
      });

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.errors.some((issue) => issue.path === 'campaign.content'));
      assert.equal(mockTransport.count, 0);
    });

    it('Does not require recipients: a draft with zero recipients can be tested', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [] });

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 200);
      assert.equal(mockTransport.count, 1);
    });

    it('Sends a text-only campaign', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { htmlContent: '' });

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 200);
      assert.equal(mockTransport.lastSentEmail.text, 'Hello from MailPulse');
      assert.equal(mockTransport.lastSentEmail.html, '');
    });

    it('Sends an HTML-only campaign', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { textContent: '' });

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 200);
      assert.equal(mockTransport.lastSentEmail.text, '');
      assert.equal(
        mockTransport.lastSentEmail.html,
        '<p>Hello from <strong>MailPulse</strong></p>'
      );
    });
  });

  describe('4. Successful dispatch', () => {
    it('Sends exactly one email to the account email with a [TEST] subject', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactOne._id] });

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.message, 'Test email dispatched');
      assert.equal(data.data.destination, userOne.email.toLowerCase());
      assert.equal(data.data.subject, '[TEST] October Newsletter');
      assert.equal(typeof data.data.messageId, 'string');
      assert.ok(data.data.messageId.length > 0);
      assert.ok(!Number.isNaN(Date.parse(data.data.sentAt)));

      // Response must not echo message bodies or internal identifiers
      assert.equal(data.data.text, undefined);
      assert.equal(data.data.html, undefined);
      assert.equal(data.data.userId, undefined);

      assert.equal(mockTransport.count, 1);
      const sent = mockTransport.lastSentEmail;
      assert.equal(sent.to, userOne.email.toLowerCase());
      assert.equal(sent.from, 'MailPulse Test <no-reply@mailpulse.test>');
      assert.equal(sent.subject, '[TEST] October Newsletter');
      assert.equal(sent.text, 'Hello from MailPulse');
      assert.equal(sent.html, '<p>Hello from <strong>MailPulse</strong></p>');
      assert.equal(sent.messageId, data.data.messageId);
    });

    it('Never contacts campaign recipients, even when the campaign has recipients', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactOne._id] });

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 200);

      const destinations = mockTransport.sentEmails.map((email) => email.to);
      assert.deepEqual(destinations, [userOne.email.toLowerCase()]);
      assert.equal(destinations.includes(contactOne.email), false);
    });

    it('Truncates long subjects so the prefixed subject never exceeds 200 characters', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const longSubject = 'S'.repeat(200);
      const campaign = await createCampaignFor(userOne, { subject: longSubject });

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 200);
      const subject = mockTransport.lastSentEmail.subject;
      assert.ok(subject.startsWith('[TEST] '));
      assert.equal(subject.length, 200);
    });

    it('Does not modify the campaign document in any way', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne, { recipientIds: [contactOne._id] });
      const before = await Campaign.findById(campaign._id).lean();

      // Ensure any accidental save would produce a detectably different updatedAt
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 200);

      const after = await Campaign.findById(campaign._id).lean();
      assert.deepEqual(after, before);
    });
  });

  describe('5. Fail-closed configuration and sanitized transport errors', () => {
    it('Returns 503 when no email transport is configured, without leaking config details', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne);

      // Remove the injected service: the default service fails closed in NODE_ENV=test
      delete app.locals.emailService;

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.deepEqual(data, { success: false, message: 'Email sending is not configured.' });
      const serialized = JSON.stringify(data);
      assert.equal(serialized.includes('SMTP'), false);
      assert.equal(serialized.includes('mock transport'), false);
      assert.equal(mockTransport.count, 0);
    });

    it('Returns 502 on transport failure without leaking provider details', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const campaign = await createCampaignFor(userOne);

      mockTransport.setFail(
        true,
        new Error('535 Auth failed for smtp.secret-host.internal user=admin pass=hunter2')
      );

      const res = await postTestEmail(campaign._id, { token: tokenOne });
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.deepEqual(data, {
        success: false,
        message: 'Failed to send test email. Please try again later.',
      });
      const serialized = JSON.stringify(data);
      assert.equal(serialized.includes('hunter2'), false);
      assert.equal(serialized.includes('secret-host'), false);
      assert.equal(serialized.includes('535'), false);
      assert.equal(mockTransport.count, 0);
    });
  });
});

describe('Test email rate limiter (unit)', () => {
  const buildLimitedApp = (limiter) => {
    const limitedApp = express();
    // Simulate the upstream authenticate middleware
    limitedApp.use((req, res, next) => {
      req.auth = { userId: req.get('x-test-user') };
      next();
    });
    limitedApp.post('/send', limiter, (req, res) => res.status(200).json({ success: true }));
    return limitedApp;
  };

  const withServer = async (expressApp, fn) => {
    const srv = expressApp.listen(0);
    try {
      await fn(`http://127.0.0.1:${srv.address().port}`);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  };

  it('Blocks a user after the configured maximum with the standard error shape', async () => {
    const limiter = createTestEmailRateLimiter({ max: 2, windowMs: 60_000 });

    await withServer(buildLimitedApp(limiter), async (url) => {
      const send = () => fetch(`${url}/send`, { method: 'POST', headers: { 'x-test-user': 'user-a' } });

      assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 200);

      const blocked = await send();
      assert.equal(blocked.status, 429);
      assert.deepEqual(await blocked.json(), {
        success: false,
        message: TEST_EMAIL_RATE_LIMIT_MESSAGE,
      });
    });
  });

  it('Keys the limit by user: one user hitting the limit does not block another', async () => {
    const limiter = createTestEmailRateLimiter({ max: 1, windowMs: 60_000 });

    await withServer(buildLimitedApp(limiter), async (url) => {
      const sendAs = (user) =>
        fetch(`${url}/send`, { method: 'POST', headers: { 'x-test-user': user } });

      assert.equal((await sendAs('user-a')).status, 200);
      assert.equal((await sendAs('user-a')).status, 429);
      // Same IP, different user: still allowed
      assert.equal((await sendAs('user-b')).status, 200);
    });
  });

  it('Resolves configuration from env and falls back to safe defaults for invalid values', () => {
    assert.deepEqual(getTestEmailRateLimitConfig({}), {
      windowMs: DEFAULT_TEST_EMAIL_RATE_LIMIT_WINDOW_MS,
      max: DEFAULT_TEST_EMAIL_RATE_LIMIT_MAX,
    });
    assert.deepEqual(
      getTestEmailRateLimitConfig({
        TEST_EMAIL_RATE_LIMIT_WINDOW_MS: '60000',
        TEST_EMAIL_RATE_LIMIT_MAX: '3',
      }),
      { windowMs: 60000, max: 3 }
    );
    for (const bad of ['0', '-5', 'abc', '2.5', '   ']) {
      assert.deepEqual(
        getTestEmailRateLimitConfig({
          TEST_EMAIL_RATE_LIMIT_WINDOW_MS: bad,
          TEST_EMAIL_RATE_LIMIT_MAX: bad,
        }),
        {
          windowMs: DEFAULT_TEST_EMAIL_RATE_LIMIT_WINDOW_MS,
          max: DEFAULT_TEST_EMAIL_RATE_LIMIT_MAX,
        },
        `Expected defaults for ${JSON.stringify(bad)}`
      );
    }
  });
});

describe('Test email helpers and error exposure (unit)', () => {
  it('buildTestEmailSubject prefixes and truncates safely', () => {
    assert.equal(buildTestEmailSubject('Hello'), '[TEST] Hello');
    assert.equal(buildTestEmailSubject('  Padded  '), '[TEST] Padded');
    assert.equal(buildTestEmailSubject('x'.repeat(250)).length, 200);
  });

  it('Only explicitly exposed 5xx AppErrors reveal their message; others stay generic', async () => {
    const errorApp = express();
    errorApp.get('/exposed', (req, res, next) =>
      next(new AppError('Email sending is not configured.', 503, null, { expose: true }))
    );
    errorApp.get('/hidden', (req, res, next) =>
      next(new AppError('internal detail smtp.secret-host', 503))
    );
    errorApp.use(errorHandler);

    const srv = errorApp.listen(0);
    const url = `http://127.0.0.1:${srv.address().port}`;
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const exposed = await fetch(`${url}/exposed`);
      assert.equal(exposed.status, 503);
      assert.equal((await exposed.json()).message, 'Email sending is not configured.');

      const hidden = await fetch(`${url}/hidden`);
      assert.equal(hidden.status, 503);
      const hiddenData = await hidden.json();
      assert.equal(hiddenData.message, 'Internal Server Error');
      assert.equal(JSON.stringify(hiddenData).includes('secret-host'), false);
    } finally {
      console.error = originalConsoleError;
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});
