/**
 * SMTP failure outcomes: a failed send is classified as 'rejected' (provably not accepted,
 * recorded TRANSPORT_ERROR) or 'uncertain' (the server may have accepted it, recorded
 * SEND_UNCERTAIN). Neither is ever sent again, whatever recovery or the watchdog do afterwards.
 *
 * The classification is checked three ways:
 * 1. against error objects shaped exactly like Nodemailer's;
 * 2. against the REAL Nodemailer SMTP client talking to a fake SMTP server on 127.0.0.1
 *    (loopback only; nothing leaves the machine and no real mailbox exists);
 * 3. end to end through dispatch, recovery and the watchdog, for every failure category.
 */
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('smtpoutcome');
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
import { installAutoSender } from './helpers/sender.js';
installAutoSender(Campaign);
import Delivery, { DELIVERY_ERROR_CODES } from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import {
  classifyTransportFailure,
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

const quiet = { log() {}, warn() {}, error() {} };
const FROM = 'MailPulse <no-reply@example.test>';

/** Error objects shaped as Nodemailer reports them (code, command, timeoutType, responseCode). */
const nodemailerError = (message, fields) => Object.assign(new Error(message), fields);

/**
 * Every failure category, the outcome it must get, and the delivery code it must be stored as.
 */
const CATEGORIES = [
  ['connect timeout', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'CONNECT_TIMEOUT' }, 'rejected', 'TRANSPORT_ERROR'],
  ['greeting timeout', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'GREETING_TIMEOUT' }, 'rejected', 'TRANSPORT_ERROR'],
  ['STARTTLS upgrade timeout', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'UPGRADE_TIMEOUT' }, 'rejected', 'TRANSPORT_ERROR'],
  ['connection refused', { code: 'ECONNECTION', originalCode: 'ECONNREFUSED', command: 'CONN' }, 'rejected', 'TRANSPORT_ERROR'],
  ['DNS failure', { code: 'EDNS', originalCode: 'ENOTFOUND', command: 'CONN' }, 'rejected', 'TRANSPORT_ERROR'],
  ['authentication failure', { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }, 'rejected', 'TRANSPORT_ERROR'],
  ['550 reply to RCPT TO', { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }, 'rejected', 'TRANSPORT_ERROR'],
  ['554 reply to the message body', { code: 'EMESSAGE', responseCode: 554, command: 'DATA' }, 'rejected', 'TRANSPORT_ERROR'],
  ['421 then close', { code: 'ECONNECTION', responseCode: 421, command: 'CONN' }, 'rejected', 'TRANSPORT_ERROR'],
  ['socket timeout', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' }, 'uncertain', 'SEND_UNCERTAIN'],
  ['timeout of unknown kind', { code: 'ETIMEDOUT' }, 'uncertain', 'SEND_UNCERTAIN'],
  ['connection closed without a reply', { code: 'ECONNECTION', command: 'CONN' }, 'uncertain', 'SEND_UNCERTAIN'],
  ['connection reset', { code: 'ESOCKET', originalCode: 'ECONNRESET', command: 'CONN' }, 'uncertain', 'SEND_UNCERTAIN'],
  ['protocol error', { code: 'EPROTOCOL', command: 'CONN' }, 'uncertain', 'SEND_UNCERTAIN'],
  ['unrecognised error', {}, 'uncertain', 'SEND_UNCERTAIN'],
];

describe('classifyTransportFailure (no DB)', () => {
  for (const [label, fields, outcome] of CATEGORIES) {
    it(`${label} -> ${outcome}`, () => {
      assert.equal(classifyTransportFailure(nodemailerError(label, fields)), outcome);
    });
  }

  it('anything that is not an error object is uncertain', () => {
    for (const value of [undefined, null, 'Timeout', 42]) {
      assert.equal(classifyTransportFailure(value), 'uncertain');
    }
  });

  it('a reply code outside 4xx/5xx proves nothing', () => {
    assert.equal(classifyTransportFailure(nodemailerError('x', { responseCode: 250 })), 'uncertain');
    assert.equal(classifyTransportFailure(nodemailerError('x', { responseCode: '550 text' })), 'uncertain');
  });

  it('an EmailTransportError is uncertain unless explicitly classified rejected', () => {
    assert.equal(new EmailTransportError().outcome, 'uncertain');
    assert.equal(new EmailTransportError('x', { outcome: 'bogus' }).outcome, 'uncertain');
    assert.equal(new EmailTransportError('x', { outcome: 'rejected' }).outcome, 'rejected');
  });

  it('the email service attaches the outcome, keeps the raw error internal, and never retries', async () => {
    for (const [label, fields, outcome] of CATEGORIES) {
      let calls = 0;
      const service = createEmailService({
        transport: {
          async sendMail() {
            calls += 1;
            throw nodemailerError(`secret-host.internal ${label}`, fields);
          },
        },
        from: FROM,
      });
      await assert.rejects(service.sendEmail({ to: 'a@example.test', subject: 'S', text: 'T' }), (error) => {
        assert.ok(error instanceof EmailTransportError, label);
        assert.equal(error.outcome, outcome, label);
        assert.ok(!error.message.includes('secret-host'), 'raw transport text is not in the message');
        return true;
      });
      assert.equal(calls, 1, `${label}: exactly one attempt`);
    }
  });

  it('SEND_UNCERTAIN is a stored delivery error code', () => {
    assert.ok(DELIVERY_ERROR_CODES.includes('SEND_UNCERTAIN'));
  });
});

