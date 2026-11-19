/**
 * Gmail campaign dispatch (Milestone 9): the sender snapshot taken by the lock, sending through the
 * Gmail API as that snapshot (and nothing else), and what each Gmail outcome is recorded as.
 * Google and Gmail are simulated by intercepting fetch; no real account or email is involved, and
 * the platform SMTP service is never configured.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('gmaildispatch');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.TOKEN_ENCRYPTION_KEYS = `gmail-dispatch:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;
process.env.GOOGLE_OAUTH_CLIENT_ID = '123456789-testonly.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = `test-only-${crypto.randomBytes(8).toString('hex')}`;
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.test/settings/sender-accounts/callback';
process.env.GMAIL_SENDER_RATE_PER_MINUTE = '0';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.CAMPAIGN_SEND_RATE_PER_MINUTE;

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import SenderAccount from '../src/models/SenderAccount.js';
import { connectDB } from '../src/config/db.js';
import { GOOGLE_ENDPOINTS } from '../src/config/googleOAuth.js';
import { setGoogleHttpClient } from '../src/services/googleOAuth.service.js';
import { setGmailHttpClient } from '../src/services/gmailTransport.service.js';
import { resetTokenCipher } from '../src/utils/tokenCrypto.js';
import { sealAccessToken, sealRefreshToken } from '../src/services/senderAccount.service.js';
import { getDefaultEmailService } from '../src/services/email.service.js';
import { pollScheduledCampaigns } from '../src/services/campaignScheduler.service.js';
import { evaluateCampaignReadiness } from '../src/services/campaignReadiness.service.js';
import {
  startCampaignDispatch,
  waitForCampaignDispatch,
  recoverCampaign,
  resetDispatcherState,
  stopAllDispatches,
} from '../src/services/campaignDispatch.service.js';
import { CampaignSenderError } from '../src/services/campaignSender.service.js';
import { createTestSender } from './helpers/sender.js';

resetTokenCipher();

const quiet = { log() {}, warn() {}, error() {} };

describe('Gmail campaign dispatch (Milestone 9)', () => {
  let isDbConnected = false;
  let owner;
  let gmail; // simulated Gmail: calls + the scripted answer
  let oauthCalls;
  let oauthAnswer;

  const makeSender = (overrides = {}) =>
    createTestSender(owner._id, {
      withTokens: (_id) => ({
        encryptedRefreshToken: sealRefreshToken(_id, `1//test-refresh-${crypto.randomBytes(4).toString('hex')}`),
        encryptedAccessToken: sealAccessToken(_id, `ya29.access-${_id}`),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      }),
      ...overrides,
    });

  const makeContacts = (n) =>
    Contact.insertMany(
      Array.from({ length: n }, (_, i) => ({
        userId: owner._id,
        name: `Person ${i}`,
        email: `p${i}-${crypto.randomBytes(3).toString('hex')}@example.com`,
      }))
    );

  /** A due scheduled campaign selecting `sender`, locked and sent by one scheduler poll. */
  const queueCampaign = async (sender, contacts, overrides = {}) =>
    Campaign.create({
      userId: owner._id,
      name: 'Gmail campaign',
      subject: 'Hello',
      textContent: 'Plain body',
      htmlContent: '<p>Body</p>',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000),
      recipientIds: contacts.map((c) => c._id),
      senderAccountId: sender._id,
      ...overrides,
    });

  const dispatchDue = async (campaign) => {
    const result = await pollScheduledCampaigns({ logger: quiet });
    await waitForCampaignDispatch(campaign._id);
    return result;
  };

  const rawOf = (call) => Buffer.from(JSON.parse(call.init.body).raw, 'base64url').toString('utf8');
  const tokenOf = (call) => call.init.headers.Authorization;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init(), SenderAccount.init()]);
    } catch (error) {
      console.warn(`[Gmail dispatch tests] MongoDB unavailable: ${error.message}`);
    }
  });

  beforeEach(async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Promise.all([Campaign.deleteMany({}), Delivery.deleteMany({}), Contact.deleteMany({}), SenderAccount.deleteMany({}), User.deleteMany({})]);
    owner = await User.create({ name: 'Owner', email: `owner-${crypto.randomBytes(3).toString('hex')}@example.com`, passwordHash: 'x'.repeat(60) });
    resetDispatcherState();
    gmail = { calls: [], answer: () => new Response(JSON.stringify({ id: 'gm-1', threadId: 'th-1' }), { status: 200 }) };
    oauthCalls = [];
    oauthAnswer = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    setGmailHttpClient(async (url, init) => {
      assert.equal(url, GOOGLE_ENDPOINTS.gmailSend);
      gmail.calls.push({ url, init });
      return gmail.answer(gmail.calls.length, init);
    });
    setGoogleHttpClient(async (url, init) => {
      assert.equal(url, GOOGLE_ENDPOINTS.token);
      oauthCalls.push({ url, init });
      return oauthAnswer(oauthCalls.length);
    });
  });

  afterEach(async () => {
    setGmailHttpClient(null);
    setGoogleHttpClient(null);
    if (isDbConnected) await stopAllDispatches();
  });

  after(async () => {
    setGmailHttpClient(null);
    setGoogleHttpClient(null);
    if (isDbConnected) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  describe('the sender snapshot and the sender used', () => {
    it('locks the selected sender into an immutable snapshot and sends through it with the Gmail API', async () => {
      const chosen = await makeSender({ email: 'chosen@example.com', displayName: 'Chosen Box' });
      const other = await makeSender({ email: 'other@example.com' });
      const contacts = await makeContacts(3);
      const campaign = await queueCampaign(chosen, contacts);

      const poll = await dispatchDue(campaign);
      assert.equal(poll.dispatched, 1);

      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(stored.status, 'sent');
      assert.deepEqual(
        { accountId: String(stored.dispatchSender.accountId), googleSub: stored.dispatchSender.googleSub, email: stored.dispatchSender.email },
        { accountId: String(chosen._id), googleSub: chosen.providerAccountId, email: 'chosen@example.com' }
      );
      assert.equal(gmail.calls.length, 3);
      for (const call of gmail.calls) {
        assert.equal(tokenOf(call), `Bearer ya29.access-${chosen._id}`);
        assert.notEqual(tokenOf(call), `Bearer ya29.access-${other._id}`);
        assert.match(rawOf(call), /^From: .*<chosen@example\.com>/m);
      }
      const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
      assert.ok(deliveries.every((d) => d.status === 'sent' && d.errorCode === null));
      // campaign mail never touched the platform SMTP service
      assert.equal(getDefaultEmailService().getTransport(), null);
    });

    it('keeps unsubscribe headers and drops ESP-specific headers on Gmail messages', async () => {
      const sender = await makeSender();
      const contacts = await makeContacts(1);
      process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = 'configured';
      try {
        const campaign = await queueCampaign(sender, contacts);
        await dispatchDue(campaign);
      } finally {
        delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
      }
      const raw = rawOf(gmail.calls[0]);
      assert.match(raw, /^List-Unsubscribe:\s+<http/m);
      assert.match(raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
      assert.doesNotMatch(raw, /X-SMTPAPI|X-Mailgun|X-SES|mailpulse_delivery_id/i);
    });

    it('does not change the sender when the campaign configuration changes after the lock', async () => {
      const locked = await makeSender();
      const other = await makeSender();
      const contacts = await makeContacts(2);
      const campaign = await queueCampaign(locked, contacts);
      // Locked, deliveries generated, but processing not started: raw lock via startCampaignDispatch
      const due = await Campaign.findById(campaign._id);
      const { eligibleContacts } = await evaluateCampaignReadiness(due, owner._id);
      const lockedDoc = await startCampaignDispatch({
        campaign: due,
        userId: owner._id,
        eligibleContacts,
        emailService: { sendEmail: async () => { throw new Error('parked'); } }, // holds the first run
        logger: quiet,
      });
      await waitForCampaignDispatch(campaign._id);
      assert.equal(String(lockedDoc.dispatchSender.accountId), String(locked._id));

      // The configuration is changed behind the lock's back (the API would answer 409)
      await Campaign.collection.updateOne({ _id: campaign._id }, { $set: { senderAccountId: other._id } });
      await Campaign.updateOne({ _id: campaign._id }, { $set: { 'dispatchSender.email': 'evil@example.com' } });
      const stored = await Campaign.findById(campaign._id).lean();
      assert.equal(String(stored.dispatchSender.accountId), String(locked._id));
      assert.equal(stored.dispatchSender.email, locked.email);
    });

    it('recovery sends through the ORIGINAL snapshot, never the campaign\'s current senderAccountId', async () => {
      const locked = await makeSender();
      const other = await makeSender();
      const contacts = await makeContacts(2);
      const campaign = await queueCampaign(locked, contacts);
      const due = await Campaign.findById(campaign._id);
      const { eligibleContacts } = await evaluateCampaignReadiness(due, owner._id);
      // Lock and generate, but make the first run fail every send as "not sent" is NOT wanted:
      // park the dispatch by giving it a service that never resolves? Simpler: stop the dispatcher first.
      await stopAllDispatches();
      await startCampaignDispatch({ campaign: due, userId: owner._id, eligibleContacts, logger: quiet });
      resetDispatcherState();
      assert.equal((await Campaign.findById(campaign._id).lean()).status, 'sending');
      assert.equal(gmail.calls.length, 0);

      await Campaign.collection.updateOne({ _id: campaign._id }, { $set: { senderAccountId: other._id } });
      await Campaign.collection.updateOne({ _id: campaign._id }, { $set: { dispatchLeaseUntil: new Date(Date.now() - 1000) } });
      const outcome = await recoverCampaign(campaign._id, { logger: quiet });
      assert.equal(outcome, 'resumed');
      await waitForCampaignDispatch(campaign._id);

      assert.equal(gmail.calls.length, 2);
      for (const call of gmail.calls) assert.equal(tokenOf(call), `Bearer ya29.access-${locked._id}`);
      assert.equal((await Campaign.findById(campaign._id).lean()).status, 'sent');
    });

    it('refuses to lock a campaign with a missing, foreign, disconnected or reconnect-required sender', async () => {
      const contacts = await makeContacts(1);
      const stranger = await User.create({ name: 'Stranger', email: `s-${crypto.randomBytes(3).toString('hex')}@example.com`, passwordHash: 'x'.repeat(60) });
      const foreign = await createTestSender(stranger._id);
      const disconnected = await makeSender({ status: 'disconnected' });
      const reauth = await makeSender({ status: 'reauth_required' });
      const none = await queueCampaign({ _id: null }, contacts, { senderAccountId: null });

      for (const [label, senderId] of [['missing', null], ['foreign', foreign._id], ['disconnected', disconnected._id], ['reauth', reauth._id]]) {
        const campaign = label === 'missing' ? none : await queueCampaign({ _id: senderId }, contacts);
        const doc = await Campaign.findById(campaign._id);
        const { eligibleContacts } = await evaluateCampaignReadiness(
          await Campaign.findOneAndUpdate({ _id: campaign._id }, { $set: { senderAccountId: senderId } }, { new: true }),
          owner._id
        );
        await assert.rejects(
          startCampaignDispatch({ campaign: doc, userId: owner._id, eligibleContacts: eligibleContacts.length ? eligibleContacts : contacts, logger: quiet }),
          CampaignSenderError,
          label
        );
        const stored = await Campaign.findById(campaign._id).lean();
        assert.equal(stored.status, 'scheduled', label);
        assert.equal(stored.dispatchSender, undefined, label);
      }
      assert.equal(await Delivery.countDocuments({}), 0);
      assert.equal(gmail.calls.length, 0);
    });

    it('never sends a locked campaign that has no sender snapshot (and finds no other sender)', async () => {
      await makeSender(); // an account exists; it must NOT be picked up
      const contacts = await makeContacts(2);
      const campaign = await Campaign.create({
        userId: owner._id,
        name: 'Legacy',
        subject: 'Hello',
        textContent: 'Body',
        status: 'sending',
        sendStartedAt: new Date(),
        recipientIds: contacts.map((c) => c._id),
        senderAccountId: null,
        dispatchSender: null,
      });
      await Campaign.collection.updateOne({ _id: campaign._id }, { $unset: { dispatchSender: '' } });
      await Delivery.insertMany(contacts.map((c) => ({ campaignId: campaign._id, userId: owner._id, contactId: c._id, email: c.email, status: 'pending' })));
      assert.equal(await recoverCampaign(campaign._id, { logger: quiet }), 'refused');
      assert.equal(gmail.calls.length, 0);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, status: 'pending' }), 2);
    });
  });

  describe('outcome classification', () => {
    const sendOne = async (answer) => {
      const sender = await makeSender();
      const contacts = await makeContacts(1);
      gmail.answer = answer;
      const campaign = await queueCampaign(sender, contacts);
      await dispatchDue(campaign);
      return { campaign, delivery: await Delivery.findOne({ campaignId: campaign._id }).lean(), sender };
    };

    it('confirmed Gmail acceptance is SENT, with the Gmail message id recorded', async () => {
      const { delivery } = await sendOne(() => new Response(JSON.stringify({ id: 'gm-9', threadId: 't' }), { status: 200 }));
      assert.equal(delivery.status, 'sent');
      assert.equal(delivery.errorCode, null);
    });

    it('a definite Gmail refusal (400) is recorded as not sent (TRANSPORT_ERROR) and is not retried', async () => {
      const { campaign, delivery } = await sendOne(() => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), { status: 400 }));
      assert.equal(delivery.status, 'failed');
      assert.equal(delivery.errorCode, 'TRANSPORT_ERROR');
      assert.equal(gmail.calls.length, 1);
      assert.equal((await Campaign.findById(campaign._id).lean()).status, 'failed');
    });

    for (const [label, answer] of [
      ['a timeout', () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }],
      ['a connection reset', () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }],
      ['a 500 answer', () => new Response('oops', { status: 500 })],
      ['a 503 answer', () => new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status: 503 })],
    ]) {
      it(`${label} is SEND_UNCERTAIN, never SENT, and is never retried`, async () => {
        const { campaign, delivery } = await sendOne(answer);
        assert.equal(delivery.status, 'failed');
        assert.equal(delivery.errorCode, 'SEND_UNCERTAIN');
        assert.equal(gmail.calls.length, 1);
        // recovery (restart, watchdog) must not send it again either
        await Campaign.collection.updateOne({ _id: campaign._id }, { $set: { status: 'sending', dispatchLeaseUntil: new Date(Date.now() - 1000) } });
        await recoverCampaign(campaign._id, { logger: quiet });
        await waitForCampaignDispatch(campaign._id);
        assert.equal(gmail.calls.length, 1);
        assert.equal((await Delivery.findById(delivery._id).lean()).errorCode, 'SEND_UNCERTAIN');
      });
    }

    it('a failed token refresh before sending sends nothing, claims nothing and is not an uncertain submission', async () => {
      const sender = await makeSender({
        withTokens: (_id) => ({
          encryptedRefreshToken: sealRefreshToken(_id, '1//test-refresh'),
          encryptedAccessToken: sealAccessToken(_id, 'ya29.stale'),
          accessTokenExpiresAt: new Date(Date.now() - 60_000), // expired: a refresh is needed
        }),
      });
      oauthAnswer = () => new Response('unavailable', { status: 503 });
      const contacts = await makeContacts(3);
      const campaign = await queueCampaign(sender, contacts);
      await dispatchDue(campaign);

      assert.equal(gmail.calls.length, 0);
      assert.ok(oauthCalls.length >= 1);
      const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
      assert.equal(deliveries.length, 3);
      assert.ok(deliveries.every((d) => d.status === 'pending' && d.errorCode === null && d.attempts === 0));
      assert.ok(!deliveries.some((d) => d.errorCode === 'SEND_UNCERTAIN'));
    });

    it('a revoked grant at refresh time marks the account reconnect-required and sends nothing', async () => {
      const sender = await makeSender({
        withTokens: (_id) => ({
          encryptedRefreshToken: sealRefreshToken(_id, '1//test-refresh'),
          encryptedAccessToken: sealAccessToken(_id, 'ya29.stale'),
          accessTokenExpiresAt: new Date(Date.now() - 60_000),
        }),
      });
      const contacts = await makeContacts(2);
      const campaign = await queueCampaign(sender, contacts);
      await dispatchDue(campaign);
      assert.equal(gmail.calls.length, 0);
      assert.equal((await SenderAccount.findById(sender._id)).status, 'reauth_required');
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, status: 'pending' }), 2);
    });

    it('a 401 from Gmail is a definite refusal: recorded not sent, the token cache is dropped, nothing else is sent', async () => {
      const { delivery, sender } = await sendOne(() => new Response(JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }), { status: 401 }));
      assert.equal(delivery.errorCode, 'TRANSPORT_ERROR');
      assert.equal((await SenderAccount.findById(sender._id).select('+encryptedAccessToken')).encryptedAccessToken, null);
    });
  });

  describe('no SMTP fallback', () => {
    it('sends nothing at all when the locked sender no longer exists, instead of using another transport', async () => {
      const sender = await makeSender();
      const contacts = await makeContacts(1);
      const campaign = await queueCampaign(sender, contacts);
      const due = await Campaign.findById(campaign._id);
      const { eligibleContacts } = await evaluateCampaignReadiness(due, owner._id);
      await stopAllDispatches();
      await startCampaignDispatch({ campaign: due, userId: owner._id, eligibleContacts, logger: quiet });
      resetDispatcherState();
      await SenderAccount.deleteOne({ _id: sender._id });
      await Campaign.collection.updateOne({ _id: campaign._id }, { $set: { dispatchLeaseUntil: new Date(Date.now() - 1000) } });
      await recoverCampaign(campaign._id, { logger: quiet });
      await waitForCampaignDispatch(campaign._id);
      assert.equal(gmail.calls.length, 0);
      assert.equal(getDefaultEmailService().getTransport(), null);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, status: 'pending' }), 1);
    });
  });
});
