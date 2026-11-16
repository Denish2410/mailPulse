/**
 * Interrupted delivery generation across REAL separate processes.
 *
 * A worker takes the send lock (writing the manifest) and is stopped part-way through generating
 * deliveries. Another worker then recovers the campaign. These tests prove, with real processes,
 * real leases and an isolated MongoDB, that:
 *
 *   - a crash part-way through generation ends with every manifest recipient sent exactly once;
 *   - a stale generator that resumes after the takeover adds no delivery, sends nothing and cannot
 *     finalize, while the new owner completes the campaign;
 *   - a recovery racing another recovery still produces exactly one send per recipient.
 *
 * No email is sent: child transports record into the probe_sends collection.
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
  campaignDoc,
  sendsFor,
  waitUntilLeaseEnded as helperWaitUntilLeaseEnded,
} from './helpers/childHarness.js';

const DB_URI = isolatedMongoUri('interruptedgen');
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

describe('Interrupted delivery generation across real processes', () => {
  let isDbConnected = false;
  let user;
  const { spawnChild, killAll } = createChildHarness({ dbUri: DB_URI, leaseMs: LEASE_MS });
  const waitUntilLeaseEnded = (id) => helperWaitUntilLeaseEnded(id, LEASE_MS);

  const makeDraft = async (n) => {
    const contacts = await Contact.insertMany(
      Array.from({ length: n }, (_, i) => ({
        userId: user._id,
        name: `Generated ${i}`,
        email: `g${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );
    const campaign = await Campaign.create({
      userId: user._id,
      name: 'Interrupted generation',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'draft',
      recipientIds: contacts.map((c) => c._id),
    });
    return { id: String(campaign._id), contacts, contactIds: contacts.map((c) => String(c._id)) };
  };

  /** Every manifest recipient was sent exactly once, and nobody else was. */
  const assertEachSentOnce = async (id, contacts) => {
    const sends = await sendsFor(id);
    const counts = new Map();
    for (const send of sends) counts.set(send.to, (counts.get(send.to) || 0) + 1);
    for (const contact of contacts) {
      assert.equal(counts.get(contact.email) || 0, 1, 'a manifest recipient was not sent exactly once');
    }
    assert.equal(sends.length, contacts.length, 'no extra sends');
    assert.equal(await Delivery.countDocuments({ campaignId: id }), contacts.length, 'deliveries are exactly the manifest');
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([Contact.init(), Campaign.init(), Delivery.init()]);
      user = await User.create({ name: 'Gen MP User', email: `genmp-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Interrupted generation tests] MongoDB unavailable: ${err.message}`);
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

  it('a worker that crashes part-way through generation: a peer completes it, each recipient once', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    if (!canPause) return t.skip('SIGSTOP not available on this platform');
    const { id, contacts, contactIds } = await makeDraft(8);
    const first = await spawnChild();

    await first.ask('lockWithInterruptedGeneration', { campaignId: id, contactIds, insertBefore: 3 });
    await first.waitEvent('generation-paused');
    // The lock is durable: 'sending', manifest of 8, only 3 deliveries, nothing sent
    const locked = await campaignDoc(id);
    assert.equal(locked.status, 'sending');
    assert.equal(locked.dispatchManifestCount, 8);
    assert.equal(await Delivery.countDocuments({ campaignId: id }), 3);

    first.proc.kill('SIGKILL'); // crash
    await waitUntilLeaseEnded(id);

    const second = await spawnChild();
    const { outcome } = await second.ask('recover', { campaignId: id });
    assert.equal(outcome, 'resumed');
    await second.waitEvent('dispatch-finished');

    const done = await campaignDoc(id);
    assert.equal(done.status, 'sent');
    assert.equal(done.dispatchLeaseEpoch, 2);
    assert.equal(done.stats.total, 8);
    assert.equal(done.stats.sent, 8);
    await assertEachSentOnce(id, contacts);
  });

  it('a crash before ANY delivery was inserted: the campaign is completed, not returned to draft', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    if (!canPause) return t.skip('SIGSTOP not available on this platform');
    const { id, contacts, contactIds } = await makeDraft(5);
    const first = await spawnChild();

    await first.ask('lockWithInterruptedGeneration', { campaignId: id, contactIds, insertBefore: 0 });
    await first.waitEvent('generation-paused');
    assert.equal(await Delivery.countDocuments({ campaignId: id }), 0);
    first.proc.kill('SIGKILL');
    await waitUntilLeaseEnded(id);

    const second = await spawnChild();
    assert.equal((await second.ask('recover', { campaignId: id })).outcome, 'resumed');
    await second.waitEvent('dispatch-finished');

    assert.equal((await campaignDoc(id)).status, 'sent');
    await assertEachSentOnce(id, contacts);
  });

  it('a stale generator that resumes after the takeover adds nothing, sends nothing and cannot finalize', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    if (!canPause) return t.skip('SIGSTOP not available on this platform');
    const { id, contacts, contactIds } = await makeDraft(6);
    const stale = await spawnChild();

    await stale.ask('lockWithInterruptedGeneration', { campaignId: id, contactIds, insertBefore: 2 });
    await stale.waitEvent('generation-paused'); // frozen: no heartbeat, no inserts
    await waitUntilLeaseEnded(id);

    // A new owner takes over (epoch 2), completes generation and sends everything
    const owner = await spawnChild();
    assert.equal((await owner.ask('recover', { campaignId: id })).outcome, 'resumed');
    await owner.waitEvent('dispatch-finished');
    const finished = await campaignDoc(id);
    assert.equal(finished.status, 'sent');
    assert.equal(finished.dispatchLeaseEpoch, 2);
    await assertEachSentOnce(id, contacts);
    const deliveriesBefore = await Delivery.find({ campaignId: id }).sort({ _id: 1 }).lean();

    // The stale generator wakes up and runs the rest of its real code path
    stale.resume();
    const result = await stale.waitEvent('lock-finished', 20000);
    assert.equal(result.epoch, 1, 'it still believes it holds epoch 1');
    await sleep(300);

    assert.deepEqual(await Delivery.find({ campaignId: id }).sort({ _id: 1 }).lean(), deliveriesBefore, 'no delivery added or changed');
    await assertEachSentOnce(id, contacts);
    const after = await campaignDoc(id);
    assert.equal(after.status, 'sent');
    assert.equal(after.dispatchLeaseEpoch, 2, 'the stale worker did not take the lease back');
    assert.equal(String(after.sendCompletedAt), String(finished.sendCompletedAt), 'it did not finalize again');
  });

  it('a stale generator resuming DURING the new owner\'s dispatch still causes no double send', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    if (!canPause) return t.skip('SIGSTOP not available on this platform');
    const { id, contacts, contactIds } = await makeDraft(6);
    const stale = await spawnChild();

    await stale.ask('lockWithInterruptedGeneration', { campaignId: id, contactIds, insertBefore: 3 });
    await stale.waitEvent('generation-paused');
    await waitUntilLeaseEnded(id);

    // The new owner's sends are held at the transport, so its dispatch is mid-flight
    const owner = await spawnChild();
    assert.equal((await owner.ask('recover', { campaignId: id, gated: true })).outcome, 'resumed');
    await owner.waitEvent('in-send');

    stale.resume();
    await stale.waitEvent('lock-finished', 20000);
    assert.equal(await Delivery.countDocuments({ campaignId: id }), 6);
    assert.equal(await mongoose.connection.collection('probe_sends').countDocuments({ pid: stale.proc.pid }), 0, 'the stale worker sent nothing');

    await owner.ask('openGate');
    await owner.waitEvent('dispatch-finished');
    assert.equal((await campaignDoc(id)).status, 'sent');
    await assertEachSentOnce(id, contacts);
  });

  it('two peers recovering the same interrupted generation at once: one wins, each recipient once', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    if (!canPause) return t.skip('SIGSTOP not available on this platform');
    const { id, contacts, contactIds } = await makeDraft(10);
    const first = await spawnChild();
    await first.ask('lockWithInterruptedGeneration', { campaignId: id, contactIds, insertBefore: 4 });
    await first.waitEvent('generation-paused');
    first.proc.kill('SIGKILL');
    await waitUntilLeaseEnded(id);

    const peers = await Promise.all([spawnChild(), spawnChild()]);
    const startAt = Date.now() + 600;
    const results = await Promise.all(peers.map((peer) => peer.ask('recover', { campaignId: id, startAt })));
    const winners = results.filter((r) => r.outcome === 'resumed');
    assert.equal(winners.length, 1, JSON.stringify(results));
    const winner = peers[results.findIndex((r) => r.outcome === 'resumed')];
    await winner.waitEvent('dispatch-finished');
    await waitFor(async () => (await campaignDoc(id)).status === 'sent', { label: 'campaign sent' });

    assert.equal((await campaignDoc(id)).dispatchLeaseEpoch, 2);
    await assertEachSentOnce(id, contacts);
  });
});
