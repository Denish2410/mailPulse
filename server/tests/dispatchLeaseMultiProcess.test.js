/**
 * Dispatch lease tests with REAL separate Node.js processes.
 *
 * Every "instance" here is a child process (tests/helpers/dispatchChild.js) running the real lease
 * and dispatch code against ONE isolated MongoDB database. Instances are paused with SIGSTOP /
 * SIGCONT, cut off from the database, and given skewed clocks. Email is never sent: the children
 * use a mock transport that only records sends in a collection.
 *
 * What this proves: lease and fencing behaviour across real processes sharing a database.
 * What it does NOT prove: behaviour on separate machines (network partitions, real clock drift),
 * whole-machine freezes, or anything involving a real SMTP server.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';
import {
  createChildHarness,
  sleep,
  waitFor,
  serverNow,
  campaignDoc,
  sendsFor,
  seedSendingCampaign,
  waitUntilLeaseEnded as helperWaitUntilLeaseEnded,
} from './helpers/childHarness.js';

const DB_URI = isolatedMongoUri('leasemp');
process.env.MONGODB_URI = DB_URI;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
delete process.env.SMTP_HOST;

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';

const LEASE_MS = 3000;
const canPause = process.platform !== 'win32'; // SIGSTOP/SIGCONT

describe('Dispatch leases across real processes', () => {
  let isDbConnected = false;
  let user;
  const { spawnChild, killAll } = createChildHarness({ dbUri: DB_URI, leaseMs: LEASE_MS });
  const makeSendingCampaign = (n, overrides) => seedSendingCampaign(user, n, overrides);
  const waitUntilLeaseEnded = (id) => helperWaitUntilLeaseEnded(id, LEASE_MS);

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      user = await User.create({ name: 'MP User', email: `mp-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Lease multi-process tests] MongoDB unavailable: ${err.message}`);
    }
  });

  afterEach(async () => {
    killAll();
    if (isDbConnected) {
      // Campaigns left in 'sending' by one test would be swept up by the next test's watchdog
      await mongoose.connection.collection('probe_sends').deleteMany({});
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

  // ---------------------------------------------------------------------------------------------
  describe('acquisition', () => {
    it('exactly one of several simultaneous processes wins, with epoch 1', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const id = await makeSendingCampaign(1);
      const racers = await Promise.all(Array.from({ length: 5 }, () => spawnChild()));
      const startAt = Date.now() + 800; // all five fire at the same instant
      const results = await Promise.all(racers.map((r) => r.ask('acquire', { campaignId: id, startAt })));

      const winners = results.filter((r) => r.acquired);
      assert.equal(winners.length, 1, `winners: ${JSON.stringify(results)}`);
      assert.equal(winners[0].epoch, 1);
      assert.equal((await campaignDoc(id)).dispatchLeaseEpoch, 1);
    });

    it('a process with a wildly skewed clock cannot take a live lease (leases use database time)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const id = await makeSendingCampaign(1);
      const owner = await spawnChild();
      assert.equal((await owner.ask('acquire', { campaignId: id })).acquired, true);

      const ahead = await spawnChild();
      const behind = await spawnChild();
      await ahead.ask('skewClock', { ms: 3600_000 }); // +1 hour
      await behind.ask('skewClock', { ms: -3600_000 }); // -1 hour
      assert.equal((await ahead.ask('acquire', { campaignId: id })).acquired, false);
      assert.equal((await behind.ask('acquire', { campaignId: id })).acquired, false);
      assert.equal((await campaignDoc(id)).dispatchLeaseEpoch, 1);

      // Skew does not block a legitimate takeover either: after a release the skewed process gets it
      await owner.ask('releaseSession', { campaignId: id });
      const taken = await ahead.ask('acquire', { campaignId: id });
      assert.deepEqual(taken, { acquired: true, epoch: 2 });
    });

    it('renewal keeps the lease: nobody can take it even after the original term has passed', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const id = await makeSendingCampaign(1);
      const owner = await spawnChild();
      await owner.ask('acquire', { campaignId: id });
      const firstUntil = (await campaignDoc(id)).dispatchLeaseUntil;

      await waitFor(async () => (await serverNow()) > new Date(firstUntil.getTime() + 500), { timeoutMs: LEASE_MS * 3, label: 'original term to pass' });
      const renewed = (await campaignDoc(id)).dispatchLeaseUntil;
      assert.ok(renewed > firstUntil, 'the heartbeat extended the lease');

      const challenger = await spawnChild();
      assert.equal((await challenger.ask('acquire', { campaignId: id })).acquired, false);
      assert.equal((await owner.ask('sessionState', { campaignId: id })).fenced, false);
    });

    it('an expired lease is taken over under epoch + 1, and the old owner is fenced', async (t) => {
      if (!isDbConnected || !canPause) return t.skip('MongoDB and SIGSTOP required');
      const id = await makeSendingCampaign(1);
      const first = await spawnChild();
      assert.equal((await first.ask('acquire', { campaignId: id })).epoch, 1);

      first.pause(); // stops renewing: the lease will lapse
      await waitUntilLeaseEnded(id);

      const second = await spawnChild();
      assert.deepEqual(await second.ask('acquire', { campaignId: id }), { acquired: true, epoch: 2 });

      first.resume();
      const state = await waitFor(async () => {
        const s = await first.ask('sessionState', { campaignId: id });
        return s.fenced ? s : null;
      }, { label: 'the resumed old owner to fence itself' });
      assert.ok(['lost', 'unconfirmed'].includes(state.reason), state.reason);

      const doc = await campaignDoc(id);
      assert.equal(doc.dispatchLeaseEpoch, 2, 'the stale owner did not disturb the new lease');
      assert.equal(doc.dispatchLeaseOwner, (await second.ask('info')).instanceId);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('a stale worker after takeover', () => {
    it('claims nothing, overwrites nothing, changes no counts, and nobody is emailed twice', async (t) => {
      if (!isDbConnected || !canPause) return t.skip('MongoDB and SIGSTOP required');
      const N = 6;
      const id = await makeSendingCampaign(N);

      // A claims delivery #1 under epoch 1 and blocks inside the (mock) send
      const a = await spawnChild();
      await a.ask('startDispatch', { campaignId: id, gated: true, concurrency: 1 });
      await a.waitEvent('in-send'); // A is inside the transport call, not merely claimed
      const inFlight = await waitFor(() => Delivery.findOne({ campaignId: id, status: 'processing', claimEpoch: 1 }).lean(), { label: 'A to claim a delivery' });

      // A freezes past its lease; B takes the campaign over (epoch 2) and blocks in ITS first send
      a.pause();
      await waitUntilLeaseEnded(id);
      const b = await spawnChild();
      assert.equal((await b.ask('recover', { campaignId: id, gated: true, concurrency: 1 })).outcome, 'resumed');
      await waitFor(() => Delivery.findOne({ campaignId: id, status: 'processing', claimEpoch: 2 }).lean(), { label: 'B to claim a delivery' });

      // The interrupted delivery was recorded as uncertain, never re-queued
      const interrupted = await Delivery.findById(inFlight._id).lean();
      assert.equal(interrupted.status, 'failed');
      assert.equal(interrupted.errorCode, 'INTERRUPTED');

      // A wakes up and finishes the send it had already started
      a.resume();
      await a.ask('openGate');
      await a.waitEvent('dispatch-finished');

      // ... but claimed nothing new, left the delivery state alone, and did not touch the counts
      assert.equal(await Delivery.countDocuments({ campaignId: id, claimEpoch: 1 }), 1, 'A claimed only its original delivery');
      const afterStale = await Delivery.findById(inFlight._id).lean();
      assert.equal(afterStale.status, 'failed', 'a stale worker must not rewrite the delivery as sent');
      assert.equal(afterStale.errorCode, 'INTERRUPTED');
      assert.equal(await Delivery.countDocuments({ campaignId: id, status: 'pending' }), N - 2, 'A did not take pending work');
      const mid = await campaignDoc(id);
      assert.equal(mid.status, 'sending', 'A did not finalize');
      assert.equal(mid.dispatchLeaseEpoch, 2);
      assert.equal(mid.stats.sent, 0, 'A did not bump the counts');
      assert.equal(mid.stats.failed, 1, 'only the recovery-recorded INTERRUPTED delivery is counted');

      // B finishes the campaign
      await b.ask('openGate');
      await b.waitEvent('dispatch-finished');
      const done = await campaignDoc(id);
      assert.equal(done.status, 'sent');
      assert.deepEqual({ total: done.stats.total, sent: done.stats.sent, failed: done.stats.failed }, { total: N, sent: N - 1, failed: 1 });

      // Nobody was emailed twice, and the interrupted recipient was NOT re-sent by the new owner
      const sends = await sendsFor(id);
      const perRecipient = new Map();
      for (const s of sends) perRecipient.set(s.to, (perRecipient.get(s.to) || 0) + 1);
      assert.equal([...perRecipient.values()].filter((n) => n > 1).length, 0, 'no duplicate sends');
      assert.equal(perRecipient.get(inFlight.email), 1, 'the uncertain recipient was emailed once (by A) and not retried');
      assert.equal(sends.length, N);
    });

    it('only the exact current owner and epoch can finalize', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const id = await makeSendingCampaign(2);
      await Delivery.updateMany({ campaignId: id }, { $set: { status: 'sent' } });

      const owner = await spawnChild();
      assert.equal((await owner.ask('acquire', { campaignId: id })).epoch, 1);
      const other = await spawnChild();

      // Right epoch number, wrong process; and the wrong epoch number from anyone
      assert.equal((await other.ask('finalizeAs', { campaignId: id, epoch: 1 })).finalized, false);
      assert.equal((await owner.ask('finalizeAs', { campaignId: id, epoch: 7 })).finalized, false);
      assert.equal((await campaignDoc(id)).status, 'sending');

      assert.equal((await owner.ask('finalizeAs', { campaignId: id, epoch: 1 })).finalized, true);
      assert.equal((await campaignDoc(id)).status, 'sent');
      // Idempotent: a second attempt changes nothing
      assert.equal((await owner.ask('finalizeAs', { campaignId: id, epoch: 1 })).finalized, false);
      assert.equal((await campaignDoc(id)).status, 'sent');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('graceful shutdown', () => {
    it('a stopped instance releases its lease and a peer recovers the rest at once, without resends', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const N = 12;
      const id = await makeSendingCampaign(N);
      const a = await spawnChild();
      await a.ask('startDispatch', { campaignId: id, delayMs: 150, concurrency: 1 });
      await waitFor(async () => (await Delivery.countDocuments({ campaignId: id, status: 'sent' })) >= 2, { label: 'A to send a few' });

      await a.ask('stopAll'); // what SIGTERM triggers
      const released = await campaignDoc(id);
      assert.equal(released.status, 'sending');
      assert.equal(released.dispatchLeaseOwner, undefined, 'owner cleared');
      assert.ok(released.dispatchLeaseUntil <= (await serverNow()), 'the released lease counts as ended');
      const pendingBefore = await Delivery.countDocuments({ campaignId: id, status: 'pending' });
      assert.ok(pendingBefore > 0);

      // A peer's watchdog (default 15-minute stall timeout) picks it up on its very next sweep
      const peer = await spawnChild();
      assert.equal((await peer.ask('reap', { stallTimeoutMs: 15 * 60 * 1000, campaignId: id })).recovered, 1);
      await peer.waitEvent('dispatch-finished');

      const done = await campaignDoc(id);
      assert.equal(done.status, 'sent');
      assert.equal(done.dispatchLeaseEpoch, 2);
      const perRecipient = new Map();
      for (const s of await sendsFor(id)) perRecipient.set(s.to, (perRecipient.get(s.to) || 0) + 1);
      assert.equal(perRecipient.size, N);
      assert.equal([...perRecipient.values()].filter((n) => n > 1).length, 0, 'no recipient emailed twice');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('database outage', () => {
    it('a worker that cannot confirm its lease fences itself within the lease window and stays fenced after reconnect', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const id = await makeSendingCampaign(1);
      const a = await spawnChild();
      assert.equal((await a.ask('acquire', { campaignId: id })).acquired, true);
      await waitFor(async () => (await campaignDoc(id)).dispatchLeaseUntil, { label: 'lease' });

      await a.ask('disconnect');
      const outageStart = Date.now();
      const state = await waitFor(async () => {
        const s = await a.ask('sessionState', { campaignId: id });
        return s.fenced ? s : null;
      }, { timeoutMs: LEASE_MS * 2, intervalMs: 50, label: 'self-fencing during the outage' });
      const fencedAfter = Date.now() - outageStart;
      assert.equal(state.reason, 'unconfirmed', 'fenced because ownership could not be confirmed');
      assert.ok(fencedAfter <= LEASE_MS + 500, `fenced after ${fencedAfter}ms, lease is ${LEASE_MS}ms`);

      // The database comes back: the fenced worker must NOT resume or renew
      await a.ask('reconnect');
      const untilAtReconnect = (await campaignDoc(id)).dispatchLeaseUntil.getTime();
      await sleep(LEASE_MS * 0.9); // more than two heartbeat periods
      assert.equal((await a.ask('sessionState', { campaignId: id })).fenced, true, 'still fenced after reconnect');
      assert.equal((await campaignDoc(id)).dispatchLeaseUntil.getTime(), untilAtReconnect, 'the fenced worker did not renew');

      // ...and the campaign is free for someone else once the lease lapses
      await waitUntilLeaseEnded(id);
      const peer = await spawnChild();
      assert.deepEqual(await peer.ask('acquire', { campaignId: id }), { acquired: true, epoch: 2 });
    });

    it('a dispatching worker stops claiming when the database drops and does not resume afterwards', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const N = 30;
      const id = await makeSendingCampaign(N);
      const a = await spawnChild();
      await a.ask('startDispatch', { campaignId: id, delayMs: 100, concurrency: 1 });
      await waitFor(async () => (await Delivery.countDocuments({ campaignId: id, status: 'sent' })) >= 2, { label: 'A to send a few' });

      await a.ask('disconnect');
      await a.waitEvent('dispatch-finished', LEASE_MS * 3);
      await a.ask('reconnect');

      const snapshot = async () => ({
        pending: await Delivery.countDocuments({ campaignId: id, status: 'pending' }),
        processing: await Delivery.countDocuments({ campaignId: id, status: 'processing' }),
        sent: await Delivery.countDocuments({ campaignId: id, status: 'sent' }),
      });
      const afterReconnect = await snapshot();
      await sleep(LEASE_MS * 0.9);
      assert.deepEqual(await snapshot(), afterReconnect, 'a fenced worker claims nothing after the database returns');
      assert.ok(afterReconnect.pending > 0, 'work is left for a recovering instance');

      // A peer recovers it; whatever was in flight at the outage is INTERRUPTED, never re-sent
      await waitUntilLeaseEnded(id);
      const peer = await spawnChild();
      assert.equal((await peer.ask('recover', { campaignId: id, concurrency: 2 })).outcome, 'resumed');
      await peer.waitEvent('dispatch-finished');
      const done = await campaignDoc(id);
      assert.equal(done.status, 'sent');
      const perRecipient = new Map();
      for (const s of await sendsFor(id)) perRecipient.set(s.to, (perRecipient.get(s.to) || 0) + 1);
      assert.equal([...perRecipient.values()].filter((n) => n > 1).length, 0, 'no recipient emailed twice');
      assert.ok((await Delivery.countDocuments({ campaignId: id, errorCode: 'INTERRUPTED' })) <= 1);
    });
  });
});
