/**
 * The standalone worker (src/worker.js): configuration, health endpoint, startup (which resumes
 * interrupted campaigns) and ordered shutdown. Real MongoDB (isolated database); mock transport
 * only, no email is sent. The health endpoint listens on 127.0.0.1 on a free port.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('worker');
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
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  waitForCampaignDispatch,
  resetDispatcherState,
} from '../src/services/campaignDispatch.service.js';
import { isCampaignSchedulerRunning } from '../src/services/campaignScheduler.service.js';
import { isDispatchRuntimeRunning, stopDispatchRuntime } from '../src/services/dispatchRuntime.service.js';
import {
  DEFAULT_WORKER_HEALTH_PORT,
  getWorkerHealthPort,
  getWorkerHealth,
  startWorker,
  createWorkerShutdownHandler,
  resetWorkerState,
} from '../src/worker.js';
import { manifestFieldsFor } from './helpers/manifest.js';
import { waitFor } from './helpers/childHarness.js';

const quiet = { log() {}, warn() {}, error() {} };

describe('Worker configuration (no DB)', () => {
  it('WORKER_HEALTH_PORT: default 5001, explicit values, fails closed on anything else', () => {
    assert.equal(getWorkerHealthPort({}), DEFAULT_WORKER_HEALTH_PORT);
    assert.equal(getWorkerHealthPort({ WORKER_HEALTH_PORT: ' ' }), DEFAULT_WORKER_HEALTH_PORT);
    assert.equal(getWorkerHealthPort({ WORKER_HEALTH_PORT: '6001' }), 6001);
    assert.equal(getWorkerHealthPort({ WORKER_HEALTH_PORT: '0' }), 0);
    for (const bad of ['-1', '65536', '1.5', 'abc', '1e3']) {
      assert.throws(() => getWorkerHealthPort({ WORKER_HEALTH_PORT: bad }), /WORKER_HEALTH_PORT/, bad);
    }
  });
});

describe('Worker process', () => {
  let isDbConnected = false;
  let owner;
  let transport;
  let emailService;
  let server = null;

  const healthUrl = (pathname = '/health') => `http://127.0.0.1:${server.address().port}${pathname}`;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Worker Owner', email: `worker-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Worker tests] MongoDB unavailable: ${err.message}`);
    }
  });

  afterEach(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    server = null;
    await stopDispatchRuntime();
    resetDispatcherState();
    resetWorkerState();
    if (isDbConnected) {
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

  const start = () => {
    transport = createMockTransport();
    emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
    return startWorker({ connectDB: async () => {}, port: 0, emailService, logger: quiet, validateConfig: false });
  };

  it('starts the dispatch runtime and reports ready on GET /health (loopback only, no details leaked)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    server = await start();
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(isDispatchRuntimeRunning(), true);
    assert.equal(isCampaignSchedulerRunning(), true);

    const res = await fetch(healthUrl());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { status: 'ready', database: true, runtime: true, shuttingDown: false });

    const other = await fetch(healthUrl('/api/v1/campaigns'));
    assert.equal(other.status, 404, 'the worker serves no API');
    const post = await fetch(healthUrl(), { method: 'POST' });
    assert.equal(post.status, 404);
  });

  it('resumes a campaign interrupted by a previous process as soon as it starts', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await Contact.insertMany(
      ['Resume One', 'Resume Two'].map((name, i) => ({
        userId: owner._id,
        name,
        email: `wk${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Interrupted',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sending',
      sendStartedAt: new Date(),
      recipientIds: contacts.map((c) => c._id),
      stats: { total: 2, sent: 0, failed: 0 },
      dispatchLeaseOwner: 'dead-process',
      dispatchLeaseEpoch: 1,
      dispatchLeaseUntil: new Date(Date.now() - 5000),
      ...manifestFieldsFor(contacts),
    });
    await Delivery.insertMany(
      contacts.map((c) => ({ campaignId: campaign._id, userId: owner._id, contactId: c._id, email: c.email, name: c.name, status: 'pending' }))
    );

    server = await start();
    await waitFor(async () => (await Campaign.findById(campaign._id).lean()).status === 'sent', { timeoutMs: 10000 });
    await waitForCampaignDispatch(campaign._id);
    assert.equal(transport.count, 2);
  });

  it('shutdown: health turns not_ready, the endpoint closes, the runtime stops, then MongoDB closes', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    server = await start();
    const steps = [];
    let exitCode = null;
    const fakeMongoose = {
      connection: {
        readyState: 1,
        close: async () => {
          steps.push(`mongo-closed runtime=${isDispatchRuntimeRunning()} listening=${server.listening}`);
        },
      },
    };
    const shutdown = createWorkerShutdownHandler({
      mongooseInstance: fakeMongoose,
      exitFn: (code) => {
        exitCode = code;
      },
      timeoutMs: 10000,
      logger: quiet,
    });

    const done = shutdown('SIGTERM');
    assert.equal(getWorkerHealth().ready, false, 'not ready from the moment shutdown starts');
    assert.equal(getWorkerHealth().body.shuttingDown, true);
    await done;

    assert.equal(exitCode, 0);
    assert.equal(server.listening, false);
    assert.equal(isDispatchRuntimeRunning(), false);
    assert.equal(isCampaignSchedulerRunning(), false);
    assert.deepEqual(steps, ['mongo-closed runtime=false listening=false'], 'MongoDB is closed last');
  });

  it('reports not_ready (503) while MongoDB is disconnected', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    server = await start();
    const real = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 0 });
    try {
      const res = await fetch(healthUrl());
      assert.equal(res.status, 503);
      assert.equal((await res.json()).database, false);
    } finally {
      if (real) Object.defineProperty(mongoose.connection, 'readyState', real);
      else delete mongoose.connection.readyState;
    }
    assert.equal((await fetch(healthUrl())).status, 200);
  });
});
