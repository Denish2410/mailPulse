/**
 * Delivery fencing across REAL separate processes (stale-claim race and takeover ordering).
 *
 * Children (tests/helpers/dispatchChild.js) run the real dispatch/lease code against one isolated
 * database with a mock transport only. Freezing uses SIGSTOP/SIGCONT or a self-inflicted SIGSTOP at
 * an exact point. Not covered: separate machines, real clock drift, VM freezes (the frozen local
 * clock is emulated), real SMTP.
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
  waitFor,
  campaignDoc,
  sendsFor,
  seedSendingCampaign,
  waitUntilLeaseEnded as helperWaitUntilLeaseEnded,
} from './helpers/childHarness.js';

const DB_URI = isolatedMongoUri('fence');
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
import { processNextDelivery } from '../src/services/campaignDispatch.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';

const LEASE_MS = 3000;
const canPause = process.platform !== 'win32';

describe('Delivery fencing across real processes', () => {
  let isDbConnected = false;
  let user;
  const { spawnChild, killAll } = createChildHarness({ dbUri: DB_URI, leaseMs: LEASE_MS });
  const makeCampaign = (n, overrides) => seedSendingCampaign(user, n, overrides);
  const waitUntilLeaseEnded = (id) => helperWaitUntilLeaseEnded(id, LEASE_MS);
  const deliveries = (id, filter = {}) => Delivery.find({ campaignId: id, ...filter }).sort({ _id: 1 }).lean();
  /** A campaign whose previous owner died: epoch 4, lease ended a while ago. */
  const makeAbandoned = async (n) => {
    const id = await makeCampaign(n, { dispatchLeaseOwner: 'dead-instance', dispatchLeaseEpoch: 4, dispatchLeaseUntil: new Date(Date.now() - 60_000) });
    return id;
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      user = await User.create({ name: 'Fence MP', email: `fence-mp-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Fencing multi-process tests] MongoDB unavailable: ${err.message}`);
    }
  });

  afterEach(async () => {
    killAll();
    if (isDbConnected) {
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
  describe('the exact stale-claim race (fence wins first)', () => {
    it('a worker frozen between lease verification and claim cannot claim or send after a takeover', async (t) => {
      if (!isDbConnected || !canPause) return t.skip('MongoDB and SIGSTOP required');
      const N = 4;
      const id = await makeCampaign(N);

      // 1-3. A acquires epoch 1, verifies its lease, and freezes exactly before its claim
      const a = await spawnChild();
      await a.ask('claimFrozen', { campaignId: id });
      assert.equal((await a.waitEvent('verified')).epoch, 1);
      assert.equal((await deliveries(id, { claimEpoch: { $exists: true } })).length, 0, 'A has claimed nothing yet');

      // 4-6. A's lease expires; B fences the pending deliveries, takes over at epoch 2 and recovers
      await waitUntilLeaseEnded(id);
      const b = await spawnChild();
      assert.equal((await b.ask('recover', { campaignId: id, gated: true, concurrency: 1 })).outcome, 'resumed');
      await waitFor(() => Delivery.findOne({ campaignId: id, status: 'processing', claimEpoch: 2 }).lean(), { label: 'B to claim under epoch 2' });

      const campaignBefore = await campaignDoc(id);
      const bInFlight = await Delivery.findOne({ campaignId: id, status: 'processing', claimEpoch: 2 }).lean();
      const pendingBefore = await deliveries(id, { status: 'pending' });
      assert.equal(campaignBefore.dispatchLeaseEpoch, 2);
      assert.equal(pendingBefore.length, N - 1);
      assert.ok(pendingBefore.every((d) => d.fence === 2), 'every pending delivery was fenced to epoch 2');

      // 7-8. A resumes and tries to claim
      a.resume();
      const finished = await a.waitEvent('claim-finished');

      // 9-11. It cannot claim, never reaches SMTP, and changes nothing of B's
      assert.equal(finished.returned, false, 'A got nothing to claim');
      assert.equal(finished.fenced, true);
      assert.equal(finished.reason, 'fenced-out', 'A recognised that it was fenced out');
      assert.equal(await Delivery.countDocuments({ campaignId: id, claimEpoch: 1 }), 0, 'A claimed no delivery');
      const aSends = (await mongoose.connection.collection('probe_sends').find({ pid: a.proc.pid }).toArray()).length;
      assert.equal(aSends, 0, 'A never invoked the (mock) transport');

      const campaignAfter = await campaignDoc(id);
      assert.equal(campaignAfter.dispatchLeaseEpoch, 2);
      assert.equal(campaignAfter.dispatchLeaseOwner, campaignBefore.dispatchLeaseOwner);
      assert.equal(campaignAfter.dispatchLeaseUntil.getTime() >= campaignBefore.dispatchLeaseUntil.getTime(), true, 'B kept its lease');
      assert.deepEqual({ ...campaignAfter.stats }, { ...campaignBefore.stats }, 'statistics unchanged by A');
      assert.deepEqual(await Delivery.findById(bInFlight._id).lean(), bInFlight, "B's in-flight delivery is untouched");
      const pendingAfter = await deliveries(id, { status: 'pending' });
      assert.deepEqual(pendingAfter, pendingBefore, 'pending deliveries (and their fences/attempts) are untouched');

      // B carries on and finishes: everybody is emailed exactly once
      await b.ask('openGate');
      await b.waitEvent('dispatch-finished');
      const sends = await sendsFor(id);
      assert.equal(sends.length, N);
      assert.equal(new Set(sends.map((s) => s.to)).size, N);
      assert.equal((await campaignDoc(id)).status, 'sent');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('the other ordering (claim wins first)', () => {
    it('a claim made before the fence is a legitimate in-flight delivery: INTERRUPTED, never resent, never re-claimed', async (t) => {
      if (!isDbConnected || !canPause) return t.skip('MongoDB and SIGSTOP required');
      const N = 5;
      const id = await makeCampaign(N);

      // A claims delivery #1 BEFORE any fence exists and is frozen inside the (mock) send
      const a = await spawnChild();
      await a.ask('startDispatch', { campaignId: id, gated: true, concurrency: 1 });
      await a.waitEvent('in-send'); // A is inside the transport call, not merely claimed
      const inFlight = await waitFor(() => Delivery.findOne({ campaignId: id, status: 'processing', claimEpoch: 1 }).lean(), { label: 'A to claim' });
      assert.equal(inFlight.fence, 1, "it was claimed under A's own fence (1) before any takeover fence existed");
      a.pause();
      await waitUntilLeaseEnded(id);

      // B fences the still-pending deliveries; the in-flight one is not pending so it is not fenced
      const b = await spawnChild();
      assert.equal((await b.ask('recover', { campaignId: id, gated: true, concurrency: 1 })).outcome, 'resumed');
      await waitFor(() => Delivery.findOne({ campaignId: id, status: 'processing', claimEpoch: 2 }).lean(), { label: 'B to claim' });

      const recorded = await Delivery.findById(inFlight._id).lean();
      assert.equal(recorded.status, 'failed');
      assert.equal(recorded.errorCode, 'INTERRUPTED', 'the uncertain delivery is recorded INTERRUPTED');
      assert.equal(recorded.claimEpoch, 1, 'B did not take it over with a fresh claim');
      assert.equal(recorded.fence, 1, "B's fence (2) never reached it: it was no longer pending when B fenced");

      // A wakes up and finishes the send it had legitimately started; nothing about it changes
      a.resume();
      await a.ask('openGate');
      await a.waitEvent('dispatch-finished');
      const afterStale = await Delivery.findById(inFlight._id).lean();
      assert.equal(afterStale.status, 'failed');
      assert.equal(afterStale.errorCode, 'INTERRUPTED');
      assert.equal(await Delivery.countDocuments({ campaignId: id, claimEpoch: 1 }), 1, 'A claimed nothing else');

      await b.ask('openGate');
      await b.waitEvent('dispatch-finished');
      const perRecipient = new Map();
      for (const s of await sendsFor(id)) perRecipient.set(s.to, (perRecipient.get(s.to) || 0) + 1);
      assert.equal(perRecipient.get(inFlight.email), 1, 'the uncertain recipient was emailed once (by A), never resent');
      assert.equal([...perRecipient.values()].filter((n) => n > 1).length, 0);
      assert.equal(perRecipient.size, N);
      assert.equal((await campaignDoc(id)).status, 'sent');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('concurrent takeover', () => {
    it('of several simultaneous takers exactly one wins, and every pending delivery is fenced to its epoch', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const id = await makeAbandoned(6);
      const takers = await Promise.all(Array.from({ length: 4 }, () => spawnChild()));
      const startAt = Date.now() + 800;
      const results = await Promise.all(takers.map((c) => c.ask('takeover', { campaignId: id, startAt })));

      const winners = results.filter((r) => r.acquired);
      assert.equal(winners.length, 1, JSON.stringify(results));
      assert.equal(winners[0].epoch, 5);
      const doc = await campaignDoc(id);
      assert.equal(doc.dispatchLeaseEpoch, 5, 'the epoch advanced exactly once');
      const pending = await deliveries(id, { status: 'pending' });
      assert.equal(pending.length, 6);
      assert.ok(pending.every((d) => d.fence === 5), 'fenced to the epoch the winner holds');
    });

    it('fences the deliveries BEFORE the lease changes hands', async (t) => {
      if (!isDbConnected || !canPause) return t.skip('MongoDB and SIGSTOP required');
      const id = await makeAbandoned(4);
      const taker = await spawnChild();
      await taker.ask('takeoverFrozen', { campaignId: id, at: 'after-fencing' });
      await taker.waitEvent('in-takeover-after-fencing');

      // The taker is frozen: deliveries are already fenced, the lease is still the dead owner's
      const frozenDoc = await campaignDoc(id);
      assert.equal(frozenDoc.dispatchLeaseEpoch, 4, 'ownership has not changed yet');
      assert.equal(frozenDoc.dispatchLeaseOwner, 'dead-instance');
      assert.ok((await deliveries(id, { status: 'pending' })).every((d) => d.fence === 5), 'pending deliveries are fenced to the next epoch');

      taker.resume();
      const done = await taker.waitEvent('takeover-finished');
      assert.deepEqual({ acquired: done.acquired, epoch: done.epoch }, { acquired: true, epoch: 5 });
    });

    it('a stale taker that finishes fencing late cannot lower any fence or disturb the lease', async (t) => {
      if (!isDbConnected || !canPause) return t.skip('MongoDB and SIGSTOP required');
      const id = await makeAbandoned(4);

      // T decides on epoch 5, then freezes BEFORE it touches any delivery
      const stale = await spawnChild();
      await stale.ask('takeoverFrozen', { campaignId: id, at: 'before-fencing' });
      await stale.waitEvent('in-takeover-before-fencing');

      // Meanwhile X takes over (epoch 5) and releases; Y takes over (epoch 6)
      const x = await spawnChild();
      assert.deepEqual(await x.ask('takeover', { campaignId: id }), { acquired: true, epoch: 5 });
      await x.ask('releaseSession', { campaignId: id });
      const y = await spawnChild();
      assert.deepEqual(await y.ask('takeover', { campaignId: id }), { acquired: true, epoch: 6 });
      const before = await campaignDoc(id);
      assert.ok((await deliveries(id, { status: 'pending' })).every((d) => d.fence === 6));

      // T wakes up: its fencing (to 5) must not lower anything, and its acquire must fail
      stale.resume();
      const finished = await stale.waitEvent('takeover-finished');
      assert.equal(finished.acquired, false, 'a loser changes no lease');
      assert.ok((await deliveries(id, { status: 'pending' })).every((d) => d.fence === 6), 'no fence was lowered');
      const after = await campaignDoc(id);
      assert.equal(after.dispatchLeaseEpoch, 6);
      assert.equal(after.dispatchLeaseOwner, before.dispatchLeaseOwner);

      // The legitimate owner (epoch 6) is not blocked and can claim and send
      const claim = await y.ask('claimWithSession', { campaignId: id });
      assert.equal(claim.returned, true);
      assert.equal(await Delivery.countDocuments({ campaignId: id, status: 'sent', claimEpoch: 6 }), 1);
    });

    it('compare-and-swap: a taker that fenced for epoch 5 cannot acquire epoch 6 after another taker changed the epoch', async (t) => {
      if (!isDbConnected || !canPause) return t.skip('MongoDB and SIGSTOP required');
      const N = 4;
      const id = await makeAbandoned(N);

      // 1-3. T reads epoch 4, fences the pending deliveries to 5, then pauses before acquiring
      const stale = await spawnChild();
      await stale.ask('takeoverFrozen', { campaignId: id, at: 'after-fencing' });
      await stale.waitEvent('in-takeover-after-fencing');
      assert.ok((await deliveries(id, { status: 'pending' })).every((d) => d.fence === 5));
      assert.equal((await campaignDoc(id)).dispatchLeaseEpoch, 4);

      // 4-5. U takes epoch 5, and its lease ends (released)
      const u = await spawnChild();
      assert.deepEqual(await u.ask('takeover', { campaignId: id }), { acquired: true, epoch: 5 });
      await u.ask('releaseSession', { campaignId: id });
      const released = await campaignDoc(id);
      assert.equal(released.dispatchLeaseEpoch, 5);
      assert.equal(released.dispatchLeaseOwner, undefined, 'the lease is free again');

      // 6-8. T resumes with its original observed epoch 4: the compare-and-swap must fail
      stale.resume();
      const finished = await stale.waitEvent('takeover-finished');
      assert.equal(finished.acquired, false, 'the swap against epoch 4 fails: the epoch is now 5');
      const after = await campaignDoc(id);
      assert.equal(after.dispatchLeaseEpoch, 5, 'no epoch 6 was granted');
      assert.equal(after.dispatchLeaseOwner, undefined, 'T did not take the lease');
      assert.ok((await deliveries(id, { status: 'pending' })).every((d) => d.fence === 5));

      // 9. Nothing was dispatched under a mismatched fence
      assert.equal((await sendsFor(id)).length, 0);
      assert.equal(await Delivery.countDocuments({ campaignId: id, status: { $ne: 'pending' } }), 0);

      // A fresh takeover observes epoch 5, fences to 6, and is granted exactly 6
      const v = await spawnChild();
      assert.deepEqual(await v.ask('takeover', { campaignId: id }), { acquired: true, epoch: 6 });
      assert.ok((await deliveries(id, { status: 'pending' })).every((d) => d.fence === 6), 'fence == granted epoch');
      // ... and the epoch-5 worker (U) can no longer claim a single delivery
      const stub = { epoch: 5, canClaim: async () => true, isFenced: () => false, fenceNow() {} };
      const svc = createEmailService({ transport: createMockTransport(), from: 'Test <no-reply@mailpulse.test>' });
      assert.equal(await processNextDelivery(id, { subject: 'S', text: 'T', html: '<p>T</p>' }, svc, { log() {}, warn() {}, error() {} }, stub), false);
      assert.equal(await Delivery.countDocuments({ campaignId: id, status: 'pending' }), N);
    });

    it('a worker whose fence trips after its claim leaves it processing; recovery records INTERRUPTED and it is never sent', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const N = 4;
      const id = await makeCampaign(N);
      const a = await spawnChild();
      await a.ask('claimThenTrip', { campaignId: id });
      const tripped = await a.waitEvent('claim-tripped');
      assert.equal(tripped.returned, false);

      const abandoned = await Delivery.findOne({ campaignId: id, status: 'processing', claimEpoch: tripped.epoch }).lean();
      assert.ok(abandoned, 'the claimed delivery stays processing (not returned to pending)');
      assert.equal(abandoned.attempts, 1);
      assert.equal((await sendsFor(id)).length, 0, 'nothing was sent');

      // The lease lapses; B takes over, sweeps, and finishes the campaign
      await a.ask('releaseSession', { campaignId: id });
      const b = await spawnChild();
      assert.equal((await b.ask('recover', { campaignId: id })).outcome, 'resumed');
      await b.waitEvent('dispatch-finished');

      const d = await Delivery.findById(abandoned._id).lean();
      assert.equal(d.status, 'failed');
      assert.equal(d.errorCode, 'INTERRUPTED');
      const sends = await sendsFor(id);
      assert.equal(sends.length, N - 1);
      assert.ok(!sends.some((s) => s.to === abandoned.email), 'the abandoned recipient was never emailed');
      assert.equal((await campaignDoc(id)).status, 'sent');
    });

    it('a fencing failure means no lease, no recovery, no dispatch, and the campaign stays recoverable', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const id = await makeAbandoned(3);
      const first = await spawnChild();
      const failed = await first.ask('recover', { campaignId: id, failFencing: true });
      assert.equal(failed.outcome, 'skipped');
      assert.ok(failed.errors.some((m) => /fencing failed/.test(m)), `the failure is reported: ${JSON.stringify(failed.errors)}`);

      const doc = await campaignDoc(id);
      assert.equal(doc.dispatchLeaseEpoch, 4, 'the lease was not acquired');
      assert.equal(doc.dispatchLeaseOwner, 'dead-instance');
      assert.equal(await Delivery.countDocuments({ campaignId: id, status: { $ne: 'pending' } }), 0, 'nothing was recovered or claimed');
      assert.equal((await sendsFor(id)).length, 0, 'nothing was dispatched');

      // Still eligible: a healthy instance completes the takeover and the campaign
      const second = await spawnChild();
      assert.equal((await second.ask('recover', { campaignId: id })).outcome, 'resumed');
      await second.waitEvent('dispatch-finished');
      assert.equal((await campaignDoc(id)).status, 'sent');
      assert.equal((await sendsFor(id)).length, 3);
    });
  });
});
