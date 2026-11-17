/**
 * SMTP timeouts: bounded, validated, passed to the real transport, and a send that timed out
 * after the message was handed over is recorded SEND_UNCERTAIN and NEVER retried. No network I/O:
 * the real transport is only constructed (Nodemailer connects lazily), and sends use a mock
 * transport. Each timeout category is covered in smtpOutcome.test.js.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('smtptimeouts');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import {
  SMTP_TIMEOUT_DEFAULTS_MS,
  SMTP_TIMEOUT_BOUNDS_MS,
  getSmtpTimeouts,
  getSmtpConfig,
  createSmtpTransport,
  createEmailService,
  createMockTransport,
  EmailTransportError,
} from '../src/services/email.service.js';
import {
  startCampaignDispatch,
  waitForCampaignDispatch,
  recoverCampaign,
  reapStalledCampaigns,
} from '../src/services/campaignDispatch.service.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, getShutdownTimeoutMs } from '../src/config/shutdown.js';

const quiet = { log() {}, warn() {}, error() {} };
const baseEnv = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', EMAIL_FROM: 'MailPulse <no-reply@example.test>' };

/** Nodemailer's socket inactivity timeout, which can fire after the server accepted the message. */
const smtpTimeoutError = () =>
  Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' });

describe('SMTP timeout configuration (no DB)', () => {
  it('uses bounded defaults, each phase shorter than the default shutdown timeout', () => {
    assert.deepEqual(getSmtpTimeouts({}), SMTP_TIMEOUT_DEFAULTS_MS);
    assert.equal(getShutdownTimeoutMs({}), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    for (const value of Object.values(SMTP_TIMEOUT_DEFAULTS_MS)) {
      assert.ok(value < DEFAULT_SHUTDOWN_TIMEOUT_MS, `${value} ms is not below the shutdown timeout`);
      assert.ok(value >= SMTP_TIMEOUT_BOUNDS_MS.min && value <= SMTP_TIMEOUT_BOUNDS_MS.max);
    }
  });

  it('accepts overrides inside the bounds, and treats empty values as unset', () => {
    assert.deepEqual(
      getSmtpTimeouts({ SMTP_CONNECTION_TIMEOUT_MS: '5000', SMTP_GREETING_TIMEOUT_MS: ' 7000 ', SMTP_SOCKET_TIMEOUT_MS: '120000' }),
      { connectionTimeout: 5000, greetingTimeout: 7000, socketTimeout: 120000 }
    );
    assert.deepEqual(
      getSmtpTimeouts({ SMTP_CONNECTION_TIMEOUT_MS: '', SMTP_GREETING_TIMEOUT_MS: '   ', SMTP_SOCKET_TIMEOUT_MS: '1000' }),
      { ...SMTP_TIMEOUT_DEFAULTS_MS, socketTimeout: 1000 }
    );
  });

  it('fails closed on any invalid value', () => {
    for (const name of ['SMTP_CONNECTION_TIMEOUT_MS', 'SMTP_GREETING_TIMEOUT_MS', 'SMTP_SOCKET_TIMEOUT_MS']) {
      for (const bad of ['0', '999', '120001', '-5', '1.5', 'abc', '1e4', 'Infinity']) {
        assert.throws(() => getSmtpTimeouts({ [name]: bad }), { name: 'EmailConfigurationError', message: new RegExp(name) }, `${name}=${bad}`);
        assert.throws(() => getSmtpConfig({ ...baseEnv, [name]: bad }), { name: 'EmailConfigurationError' });
      }
    }
  });

  it('getSmtpConfig carries the timeouts', () => {
    assert.deepEqual(getSmtpConfig(baseEnv).timeouts, SMTP_TIMEOUT_DEFAULTS_MS);
    assert.equal(getSmtpConfig({ ...baseEnv, SMTP_SOCKET_TIMEOUT_MS: '8000' }).timeouts.socketTimeout, 8000);
  });

  it('the real SMTP transport is created with the configured timeouts (no connection is made)', () => {
    const config = getSmtpConfig({ ...baseEnv, SMTP_CONNECTION_TIMEOUT_MS: '4000', SMTP_GREETING_TIMEOUT_MS: '5000', SMTP_SOCKET_TIMEOUT_MS: '6000' });
    const transport = createSmtpTransport(config, { env: { NODE_ENV: 'production' } });
    try {
      assert.equal(transport.options.connectionTimeout, 4000);
      assert.equal(transport.options.greetingTimeout, 5000);
      assert.equal(transport.options.socketTimeout, 6000);
    } finally {
      transport.close();
    }
  });

  it('a config without timeouts (older callers) still gets the bounded defaults', () => {
    const transport = createSmtpTransport({ host: 'smtp.example.test', port: 587, secure: false }, { env: { NODE_ENV: 'production' } });
    try {
      assert.equal(transport.options.connectionTimeout, SMTP_TIMEOUT_DEFAULTS_MS.connectionTimeout);
      assert.equal(transport.options.greetingTimeout, SMTP_TIMEOUT_DEFAULTS_MS.greetingTimeout);
      assert.equal(transport.options.socketTimeout, SMTP_TIMEOUT_DEFAULTS_MS.socketTimeout);
    } finally {
      transport.close();
    }
  });

  it('a transport timeout surfaces as a sanitized EmailTransportError after exactly one attempt', async () => {
    let calls = 0;
    const service = createEmailService({
      transport: {
        async sendMail() {
          calls += 1;
          throw smtpTimeoutError();
        },
      },
      from: 'MailPulse <no-reply@example.test>',
    });
    await assert.rejects(service.sendEmail({ to: 'a@example.test', subject: 'S', text: 'T' }), (error) => {
      assert.ok(error instanceof EmailTransportError);
      return true;
    });
    assert.equal(calls, 1, 'the email service never retries a send');
  });
});

describe('A timed-out send is recorded uncertain and is never retried', () => {
  let isDbConnected = false;
  let owner;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Timeout Owner', email: `timeout-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[SMTP timeout tests] MongoDB unavailable: ${err.message}`);
    }
  });

  afterEach(async () => {
    if (isDbConnected) {
      const campaigns = await Campaign.find({}).select('_id').lean();
      await Promise.all(campaigns.map((c) => waitForCampaignDispatch(c._id)));
      await Delivery.deleteMany({});
      await Campaign.deleteMany({});
      await Contact.deleteMany({});
    }
  });

  after(async () => {
    if (isDbConnected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  it('records SEND_UNCERTAIN once and never re-sends, even across recovery and watchdog sweeps', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await Contact.insertMany(
      ['Times Out', 'Delivered One', 'Delivered Two'].map((name, i) => ({
        userId: owner._id,
        name,
        email: `to${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );
    const timedOut = contacts[0].email;
    const inner = createMockTransport();
    const attempts = new Map();
    const emailService = createEmailService({
      transport: {
        async sendMail(message) {
          attempts.set(message.to, (attempts.get(message.to) || 0) + 1);
          if (message.to === timedOut) throw smtpTimeoutError();
          return inner.sendMail(message);
        },
      },
      from: 'MailPulse <no-reply@example.test>',
    });
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Timeout campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000), // due: only due scheduled campaigns can be locked
      recipientIds: contacts.map((c) => c._id),
    });

    assert.ok(await startCampaignDispatch({ campaign, userId: owner._id, eligibleContacts: contacts, emailService, logger: quiet }));
    await waitForCampaignDispatch(campaign._id);

    const failed = await Delivery.findOne({ campaignId: campaign._id, email: timedOut }).lean();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'SEND_UNCERTAIN');
    assert.equal(failed.attempts, 1);
    const done = await Campaign.findById(campaign._id).lean();
    assert.equal(done.status, 'sent');
    assert.deepEqual({ sent: done.stats.sent, failed: done.stats.failed }, { sent: 2, failed: 1 });

    // Nothing can make it go out again: a forced recovery and a watchdog sweep find no work
    await mongoose.connection.collection('campaigns').updateOne({ _id: campaign._id }, { $set: { status: 'sending', dispatchLeaseUntil: new Date(Date.now() - 1000) } });
    await recoverCampaign(campaign._id, { emailService, logger: quiet });
    await waitForCampaignDispatch(campaign._id);
    await reapStalledCampaigns({ emailService, logger: quiet, stallTimeoutMs: 1 });
    await waitForCampaignDispatch(campaign._id);

    assert.equal(attempts.get(timedOut), 1, 'the timed-out recipient was attempted exactly once');
    assert.equal(attempts.get(contacts[1].email), 1);
    assert.equal(attempts.get(contacts[2].email), 1);
    assert.equal((await Delivery.findOne({ campaignId: campaign._id, email: timedOut }).lean()).status, 'failed');
  });
});
