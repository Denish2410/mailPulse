/**
 * Campaign sender account selection (Milestone 8): exactly one explicitly selected, owned,
 * connected Gmail account per campaign; test emails go out through it; transactional mail stays
 * on the platform SMTP service. Google/Gmail are simulated; no real account or email is used.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';
process.env.TEST_EMAIL_RATE_LIMIT_MAX = '1000';
process.env.TOKEN_ENCRYPTION_KEYS = `sender-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import SenderAccount from '../src/models/SenderAccount.js';
import { connectDB } from '../src/config/db.js';
import { GOOGLE_ENDPOINTS } from '../src/config/googleOAuth.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { resetTokenCipher } from '../src/utils/tokenCrypto.js';
import { sealAccessToken, sealRefreshToken } from '../src/services/senderAccount.service.js';
import { createTestSender } from './helpers/sender.js';

resetTokenCipher();

describe('Campaign sender account selection (Milestone 8)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `cmpsender-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let owner;
  let ownerToken;
  let other;
  let otherToken;
  let contact;
  let gmailCalls;

  const api = (path, { method = 'GET', token = ownerToken, body } = {}) =>
    fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  /** A connected sender with a cached access token, so no token refresh is needed. */
  const connectedSender = (user, overrides = {}) =>
    createTestSender(user._id, {
      withTokens: (_id) => ({
        encryptedRefreshToken: sealRefreshToken(_id, `1//test-refresh-${crypto.randomBytes(4).toString('hex')}`),
        encryptedAccessToken: sealAccessToken(_id, `ya29.test-access-${_id}`),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      }),
      ...overrides,
    });

  const draft = (overrides = {}) =>
    Campaign.create({
      userId: owner._id,
      name: 'Sender test',
      subject: 'Hello there',
      textContent: 'Plain body',
      htmlContent: '<p>Body</p>',
      status: 'draft',
      recipientIds: [contact._id],
      ...overrides,
    });

  const wipe = async () => {
    const users = await User.find({ email: new RegExp(`^${prefix}`) }).select('_id').lean();
    const ids = users.map((u) => u._id);
    await Campaign.deleteMany({ userId: { $in: ids } });
    await Contact.deleteMany({ userId: { $in: ids } });
    await SenderAccount.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init();
      await SenderAccount.init();
    } catch (error) {
      console.warn(`[Campaign sender tests] MongoDB unavailable: ${error.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await wipe();
    const passwordHash = await hashPassword('StrongPassword123!');
    owner = await User.create({ name: 'Owner', email: `${prefix}-owner@example.com`, passwordHash });
    other = await User.create({ name: 'Other', email: `${prefix}-other@example.com`, passwordHash });
    ownerToken = signAccessToken(owner);
    otherToken = signAccessToken(other);
    contact = await Contact.create({ userId: owner._id, name: 'Rae', email: `${prefix}-rae@example.com` });
    gmailCalls = [];
    delete app.locals.campaignEmailService;
    delete app.locals.emailService;
    app.locals.gmailFetch = async (url, init) => {
      gmailCalls.push({ url, init });
      return new Response(JSON.stringify({ id: 'gm-1', threadId: 'th-1' }), { status: 200 });
    };
  });

  after(async () => {
    delete app.locals.gmailFetch;
    delete app.locals.campaignEmailService;
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) await wipe();
    await (await import('mongoose')).default.disconnect();
  });

  describe('selecting a sender', () => {
    it('lets the owner select their own connected sender on create and update', async () => {
      const sender = await connectedSender(owner);
      const created = await api('/campaigns', {
        method: 'POST',
        body: { name: 'With sender', subject: 'Hi', senderAccountId: String(sender._id) },
      });
      assert.equal(created.status, 201);
      const body = await created.json();
      assert.equal(body.data.campaign.senderAccountId, String(sender._id));
      assert.equal(body.data.campaign.sender.email, sender.email);
      assert.equal(body.data.campaign.sender.canSend, true);

      const bare = await draft();
      const patched = await api(`/campaigns/${bare._id}`, { method: 'PATCH', body: { senderAccountId: String(sender._id) } });
      assert.equal(patched.status, 200);
      assert.equal((await patched.json()).data.campaign.sender.id, String(sender._id));
      assert.equal(String((await Campaign.findById(bare._id)).senderAccountId), String(sender._id));
    });

    it('never selects a sender by itself, even when the owner has exactly one account', async () => {
      await connectedSender(owner);
      const created = await api('/campaigns', { method: 'POST', body: { name: 'No sender', subject: 'Hi' } });
      assert.equal(created.status, 201);
      const { campaign } = (await created.json()).data;
      assert.equal(campaign.senderAccountId, null);
      assert.equal(campaign.sender, null);
    });

    it("rejects another tenant's sender account like a missing one (create and update)", async () => {
      const foreign = await connectedSender(other);
      const created = await api('/campaigns', {
        method: 'POST',
        body: { name: 'Steal', subject: 'Hi', senderAccountId: String(foreign._id) },
      });
      assert.equal(created.status, 422);
      const missing = await api('/campaigns', {
        method: 'POST',
        body: { name: 'Missing', subject: 'Hi', senderAccountId: String(new (await import('mongoose')).default.Types.ObjectId()) },
      });
      assert.equal(missing.status, 422);
      assert.equal((await created.json()).message, (await missing.json()).message);

      const bare = await draft();
      const patched = await api(`/campaigns/${bare._id}`, { method: 'PATCH', body: { senderAccountId: String(foreign._id) } });
      assert.equal(patched.status, 422);
      assert.equal((await Campaign.findById(bare._id)).senderAccountId, null);
    });

    it('rejects disconnected and reconnect-required senders', async () => {
      for (const [status, statusReason] of [
        ['disconnected', 'USER_DISCONNECTED'],
        ['reauth_required', 'TOKEN_REVOKED'],
      ]) {
        const sender = await connectedSender(owner, { status, statusReason });
        const response = await api('/campaigns', {
          method: 'POST',
          body: { name: `Bad ${status}`, subject: 'Hi', senderAccountId: String(sender._id) },
        });
        assert.equal(response.status, 422, status);
        assert.match((await response.json()).message, /disconnected|no longer accepts/i);
      }
    });

    it('rejects a sender that was not granted permission to send', async () => {
      const sender = await connectedSender(owner, { scopes: ['openid', 'email'] });
      const response = await api('/campaigns', {
        method: 'POST',
        body: { name: 'No scope', subject: 'Hi', senderAccountId: String(sender._id) },
      });
      assert.equal(response.status, 422);
    });

    it('lets the owner clear the sender with null', async () => {
      const sender = await connectedSender(owner);
      const campaign = await draft({ senderAccountId: sender._id });
      const response = await api(`/campaigns/${campaign._id}`, { method: 'PATCH', body: { senderAccountId: null } });
      assert.equal(response.status, 200);
      assert.equal((await Campaign.findById(campaign._id)).senderAccountId, null);
    });
  });

  describe('a missing or unusable sender blocks sending', () => {
    it('reports a readiness issue and refuses to send or schedule without a sender', async () => {
      app.locals.campaignEmailService = createEmailService({ transport: createMockTransport() });
      const campaign = await draft();
      const readiness = await (await api(`/campaigns/${campaign._id}/readiness`)).json();
      assert.equal(readiness.data.isReady, false);
      assert.ok(readiness.data.issues.some((issue) => /Gmail account/i.test(issue)));

      const send = await api(`/campaigns/${campaign._id}/send`, { method: 'POST', body: { confirm: true } });
      assert.equal(send.status, 422);
      const schedule = await api(`/campaigns/${campaign._id}/schedule`, {
        method: 'POST',
        body: { scheduledAt: new Date(Date.now() + 3600_000).toISOString() },
      });
      assert.equal(schedule.status, 422);
      assert.equal((await Campaign.findById(campaign._id)).status, 'draft');
    });

    it('a sender that was disconnected after selection makes the campaign not ready', async () => {
      const sender = await connectedSender(owner);
      const campaign = await draft({ senderAccountId: sender._id });
      let readiness = await (await api(`/campaigns/${campaign._id}/readiness`)).json();
      assert.equal(readiness.data.isReady, true);
      await SenderAccount.updateOne({ _id: sender._id }, { $set: { status: 'disconnected' } });
      readiness = await (await api(`/campaigns/${campaign._id}/readiness`)).json();
      assert.equal(readiness.data.isReady, false);
      assert.ok(readiness.data.issues.some((issue) => /disconnected/i.test(issue)));
    });
  });

  describe('serialization', () => {
    it('never exposes tokens, provider IDs or encrypted envelopes in campaign responses', async () => {
      const sender = await connectedSender(owner);
      const campaign = await draft({ senderAccountId: sender._id });
      const raw = [
        await (await api(`/campaigns/${campaign._id}`)).text(),
        await (await api('/campaigns')).text(),
        await (await api(`/campaigns/${campaign._id}/readiness`)).text(),
      ].join('\n');
      assert.ok(raw.includes(sender.email));
      assert.doesNotMatch(raw, /mpt1\./);
      assert.doesNotMatch(raw, /encrypted|refresh|accessToken|providerAccountId|sub-/i);
    });

    it('shows no sender summary to a tenant that does not own the account', async () => {
      const foreign = await connectedSender(other);
      const campaign = await draft({ senderAccountId: foreign._id }); // written outside the API
      const body = await (await api(`/campaigns/${campaign._id}`)).json();
      assert.equal(body.data.campaign.sender, null);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(foreign.email));
      // and it is not ready: the account is not the owner's
      const readiness = await (await api(`/campaigns/${campaign._id}/readiness`)).json();
      assert.equal(readiness.data.isReady, false);
    });
  });

  describe('test emails', () => {
    it('are sent through the Gmail API as the selected sender, to the account holder only', async () => {
      const sender = await connectedSender(owner, { email: `${prefix}-box@example.com`, displayName: 'Acme Mailbox' });
      const campaign = await draft({ senderAccountId: sender._id });
      const response = await api(`/campaigns/${campaign._id}/test-email`, { method: 'POST', body: {} });
      assert.equal(response.status, 200);

      assert.equal(gmailCalls.length, 1);
      const { url, init } = gmailCalls[0];
      assert.equal(url, GOOGLE_ENDPOINTS.gmailSend);
      assert.equal(init.headers.Authorization, `Bearer ya29.test-access-${sender._id}`);
      const raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8');
      assert.match(raw, new RegExp(`^From: .*<${prefix}-box@example.com>`, 'm'));
      assert.match(raw, new RegExp(`^To: ${owner.email}`, 'mi'));
      assert.doesNotMatch(raw, /X-SMTPAPI|X-Mailgun|X-SES/i);
    });

    it('do not use the sender of another tenant or another account of the owner', async () => {
      const chosen = await connectedSender(owner);
      await connectedSender(owner); // a second account that must NOT be used
      const campaign = await draft({ senderAccountId: chosen._id });
      assert.equal((await api(`/campaigns/${campaign._id}/test-email`, { method: 'POST', body: {} })).status, 200);
      assert.equal(gmailCalls[0].init.headers.Authorization, `Bearer ya29.test-access-${chosen._id}`);
    });

    it('are refused without a usable sender and send nothing', async () => {
      const campaign = await draft();
      const response = await api(`/campaigns/${campaign._id}/test-email`, { method: 'POST', body: {} });
      assert.equal(response.status, 422);
      assert.equal(gmailCalls.length, 0);

      const sender = await connectedSender(owner, { status: 'reauth_required', statusReason: 'TOKEN_REVOKED' });
      await Campaign.updateOne({ _id: campaign._id }, { $set: { senderAccountId: sender._id } });
      assert.equal((await api(`/campaigns/${campaign._id}/test-email`, { method: 'POST', body: {} })).status, 422);
      assert.equal(gmailCalls.length, 0);
    });

    it('never fall back to the platform SMTP service when Gmail fails', async () => {
      const smtpMock = createMockTransport();
      app.locals.emailService = createEmailService({ transport: smtpMock });
      app.locals.gmailFetch = async () => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 });
      const sender = await connectedSender(owner);
      const campaign = await draft({ senderAccountId: sender._id });
      const response = await api(`/campaigns/${campaign._id}/test-email`, { method: 'POST', body: {} });
      assert.equal(response.status, 502);
      assert.equal(smtpMock.count, 0);
      delete app.locals.emailService;
    });
  });

  describe('transactional email', () => {
    it('keeps using the platform SMTP service, not Gmail', async () => {
      const smtpMock = createMockTransport();
      app.locals.emailService = createEmailService({ transport: smtpMock });
      await connectedSender(owner);
      const response = await api('/auth/forgot-password', { method: 'POST', token: null, body: { email: owner.email } });
      assert.equal(response.status, 200);
      // the reset mail is sent in the background
      for (let i = 0; i < 50 && smtpMock.count === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(smtpMock.count, 1);
      assert.equal(smtpMock.lastSentEmail.to, owner.email);
      assert.equal(gmailCalls.length, 0);
      delete app.locals.emailService;
    });
  });
});
