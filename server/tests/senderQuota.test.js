/**
 * Conservative per-sender limits: the daily cap (atomic, shared across processes), the pacing,
 * and what reaching the cap does to a dispatch. No sender rotation, no spreading over accounts.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('senderquota');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.TOKEN_ENCRYPTION_KEYS = `quota-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;
delete process.env.SMTP_HOST;

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import SenderAccount from '../src/models/SenderAccount.js';
import SenderUsage from '../src/models/SenderUsage.js';
import { connectDB } from '../src/config/db.js';
import { GOOGLE_ENDPOINTS } from '../src/config/googleOAuth.js';
import { resetTokenCipher } from '../src/utils/tokenCrypto.js';
import { sealAccessToken, sealRefreshToken } from '../src/services/senderAccount.service.js';
import { setGmailHttpClient } from '../src/services/gmailTransport.service.js';
import { pollScheduledCampaigns } from '../src/services/campaignScheduler.service.js';
import { waitForCampaignDispatch, resetDispatcherState, stopAllDispatches } from '../src/services/campaignDispatch.service.js';
import {
  getSenderLimits,
  reserveDailySlot,
  releaseDailySlot,
  waitForSenderSlot,
  cancelSenderPacers,
  utcDay,
  DEFAULT_DAILY_LIMIT,
  MAX_DAILY_LIMIT,
  DEFAULT_RATE_PER_MINUTE,
  MAX_RATE_PER_MINUTE,
} from '../src/services/senderQuota.service.js';
import { createTestSender } from './helpers/sender.js';

resetTokenCipher();
const quiet = { log() {}, warn() {}, error() {} };

describe('Sender limits (conservative, per account)', () => {
  it('defaults are well below Google\'s ceilings and configured values are clamped', () => {
    assert.deepEqual(getSenderLimits({}), { dailyLimit: DEFAULT_DAILY_LIMIT, ratePerMinute: DEFAULT_RATE_PER_MINUTE });
    assert.ok(DEFAULT_DAILY_LIMIT <= 150 && MAX_DAILY_LIMIT < 500);
    assert.equal(getSenderLimits({ GMAIL_SENDER_DAILY_LIMIT: '100000' }).dailyLimit, MAX_DAILY_LIMIT);
    assert.equal(getSenderLimits({ GMAIL_SENDER_RATE_PER_MINUTE: '100000' }).ratePerMinute, MAX_RATE_PER_MINUTE);
    assert.equal(getSenderLimits({ GMAIL_SENDER_DAILY_LIMIT: 'abc' }).dailyLimit, DEFAULT_DAILY_LIMIT);
    assert.equal(getSenderLimits({ GMAIL_SENDER_DAILY_LIMIT: '-5' }).dailyLimit, DEFAULT_DAILY_LIMIT);
    assert.equal(getSenderLimits({ GMAIL_SENDER_RATE_PER_MINUTE: '0' }).ratePerMinute, 0);
  });
});

describe('Sender quota and dispatch', () => {
  let isDbConnected = false;
  let owner;
  let gmailCalls;

  const makeSender = () =>
    createTestSender(owner._id, {
      withTokens: (_id) => ({
        encryptedRefreshToken: sealRefreshToken(_id, '1//test-refresh'),
        encryptedAccessToken: sealAccessToken(_id, `ya29.access-${_id}`),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      }),
    });
  const makeContacts = (n) =>
    Contact.insertMany(Array.from({ length: n }, (_, i) => ({ userId: owner._id, name: `P${i}`, email: `q${i}-${crypto.randomBytes(3).toString('hex')}@example.com` })));
  const queue = (sender, contacts) =>
    Campaign.create({
      userId: owner._id, name: 'Quota campaign', subject: 'Hi', textContent: 'Body', status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000), recipientIds: contacts.map((c) => c._id), senderAccountId: sender._id,
    });
  const run = async (campaign) => {
    await pollScheduledCampaigns({ logger: quiet });
    await waitForCampaignDispatch(campaign._id);
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), SenderUsage.init(), SenderAccount.init(), Delivery.init()]);
    } catch (error) {
      console.warn(`[Sender quota tests] MongoDB unavailable: ${error.message}`);
    }
  });

  beforeEach(async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Promise.all([Campaign.deleteMany({}), Delivery.deleteMany({}), Contact.deleteMany({}), SenderAccount.deleteMany({}), SenderUsage.deleteMany({}), User.deleteMany({})]);
    owner = await User.create({ name: 'Owner', email: `o-${crypto.randomBytes(3).toString('hex')}@example.com`, passwordHash: 'x'.repeat(60) });
    resetDispatcherState();
    gmailCalls = [];
    setGmailHttpClient(async (url, init) => {
      assert.equal(url, GOOGLE_ENDPOINTS.gmailSend);
      gmailCalls.push(init.headers.Authorization);
      return new Response(JSON.stringify({ id: 'gm', threadId: 't' }), { status: 200 });
    });
  });

  afterEach(async () => {
    setGmailHttpClient(null);
    delete process.env.GMAIL_SENDER_DAILY_LIMIT;
    cancelSenderPacers();
    if (isDbConnected) await stopAllDispatches();
  });

  after(async () => {
    if (isDbConnected) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('reserves slots atomically up to the limit even under concurrency', async () => {
    const sender = await makeSender();
    const env = { GMAIL_SENDER_DAILY_LIMIT: '7' };
    const results = await Promise.all(Array.from({ length: 25 }, () => reserveDailySlot(sender._id, { env })));
    assert.equal(results.filter((r) => r.ok).length, 7);
    assert.equal((await SenderUsage.findOne({ senderAccountId: sender._id })).count, 7);
    assert.equal((await reserveDailySlot(sender._id, { env })).ok, false);
    await releaseDailySlot(sender._id);
    assert.equal((await reserveDailySlot(sender._id, { env })).ok, true);
  });

  it('counts per sender account and per UTC day', async () => {
    const a = await makeSender();
    const b = await makeSender();
    const env = { GMAIL_SENDER_DAILY_LIMIT: '2' };
    await reserveDailySlot(a._id, { env });
    await reserveDailySlot(a._id, { env });
    assert.equal((await reserveDailySlot(a._id, { env })).ok, false);
    assert.equal((await reserveDailySlot(b._id, { env })).ok, true, 'another sender has its own allowance');
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    assert.notEqual(utcDay(tomorrow), utcDay());
    assert.equal((await reserveDailySlot(a._id, { env, now: tomorrow })).ok, true);
  });

  it('paces a sender evenly and keeps senders independent', async () => {
    const env = { GMAIL_SENDER_RATE_PER_MINUTE: '60' }; // one per second
    const started = Date.now();
    await waitForSenderSlot('sender-a', { env });
    await waitForSenderSlot('sender-b', { env }); // other sender: no wait
    assert.ok(Date.now() - started < 500);
    await waitForSenderSlot('sender-a', { env }); // same sender: next slot ~1s later
    assert.ok(Date.now() - started >= 900);
  });

  it('stops sending when the daily limit is reached: the rest stay pending, nothing goes to another account', async () => {
    process.env.GMAIL_SENDER_DAILY_LIMIT = '2';
    const sender = await makeSender();
    const spare = await makeSender(); // must never be used to continue the campaign
    const campaign = await queue(sender, await makeContacts(5));
    await run(campaign);

    assert.equal(gmailCalls.length, 2);
    assert.ok(gmailCalls.every((a) => a === `Bearer ya29.access-${sender._id}`));
    assert.ok(!gmailCalls.includes(`Bearer ya29.access-${spare._id}`));
    const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
    assert.equal(deliveries.filter((d) => d.status === 'sent').length, 2);
    assert.equal(deliveries.filter((d) => d.status === 'pending').length, 3);
    assert.equal(deliveries.filter((d) => d.status === 'failed').length, 0, 'no claimed delivery was lost to the stop');
    assert.equal((await SenderUsage.findOne({ senderAccountId: sender._id })).count, 2);
    assert.equal(await SenderUsage.countDocuments({ senderAccountId: spare._id }), 0);
  });

  it('gives the slot back when no delivery was claimed, so a finished campaign does not burn quota', async () => {
    const sender = await makeSender();
    const campaign = await queue(sender, await makeContacts(2));
    await run(campaign);
    assert.equal(gmailCalls.length, 2);
    // two sends + the final probe that found nothing to claim: only the two sends stay counted
    assert.equal((await SenderUsage.findOne({ senderAccountId: sender._id })).count, 2);
  });
});