/**
 * A minimal SMTP server on 127.0.0.1, for driving the real Nodemailer client into each failure.
 * `behaviour` decides what happens: 'accept', 'no-greeting', 'reject-rcpt', 'reject-data',
 * 'silent-after-data' (body received, final reply never sent) or 'close-after-data' (body
 * received, connection dropped before the reply).
 */
const startFakeSmtp = (behaviour) =>
  new Promise((resolve) => {
    const sockets = new Set();
    const stats = { messagesReceived: 0 };
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      if (behaviour === 'no-greeting') return;
      socket.write('220 fake.test ESMTP\r\n');
      let buffer = '';
      let inData = false;
      const onEndOfData = () => {
        stats.messagesReceived += 1;
        if (behaviour === 'accept') socket.write('250 2.0.0 Queued\r\n');
        else if (behaviour === 'reject-data') socket.write('554 5.7.1 Rejected\r\n');
        else if (behaviour === 'close-after-data') socket.destroy();
        // 'silent-after-data': never answer
      };
      socket.on('data', (chunk) => {
        buffer += chunk.toString('latin1');
        let index;
        while ((index = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              onEndOfData();
            }
            continue;
          }
          const command = line.slice(0, 4).toUpperCase();
          if (command === 'EHLO') socket.write('250-fake.test\r\n250 8BITMIME\r\n');
          else if (command === 'HELO') socket.write('250 fake.test\r\n');
          else if (command === 'MAIL') socket.write('250 OK\r\n');
          else if (command === 'RCPT') socket.write(behaviour === 'reject-rcpt' ? '550 5.1.1 No such user\r\n' : '250 OK\r\n');
          else if (command === 'DATA') {
            inData = true;
            socket.write('354 Go ahead\r\n');
          } else if (command === 'RSET') socket.write('250 OK\r\n');
          else if (command === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else socket.write('502 Not implemented\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        stats,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      })
    );
  });

/** A port on 127.0.0.1 that nothing listens on. */
const closedPort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Sends one message through the REAL Nodemailer SMTP client; resolves to the result or error. */
const sendThroughRealClient = async (port, timeouts) => {
  // NODE_ENV is passed explicitly: the guard against real transports in tests stays in force for
  // everything else, and this transport can only reach the loopback fake server.
  const transport = createSmtpTransport(
    { host: '127.0.0.1', port, secure: false, timeouts },
    { env: { NODE_ENV: 'production' } }
  );
  try {
    const service = createEmailService({ transport, from: FROM });
    return await service.sendEmail({ to: 'someone@example.test', subject: 'S', text: 'T' }).then(
      (result) => ({ result }),
      (error) => ({ error })
    );
  } finally {
    transport.close();
  }
};

describe('Real Nodemailer client against a loopback fake SMTP server (no DB)', () => {
  const fast = { connectionTimeout: 1000, greetingTimeout: 1000, socketTimeout: 1000 };

  it('control: a 250 after the body is a successful send', async () => {
    const fake = await startFakeSmtp('accept');
    try {
      const { result, error } = await sendThroughRealClient(fake.port, fast);
      assert.equal(error, undefined);
      assert.ok(result.messageId);
      assert.equal(fake.stats.messagesReceived, 1);
    } finally {
      await fake.close();
    }
  });

  it('connection refused -> rejected (nothing was ever connected)', async () => {
    const { error } = await sendThroughRealClient(await closedPort(), fast);
    assert.ok(error instanceof EmailTransportError);
    assert.equal(error.cause.originalCode || error.cause.code, 'ECONNREFUSED');
    assert.equal(error.outcome, 'rejected');
  });

  it('no greeting -> GREETING_TIMEOUT -> rejected (no message data was sent)', async () => {
    const fake = await startFakeSmtp('no-greeting');
    try {
      const { error } = await sendThroughRealClient(fake.port, { ...fast, greetingTimeout: 300, socketTimeout: 5000 });
      assert.ok(error instanceof EmailTransportError);
      assert.equal(error.cause.timeoutType, 'GREETING_TIMEOUT');
      assert.equal(error.outcome, 'rejected');
      assert.equal(fake.stats.messagesReceived, 0);
    } finally {
      await fake.close();
    }
  });

  it('550 to RCPT TO -> rejected', async () => {
    const fake = await startFakeSmtp('reject-rcpt');
    try {
      const { error } = await sendThroughRealClient(fake.port, fast);
      assert.equal(error.cause.responseCode, 550);
      assert.equal(error.outcome, 'rejected');
      assert.equal(fake.stats.messagesReceived, 0);
    } finally {
      await fake.close();
    }
  });

  it('554 after the body -> rejected', async () => {
    const fake = await startFakeSmtp('reject-data');
    try {
      const { error } = await sendThroughRealClient(fake.port, fast);
      assert.equal(error.cause.responseCode, 554);
      assert.equal(error.outcome, 'rejected');
    } finally {
      await fake.close();
    }
  });

  it('body received, then silence -> SOCKET_TIMEOUT -> uncertain', async () => {
    const fake = await startFakeSmtp('silent-after-data');
    try {
      const { error } = await sendThroughRealClient(fake.port, { ...fast, socketTimeout: 300 });
      assert.ok(error instanceof EmailTransportError);
      assert.equal(error.cause.timeoutType, 'SOCKET_TIMEOUT');
      assert.equal(error.outcome, 'uncertain');
      assert.equal(fake.stats.messagesReceived, 1, 'the server had the whole message');
    } finally {
      await fake.close();
    }
  });

  it('body received, then the connection drops -> uncertain', async () => {
    const fake = await startFakeSmtp('close-after-data');
    try {
      const { error } = await sendThroughRealClient(fake.port, fast);
      assert.ok(error instanceof EmailTransportError);
      assert.equal(error.outcome, 'uncertain');
      assert.equal(fake.stats.messagesReceived, 1, 'the server had the whole message');
    } finally {
      await fake.close();
    }
  });
});

describe('Every failure category through dispatch, recovery and the watchdog', () => {
  let isDbConnected = false;
  let owner;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Outcome Owner', email: `outcome-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[SMTP outcome tests] MongoDB unavailable: ${err.message}`);
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

  for (const [label, fields, , expectedCode] of CATEGORIES) {
    it(`${label}: recorded ${expectedCode} once, never re-sent by recovery or the watchdog`, async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await Contact.insertMany(
        ['Fails', 'Delivered One', 'Delivered Two'].map((name, i) => ({
          userId: owner._id,
          name,
          email: `oc${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
        }))
      );
      const failing = contacts[0].email;
      const inner = createMockTransport();
      const attempts = new Map();
      const emailService = createEmailService({
        transport: {
          async sendMail(message) {
            attempts.set(message.to, (attempts.get(message.to) || 0) + 1);
            if (message.to === failing) throw nodemailerError(label, fields);
            return inner.sendMail(message);
          },
        },
        from: FROM,
      });
      const campaign = await Campaign.create({
        userId: owner._id,
        name: `Outcome: ${label}`,
        subject: 'Hello',
        textContent: 'Body',
        htmlContent: '<p>Body</p>',
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 1000), // due: only due scheduled campaigns can be locked
        recipientIds: contacts.map((c) => c._id),
      });

      assert.ok(await startCampaignDispatch({ campaign, userId: owner._id, eligibleContacts: contacts, emailService, logger: quiet }));
      await waitForCampaignDispatch(campaign._id);

      const recorded = await Delivery.findOne({ campaignId: campaign._id, email: failing }).lean();
      assert.equal(recorded.status, 'failed');
      assert.equal(recorded.errorCode, expectedCode);
      assert.equal(recorded.attempts, 1);
      const done = await Campaign.findById(campaign._id).lean();
      assert.equal(done.status, 'sent');
      assert.deepEqual({ sent: done.stats.sent, failed: done.stats.failed }, { sent: 2, failed: 1 });

      // Force the campaign back into a recoverable state, then run recovery and a watchdog sweep
      await mongoose.connection
        .collection('campaigns')
        .updateOne({ _id: campaign._id }, { $set: { status: 'sending', dispatchLeaseUntil: new Date(Date.now() - 1000) } });
      await recoverCampaign(campaign._id, { emailService, logger: quiet });
      await waitForCampaignDispatch(campaign._id);
      await mongoose.connection
        .collection('campaigns')
        .updateOne({ _id: campaign._id }, { $set: { status: 'sending', dispatchLeaseUntil: new Date(Date.now() - 1000) } });
      await reapStalledCampaigns({ emailService, logger: quiet, stallTimeoutMs: 1 });
      await waitForCampaignDispatch(campaign._id);

      assert.equal(attempts.get(failing), 1, 'the failed recipient was attempted exactly once');
      assert.equal(attempts.get(contacts[1].email), 1);
      assert.equal(attempts.get(contacts[2].email), 1);
      const after = await Delivery.findOne({ campaignId: campaign._id, email: failing }).lean();
      assert.equal(after.status, 'failed');
      assert.equal(after.errorCode, expectedCode, 'recovery and the watchdog never rewrite the outcome');
      assert.equal(after.attempts, 1);
    });
  }
});
