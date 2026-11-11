/**
 * Shared plumbing for the multi-process lease tests: spawn real child processes running
 * tests/helpers/dispatchChild.js against an isolated database, talk to them over IPC, pause them
 * with SIGSTOP/SIGCONT, and seed campaigns. Not a test file.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import mongoose from 'mongoose';

import Contact from '../../src/models/Contact.js';
import Campaign from '../../src/models/Campaign.js';
import Delivery from '../../src/models/Delivery.js';

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dispatchChild.js');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async (fn, { timeoutMs = 20000, intervalMs = 50, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
};

/** MongoDB's own clock (the one lease decisions use). */
export const serverNow = async () => (await mongoose.connection.db.admin().command({ hello: 1 })).localTime;

export const campaignDoc = (id) => Campaign.findById(id).lean();

export const waitUntilLeaseEnded = async (id, leaseMs) => {
  const until = (await campaignDoc(id)).dispatchLeaseUntil;
  await waitFor(async () => (await serverNow()) > until, { timeoutMs: leaseMs * 3, label: 'lease to end (server time)' });
};

export const sendsFor = async (id) => {
  const emails = (await Delivery.find({ campaignId: id }).select('email').lean()).map((d) => d.email);
  return mongoose.connection.collection('probe_sends').find({ to: { $in: emails } }).toArray();
};

/** A campaign already in 'sending' (no lease yet) with `n` pending deliveries. */
export const seedSendingCampaign = async (user, n, overrides = {}) => {
  const contacts = await Contact.insertMany(
    Array.from({ length: n }, (_, i) => ({
      userId: user._id,
      name: `Person ${i}`,
      email: `p${i}-${new mongoose.Types.ObjectId().toString().slice(-6)}@example.com`,
    }))
  );
  const campaign = await Campaign.create({
    userId: user._id,
    name: 'MP lease campaign',
    subject: 'Hello',
    textContent: 'Body',
    htmlContent: '<p>Body</p>',
    status: 'sending',
    sendStartedAt: new Date(),
    recipientIds: contacts.map((c) => c._id),
    stats: { total: n, sent: 0, failed: 0 },
    ...overrides,
  });
  await Delivery.insertMany(
    contacts.map((c) => ({ campaignId: campaign._id, userId: user._id, contactId: c._id, email: c.email, status: 'pending' }))
  );
  return String(campaign._id);
};

/**
 * @param {{ dbUri: string, leaseMs: number }} config
 */
export const createChildHarness = ({ dbUri, leaseMs }) => {
  let children = [];

  const spawnChild = async (env = {}) => {
    const proc = fork(HELPER, [], {
      env: { ...process.env, MONGODB_URI: dbUri, CAMPAIGN_LEASE_MS: String(leaseMs), ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.stdout.resume();

    const pending = new Map();
    const events = [];
    let nextId = 1;
    proc.on('message', (msg) => {
      if (msg.id) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) waiter.resolve(msg.result);
        else waiter.reject(new Error(msg.error));
      } else {
        events.push(msg);
      }
    });
    proc.on('exit', (code, signal) => {
      for (const waiter of pending.values()) waiter.reject(new Error(`child exited (code ${code}, signal ${signal})\n${stderr}`));
      pending.clear();
    });

    const handle = {
      proc,
      events,
      get stderr() {
        return stderr;
      },
      ask: (cmd, args = {}, timeoutMs = 15000) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`child did not answer "${cmd}" in ${timeoutMs}ms\n${stderr}`));
          }, timeoutMs);
          pending.set(id, {
            resolve: (v) => (clearTimeout(timer), resolve(v)),
            reject: (e) => (clearTimeout(timer), reject(e)),
          });
          proc.send({ id, cmd, args });
        }),
      waitEvent: (name, timeoutMs = 20000) => waitFor(() => events.find((e) => e.event === name), { timeoutMs, label: `child event ${name}` }),
      pause: () => proc.kill('SIGSTOP'),
      resume: () => proc.kill('SIGCONT'),
    };
    children.push(handle);
    await handle.waitEvent('ready', 20000);
    return handle;
  };

  const killAll = () => {
    for (const c of children) {
      try {
        c.proc.kill('SIGCONT');
        c.proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    children = [];
  };

  return { spawnChild, killAll };
};
