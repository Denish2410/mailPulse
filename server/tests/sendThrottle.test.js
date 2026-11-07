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

import { describe, it, before, after } from 'node:test';
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
  getSendRatePerMinute,
  createSendThrottle,
  getSharedSendThrottle,
  MAX_SEND_RATE_PER_MINUTE,
} from '../src/services/sendThrottle.service.js';

describe('Send throttle (no DB)', () => {
  it('parses the configured rate safely', () => {
    assert.equal(getSendRatePerMinute({}), 0);
    assert.equal(getSendRatePerMinute({ CAMPAIGN_SEND_RATE_PER_MINUTE: '' }), 0);
    assert.equal(getSendRatePerMinute({ CAMPAIGN_SEND_RATE_PER_MINUTE: 'abc' }), 0);
    assert.equal(getSendRatePerMinute({ CAMPAIGN_SEND_RATE_PER_MINUTE: '-5' }), 0);
    assert.equal(getSendRatePerMinute({ CAMPAIGN_SEND_RATE_PER_MINUTE: '1.5' }), 0);
    assert.equal(getSendRatePerMinute({ CAMPAIGN_SEND_RATE_PER_MINUTE: '120' }), 120);
    assert.equal(getSendRatePerMinute({ CAMPAIGN_SEND_RATE_PER_MINUTE: '999999999' }), MAX_SEND_RATE_PER_MINUTE);
  });

  it('does not wait when disabled', async () => {
    const sleeps = [];
    const throttle = createSendThrottle(0, { sleep: async (ms) => sleeps.push(ms) });
    await throttle.wait();
    await throttle.wait();
    assert.deepEqual(sleeps, []);
  });

  it('spaces slots evenly, including concurrent callers', async () => {
    let clock = 1000;
    const sleeps = [];
    const throttle = createSendThrottle(60, { now: () => clock, sleep: async (ms) => sleeps.push(ms) });
    await Promise.all([throttle.wait(), throttle.wait(), throttle.wait(), throttle.wait()]);
    // 60/min => one slot per 1000ms: first immediate, then +1000, +2000, +3000
    assert.deepEqual(sleeps, [1000, 2000, 3000]);

    clock = 20000; // long idle: schedule resets to "now", no burst credit
    sleeps.length = 0;
    await throttle.wait();
    await throttle.wait();
    assert.deepEqual(sleeps, [1000]);
  });

  it('cancel releases waiting callers immediately', async () => {
    const throttle = createSendThrottle(1); // one per minute
    await throttle.wait(); // first slot is immediate
    let released = false;
    const waiting = throttle.wait().then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(released, false);
    throttle.cancel();
    await waiting;
    assert.equal(released, true);
  });

  it('recreates the shared throttle when the configured rate changes', () => {
    const a = getSharedSendThrottle({ CAMPAIGN_SEND_RATE_PER_MINUTE: '30' });
    assert.equal(getSharedSendThrottle({ CAMPAIGN_SEND_RATE_PER_MINUTE: '30' }), a);
    const b = getSharedSendThrottle({ CAMPAIGN_SEND_RATE_PER_MINUTE: '60' });
    assert.notEqual(a, b);
    assert.equal(b.ratePerMinute, 60);
    getSharedSendThrottle({});
  });
});

describe('Throttled dispatch', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `thr-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let user;
  let token;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Throttle Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      user = await User.create({ name: 'Thr User', email: `${prefix}@example.com`, passwordHash: await hashPassword('StrongPassword123!') });
      token = signAccessToken(user);
    }
  });

  after(async () => {
    delete process.env.CAMPAIGN_SEND_RATE_PER_MINUTE;
    getSharedSendThrottle({});
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Delivery.deleteMany({ userId: user._id });
      await Campaign.deleteMany({ userId: user._id });
      await Contact.deleteMany({ userId: user._id });
      await User.deleteMany({ _id: user._id });
      await mongoose.disconnect();
    }
  });

  it('delivers everything but no faster than the configured rate', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
    // 6000/min => 10ms between sends. Kept tiny on purpose: test files share one database and run
    // in parallel, and other suites recover campaigns left in 'sending', so a long-running
    // dispatch here would be raced by them.
    process.env.CAMPAIGN_SEND_RATE_PER_MINUTE = '6000';

    const contacts = await Contact.insertMany(
      Array.from({ length: 4 }, (_, i) => ({ userId: user._id, name: `Person ${i}`, email: `${prefix}-p${i}@example.com` }))
    );
    const campaign = await Campaign.create({
      userId: user._id,
      name: 'Throttled',
      subject: 'S',
      textContent: 'Body',
      recipientIds: contacts.map((c) => c._id),
    });

    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(res.status, 202);
    await waitForCampaignDispatch(campaign._id);
    const elapsed = Date.now() - started;

    assert.equal(transport.count, 4);
    assert.equal((await Campaign.findById(campaign._id)).status, 'sent');
    // 4 sends need 3 gaps of 10ms
    assert.ok(elapsed >= 25, `expected >= 25ms, got ${elapsed}`);
  });
});
