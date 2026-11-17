/**
 * API / worker separation, with REAL processes (`node src/server.js` and `node src/worker.js`)
 * against an isolated database:
 *   - the API process never sends: a queued ("send now") campaign stays queued while only the API
 *     runs, however many scheduler intervals pass;
 *   - the worker process picks it up and dispatches it;
 *   - both shut down cleanly on SIGTERM (exit code 0).
 * No email can leave the machine: the children run with NODE_ENV=test and empty SMTP settings, and
 * in the test environment the email service refuses to create a real transport (fail closed), so
 * every delivery the worker attempts is recorded CONFIGURATION_ERROR. The children listen on
 * 127.0.0.1 only.
 */
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

const DB_URI = isolatedMongoUri('apiworker');
process.env.MONGODB_URI = DB_URI;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { waitFor, sleep } from './helpers/childHarness.js';

const SERVER_DIR = path.resolve(__dirname, '..');

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Environment for a child: built from scratch, so nothing (such as SMTP settings) leaks in. */
const childEnv = (extra) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'test',
  MONGODB_URI: DB_URI,
  JWT_SECRET: process.env.JWT_SECRET,
  SHUTDOWN_TIMEOUT_MS: '10000',
  CAMPAIGN_SCHEDULER_INTERVAL_MS: '1000',
  // Explicitly empty: dotenv never overrides a variable that is already set
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  ...extra,
});

/** Spawns `node <script>` in the server directory; resolves the exit code via `exited`. */
const startChild = (script, extra) => {
  const child = spawn(process.execPath, [script], {
    cwd: SERVER_DIR,
    env: childEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
};

const statusOf = async (url) => {
  try {
    return (await fetch(url)).status;
  } catch {
    return null;
  }
};

const stopChild = async (handle) => {
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGTERM');
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 20000));
  const result = await Promise.race([handle.exited, timeout]);
  if (result.code === 'timeout') handle.child.kill('SIGKILL');
  return result;
};

describe('API and worker run as separate processes', () => {
  let isDbConnected = false;
  let owner;
  const children = [];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Separation Owner', email: `sep-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[API/worker separation tests] MongoDB unavailable: ${err.message}`);
    }
  });

  after(async () => {
    await Promise.all(children.map(stopChild));
    if (isDbConnected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  it('only the worker process dispatches a queued campaign; both exit cleanly on SIGTERM', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await Contact.insertMany(
      ['Sep One', 'Sep Two'].map((name, i) => ({
        userId: owner._id,
        name,
        email: `sep${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );
    // Exactly what "send now" leaves behind: scheduled, due now
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Queued send',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000),
      recipientIds: contacts.map((c) => c._id),
    });

    // 1. The API alone: healthy, and the campaign stays queued
    const apiPort = await freePort();
    const api = startChild('src/server.js', { PORT: String(apiPort) });
    children.push(api);
    await waitFor(async () => (await statusOf(`http://127.0.0.1:${apiPort}/api/v1/health`)) === 200, {
      timeoutMs: 20000,
      label: `API health (${api.output()})`,
    });
    await sleep(3500); // more than three scheduler intervals, had the API been running one
    assert.equal((await Campaign.findById(campaign._id).lean()).status, 'scheduled', 'the API did not touch it');
    assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
    assert.deepEqual(await stopChild(api), { code: 0, signal: null }, `API exit (${api.output()})`);

    // 2. The worker: healthy, dispatches the queued campaign
    const healthPort = await freePort();
    const worker = startChild('src/worker.js', { WORKER_HEALTH_PORT: String(healthPort), WORKER_HEALTH_HOST: '127.0.0.1' });
    children.push(worker);
    const health = `http://127.0.0.1:${healthPort}/health`;
    await waitFor(async () => (await statusOf(health)) === 200, { timeoutMs: 20000, label: `worker health (${worker.output()})` });
    assert.equal(await statusOf(`http://127.0.0.1:${healthPort}/api/v1/health`), 404, 'the worker serves no API');

    await waitFor(async () => ['sent', 'failed'].includes((await Campaign.findById(campaign._id).lean()).status), {
      timeoutMs: 20000,
      label: 'worker dispatch',
    });
    const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
    assert.equal(deliveries.length, 2, 'the worker locked it and generated its deliveries');
    for (const delivery of deliveries) {
      // Fail closed: no real transport exists in the test environment, so nothing was sent
      assert.equal(delivery.status, 'failed');
      assert.equal(delivery.errorCode, 'CONFIGURATION_ERROR');
      assert.equal(delivery.attempts, 1);
    }
    assert.equal((await Campaign.findById(campaign._id).lean()).status, 'failed');

    // 3. Clean shutdown: exit 0, health endpoint gone
    assert.deepEqual(await stopChild(worker), { code: 0, signal: null }, `worker exit (${worker.output()})`);
    assert.equal(await statusOf(health), null);
  });
});
