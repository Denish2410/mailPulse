/**
 * Disconnect, revoke, pause and resume (Milestone 10). A campaign whose locked Gmail sender goes
 * away pauses; sent and uncertain deliveries are kept, unsent ones stay pending, no other account
 * is ever used, reconnecting does not resume anything, and only the owner's explicit resume (from
 * the same Google account) continues it. Google and Gmail are simulated; no real account or email.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('campaignpause');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';
process.env.TOKEN_ENCRYPTION_KEYS = `pause-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;
process.env.GOOGLE_OAUTH_CLIENT_ID = '123456789-testonly.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = `test-only-${crypto.randomBytes(8).toString('hex')}`;
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.test/settings/sender-accounts/callback';
process.env.CAMPAIGN_SEND_CONCURRENCY = '1';
process.env.SEND_RATE_LIMIT_MAX = '1000';
delete process.env.SMTP_HOST;

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import SenderAccount from '../src/models/SenderAccount.js';
import Suppression from '../src/models/Suppression.js';
import { connectDB } from '../src/config/db.js';
import { GOOGLE_ENDPOINTS } from '../src/config/googleOAuth.js';
import { signAccessToken } from '../src/utils/token.js';
import { resetTokenCipher } from '../src/utils/tokenCrypto.js';
import { sealAccessToken, sealRefreshToken } from '../src/services/senderAccount.service.js';
import { setGmailHttpClient } from '../src/services/gmailTransport.service.js';
import { setGoogleHttpClient } from '../src/services/googleOAuth.service.js';
import { disconnectSenderAccount } from '../src/services/senderConnection.service.js';
import { getSenderAccessToken } from '../src/services/senderToken.service.js';
import { pollScheduledCampaigns } from '../src/services/campaignScheduler.service.js';
import {
  waitForCampaignDispatch,
  reapStalledCampaigns,
  recoverCampaign,
  resetDispatcherState,
  stopAllDispatches,
} from '../src/services/campaignDispatch.service.js';
import { createTestSender } from './helpers/sender.js';

resetTokenCipher();
const quiet = { log() {}, warn() {}, error() {} };

describe('Campaign pause and resume (Milestone 10)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  let owner;
  let ownerToken;
  let gmail;

  const tokens = (_id) => ({
    encryptedRefreshToken: sealRefreshToken(_id, `1//test-refresh-${crypto.randomBytes(4).toString('hex')}`),
    encryptedAccessToken: sealAccessToken(_id, `ya29.access-${_id}`),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
  });
  const makeSender = (user = owner, overrides = {}) => createTestSender(user._id, { withTokens: tokens, ...overrides });
  const makeContacts = (n) =>
    Contact.insertMany(Array.from({ length: n }, (_, i) => ({ userId: owner._id, name: `P${i}`, email: `c${i}-${crypto.randomBytes(3).toString('hex')}@example.com` })));
  const queue = (sender, contacts) =>
    Campaign.create({
      userId: owner._id, name: 'Pause campaign', subject: 'Hi', textContent: 'Body', status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000), recipientIds: contacts.map((c) => c._id), senderAccountId: sender._id,
    });
  const run = async (campaign) => {
    await pollScheduledCampaigns({ logger: quiet });
    await waitForCampaignDispatch(campaign._id);
  };
  const sweep = async (campaign) => {
    await reapStalledCampaigns({ logger: quiet, stallTimeoutMs: 1 });
    await waitForCampaignDispatch(campaign._id);
  };
  const statusOf = async (campaign) => Campaign.findById(campaign._id).lean();
  const countBy = async (campaign, filter) => Delivery.countDocuments({ campaignId: campaign._id, ...filter });
  const api = (path, { method = 'POST', token = ownerToken, body = { confirm: true } } = {}) =>
    fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init(), SenderAccount.init()]);
    } catch (error) {
      console.warn(`[Campaign pause tests] MongoDB unavailable: ${error.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Promise.all([Campaign.deleteMany({}), Delivery.deleteMany({}), Contact.deleteMany({}), SenderAccount.deleteMany({}), User.deleteMany({})]);
    owner = await User.create({ name: 'Owner', email: `o-${crypto.randomBytes(3).toString('hex')}@example.com`, passwordHash: 'x'.repeat(60) });
    ownerToken = signAccessToken(owner);
    resetDispatcherState();
    gmail = { calls: [], answer: () => new Response(JSON.stringify({ id: 'gm', threadId: 't' }), { status: 200 }) };
    setGmailHttpClient(async (url, init) => {
      assert.equal(url, GOOGLE_ENDPOINTS.gmailSend);
      gmail.calls.push(init.headers.Authorization);
      return gmail.answer(gmail.calls.length);
    });
    setGoogleHttpClient(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
  });

  afterEach(async () => {
    setGmailHttpClient(null);
    setGoogleHttpClient(null);
    if (isDbConnected) await stopAllDispatches();
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('disconnect before the first claim: nothing is sent, the campaign pauses, every delivery stays pending', async () => {
    const sender = await makeSender();
    const campaign = await queue(sender, await makeContacts(3));
    // Locked and deliveries generated, but nothing sent yet: stop the dispatcher so the lock leaves it parked
    await stopAllDispatches();
    await pollScheduledCampaigns({ logger: quiet });
    resetDispatcherState();
    assert.equal((await statusOf(campaign)).status, 'sending');

    await disconnectSenderAccount({ userId: owner._id, accountId: sender._id, fetchImpl: async () => new Response('{}', { status: 200 }) });
    await sweep(campaign);

    const paused = await statusOf(campaign);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'SENDER_DISCONNECTED');
    assert.ok(paused.pausedAt);
    assert.equal(gmail.calls.length, 0);
    assert.equal(await countBy(campaign, { status: 'pending' }), 3);
    assert.equal(await countBy(campaign, { attempts: { $gt: 0 } }), 0);
  });

  it('disconnect mid-campaign: SENT stays SENT, unsent stay pending, no other account takes over', async () => {
    const sender = await makeSender();
    const spare = await makeSender(owner, { email: 'spare@example.com' });
    const campaign = await queue(sender, await makeContacts(4));
    gmail.answer = async (n) => {
      if (n === 2) {
        // The owner disconnects while the second message is being handed to Gmail
        await disconnectSenderAccount({ userId: owner._id, accountId: sender._id, fetchImpl: async () => new Response('{}', { status: 200 }) });
      }
      return new Response(JSON.stringify({ id: `gm-${n}`, threadId: 't' }), { status: 200 });
    };
    await run(campaign);

    const paused = await statusOf(campaign);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'SENDER_DISCONNECTED');
    assert.equal(gmail.calls.length, 2, 'nothing was submitted after the disconnect');
    assert.ok(gmail.calls.every((a) => a === `Bearer ya29.access-${sender._id}`));
    assert.equal(await countBy(campaign, { status: 'sent' }), 2);
    assert.equal(await countBy(campaign, { status: 'pending' }), 2);
    assert.equal(paused.stats.sent, 2);
    // the spare account was never used and the campaign still points at its locked sender
    assert.ok(!gmail.calls.includes(`Bearer ya29.access-${spare._id}`));
    assert.equal(String(paused.dispatchSender.accountId), String(sender._id));
  });

  it('a claimed delivery whose sender vanishes before the hand-over is recorded as not sent, never retried', async () => {
    const sender = await makeSender();
    const campaign = await queue(sender, await makeContacts(2));
    // Disconnect exactly between the pre-claim check and the pre-send check: the suppression lookup
    // that follows the claim is the hook
    const originalExists = Suppression.exists.bind(Suppression);
    let hooked = false;
    Suppression.exists = async (...args) => {
      if (!hooked) {
        hooked = true;
        await SenderAccount.updateOne({ _id: sender._id }, { $set: { status: 'disconnected' } });
      }
      return originalExists(...args);
    };
    try {
      await run(campaign);
    } finally {
      Suppression.exists = originalExists;
    }
    assert.equal(gmail.calls.length, 0);
    const failed = await Delivery.find({ campaignId: campaign._id, status: 'failed' }).lean();
    assert.equal(failed.length, 1);
    assert.equal(failed[0].errorCode, 'SENDER_UNAVAILABLE');
    assert.equal(await countBy(campaign, { status: 'pending' }), 1);
    assert.equal((await statusOf(campaign)).status, 'paused');
  });

  it('an uncertain send is kept uncertain and pauses the campaign; resuming never sends it again', async () => {
    const sender = await makeSender();
    const campaign = await queue(sender, await makeContacts(3));
    gmail.answer = (n) => (n === 2 ? new Response('boom', { status: 500 }) : new Response(JSON.stringify({ id: `gm-${n}`, threadId: 't' }), { status: 200 }));
    await run(campaign);

    const paused = await statusOf(campaign);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'SEND_UNCERTAIN');
    const uncertain = await Delivery.findOne({ campaignId: campaign._id, errorCode: 'SEND_UNCERTAIN' }).lean();
    assert.ok(uncertain);
    assert.equal(gmail.calls.length, 2);

    gmail.answer = () => new Response(JSON.stringify({ id: 'gm-x', threadId: 't' }), { status: 200 });
    assert.equal((await api(`/campaigns/${campaign._id}/resume`)).status, 202);
    await sweep(campaign);

    assert.equal(gmail.calls.length, 3, 'only the one pending delivery was sent');
    assert.equal((await Delivery.findById(uncertain._id).lean()).errorCode, 'SEND_UNCERTAIN');
    assert.equal((await Delivery.findById(uncertain._id).lean()).attempts, 1);
    const done = await statusOf(campaign);
    assert.equal(done.status, 'sent');
    assert.equal(done.pauseReason, null);
  });

  it('reconnecting the same Google account does not resume the campaign by itself', async () => {
    const sender = await makeSender();
    const campaign = await queue(sender, await makeContacts(3));
    gmail.answer = async (n) => {
      if (n === 1) await SenderAccount.updateOne({ _id: sender._id }, { $set: { status: 'reauth_required', statusReason: 'TOKEN_REVOKED' } });
      return new Response(JSON.stringify({ id: 'gm', threadId: 't' }), { status: 200 });
    };
    await run(campaign);
    assert.equal((await statusOf(campaign)).status, 'paused');
    const sentBefore = gmail.calls.length;

    // "Reconnect": the same record is active again with fresh credentials
    await SenderAccount.updateOne({ _id: sender._id }, { $set: { status: 'active', statusReason: null, ...tokens(sender._id) }, $inc: { tokenGeneration: 1 } });
    await sweep(campaign);
    await recoverCampaign(campaign._id, { logger: quiet });
    await waitForCampaignDispatch(campaign._id);

    assert.equal((await statusOf(campaign)).status, 'paused');
    assert.equal(gmail.calls.length, sentBefore, 'nothing was sent without an explicit resume');
  });

  describe('explicit resume', () => {
    const pausedCampaign = async (extra = {}) => {
      const sender = await makeSender();
      const campaign = await queue(sender, await makeContacts(3));
      gmail.answer = async (n) => {
        if (n === 1) await SenderAccount.updateOne({ _id: sender._id }, { $set: { status: 'reauth_required', statusReason: 'TOKEN_REVOKED' } });
        return new Response(JSON.stringify({ id: 'gm', threadId: 't' }), { status: 200 });
      };
      await run(campaign);
      assert.equal((await statusOf(campaign)).status, 'paused', 'precondition');
      gmail.answer = () => new Response(JSON.stringify({ id: 'gm', threadId: 't' }), { status: 200 });
      return { sender, campaign, ...extra };
    };

    it('is refused while the locked sender is still unusable, and says why', async () => {
      const { campaign } = await pausedCampaign();
      const response = await api(`/campaigns/${campaign._id}/resume`);
      assert.equal(response.status, 409);
      assert.match((await response.json()).message, /no longer accepts|same Gmail account/i);
      assert.equal((await statusOf(campaign)).status, 'paused');
    });

    it('continues from the SAME sender once it is reconnected: only pending deliveries are sent', async () => {
      const { sender, campaign } = await pausedCampaign();
      const sentBefore = await countBy(campaign, { status: 'sent' });
      await SenderAccount.updateOne({ _id: sender._id }, { $set: { status: 'active', statusReason: null, ...tokens(sender._id) }, $inc: { tokenGeneration: 1 } });

      const response = await api(`/campaigns/${campaign._id}/resume`);
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.data.campaign.status, 'sending');
      assert.equal(body.data.campaign.pause, null);
      await sweep(campaign);

      const done = await statusOf(campaign);
      assert.equal(done.status, 'sent');
      assert.equal(await countBy(campaign, { status: 'sent' }), 3);
      assert.equal(sentBefore, 1);
      assert.equal(gmail.calls.length, 3, 'each recipient was submitted exactly once');
      assert.ok(gmail.calls.every((a) => a === `Bearer ya29.access-${sender._id}`));
    });

    it('is refused when the sender record no longer is the same Google account or address', async () => {
      const { sender, campaign } = await pausedCampaign();
      await SenderAccount.updateOne({ _id: sender._id }, { $set: { status: 'active', providerAccountId: 'sub-someone-else', ...tokens(sender._id) } });
      let response = await api(`/campaigns/${campaign._id}/resume`);
      assert.equal(response.status, 409);
      assert.match((await response.json()).message, /cannot be resumed from another account/i);

      await SenderAccount.updateOne({ _id: sender._id }, { $set: { providerAccountId: (await Campaign.findById(campaign._id)).dispatchSender.googleSub, email: 'renamed@example.com' } });
      response = await api(`/campaigns/${campaign._id}/resume`);
      assert.equal(response.status, 409);
      assert.equal((await statusOf(campaign)).status, 'paused');
    });

    it('cannot be redirected to another account: a different sender of the owner does not help', async () => {
      const { campaign } = await pausedCampaign();
      const other = await makeSender();
      await Campaign.collection.updateOne({ _id: campaign._id }, { $set: { senderAccountId: other._id } });
      const response = await api(`/campaigns/${campaign._id}/resume`);
      assert.equal(response.status, 409);
      assert.equal((await statusOf(campaign)).status, 'paused');
    });

    it('is owner-only and only for paused campaigns', async () => {
      const { sender, campaign } = await pausedCampaign();
      const stranger = await User.create({ name: 'Stranger', email: `s-${crypto.randomBytes(3).toString('hex')}@example.com`, passwordHash: 'x'.repeat(60) });
      assert.equal((await api(`/campaigns/${campaign._id}/resume`, { token: signAccessToken(stranger) })).status, 404);
      assert.equal((await api(`/campaigns/${campaign._id}/resume`, { token: null })).status, 401);
      assert.equal((await api(`/campaigns/${campaign._id}/resume`, { body: {} })).status, 400);

      const draft = await Campaign.create({ userId: owner._id, name: 'Draft one', subject: 'S', senderAccountId: sender._id });
      assert.equal((await api(`/campaigns/${draft._id}/resume`)).status, 409);
    });

    it('a paused campaign cannot be edited, deleted, sent or scheduled', async () => {
      const { campaign } = await pausedCampaign();
      assert.equal((await api(`/campaigns/${campaign._id}`, { method: 'PATCH', body: { name: 'New name' } })).status, 409);
      assert.equal((await api(`/campaigns/${campaign._id}`, { method: 'DELETE', body: undefined })).status, 409);
      assert.equal((await api(`/campaigns/${campaign._id}/send`)).status, 409);
      assert.equal(
        (await api(`/campaigns/${campaign._id}/schedule`, { body: { scheduledAt: new Date(Date.now() + 3600_000).toISOString() } })).status,
        409
      );
      assert.equal((await statusOf(campaign)).status, 'paused');
    });
  });

  describe('races', () => {
    it('a token refresh that finishes after a disconnect cannot restore the credentials', async () => {
      const sender = await makeSender(owner, {
        withTokens: (_id) => ({
          encryptedRefreshToken: sealRefreshToken(_id, '1//test-refresh'),
          encryptedAccessToken: sealAccessToken(_id, 'ya29.stale'),
          accessTokenExpiresAt: new Date(Date.now() - 60_000),
        }),
      });
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const oauth = async () => {
        await gate; // the refresh is in flight while the owner disconnects
        return new Response(JSON.stringify({ access_token: 'ya29.fresh', expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.send' }), { status: 200 });
      };
      const refreshing = getSenderAccessToken({ userId: owner._id, senderAccountId: sender._id, fetchImpl: oauth });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await disconnectSenderAccount({ userId: owner._id, accountId: sender._id, fetchImpl: async () => new Response('{}', { status: 200 }) });
      release();
      await assert.rejects(refreshing);

      const stored = await SenderAccount.findById(sender._id).select('+encryptedRefreshToken +encryptedAccessToken +accessTokenExpiresAt');
      assert.equal(stored.status, 'disconnected');
      assert.equal(stored.encryptedRefreshToken, null);
      assert.equal(stored.encryptedAccessToken, null);
      assert.equal(stored.accessTokenExpiresAt, null);
    });

    it('two resumes at once: exactly one takes effect', async () => {
      const sender = await makeSender();
      const campaign = await queue(sender, await makeContacts(2));
      await Campaign.collection.updateOne({ _id: campaign._id }, { $set: { status: 'paused', pauseReason: 'SENDER_DISCONNECTED', pausedAt: new Date(), dispatchSender: { accountId: sender._id, googleSub: sender.providerAccountId, email: sender.email } } });
      const results = await Promise.all([api(`/campaigns/${campaign._id}/resume`), api(`/campaigns/${campaign._id}/resume`)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
    });
  });
});
