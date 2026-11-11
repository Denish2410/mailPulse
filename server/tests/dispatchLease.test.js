/**
 * Dispatch lease unit/integration tests (single process, real MongoDB, mock transport only).
 * The cross-process behaviour is covered by dispatchLeaseMultiProcess.test.js.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('lease');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
delete process.env.SMTP_HOST;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  recoverCampaign,
  reapStalledCampaigns,
  processNextDelivery,
  startCampaignDispatch,
  finalizeCampaign,
  fenceDeliveriesBeforeTakeover,
  waitForCampaignDispatch,
} from '../src/services/campaignDispatch.service.js';
import {
  INSTANCE_ID,
  DEFAULT_LEASE_MS,
  LeaseSession,
  getLeaseMs,
  leaseTakeoverFields,
  acquireLease,
  acquireLeaseSession,
  renewLease,
  verifyLease,
  releaseLease,
  releaseAllLeases,
} from '../src/services/dispatchLease.service.js';

const quietLogger = { log() {}, warn() {}, error() {} };

describe('Lease configuration and fencing logic (no DB)', () => {
  it('uses a sane default and rejects tiny or invalid values', () => {
    assert.equal(getLeaseMs({}), DEFAULT_LEASE_MS);
    assert.equal(getLeaseMs({ CAMPAIGN_LEASE_MS: 'abc' }), DEFAULT_LEASE_MS);
    assert.equal(getLeaseMs({ CAMPAIGN_LEASE_MS: '100' }), DEFAULT_LEASE_MS);
    assert.equal(getLeaseMs({ CAMPAIGN_LEASE_MS: '20000' }), 20000);
  });

  it('lease timestamps come from MongoDB ($$NOW), never from this process', () => {
    const fields = leaseTakeoverFields(5000);
    assert.deepEqual(fields.dispatchLeaseUntil, { $add: ['$$NOW', 5000] });
    assert.deepEqual(fields.dispatchLeaseEpoch, { $add: [{ $ifNull: ['$dispatchLeaseEpoch', 0] }, 1] });
    assert.equal(fields.dispatchLeaseOwner, INSTANCE_ID);
  });

  it('a session fences itself once its last confirmation is too old, and never un-fences', () => {
    let t = 0;
    const reasons = [];
    const session = new LeaseSession('c1', 3, { confirmedAt: 0, leaseMs: 4000, now: () => t, onFenced: (r) => reasons.push(r) });
    // valid window = lease - lease/4 = 3000ms
    t = 2999;
    assert.equal(session.isFenced(), false);
    t = 3000;
    assert.equal(session.isFenced(), true);
    assert.equal(session.fencedBecause, 'unconfirmed');
    t = 0; // even if the clock looked fine again
    assert.equal(session.isFenced(), true);
    assert.deepEqual(reasons, ['unconfirmed'], 'reported exactly once');
  });
});

describe('Lease acquisition, renewal and epochs', () => {
  let isDbConnected = false;
  let user;

  const newCampaign = (overrides = {}) =>
    Campaign.create({
      userId: user._id,
      name: 'Lease unit campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sending',
      sendStartedAt: new Date(),
      ...overrides,
    });
  const raw = (id) => Campaign.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  const setRaw = (id, set) => Campaign.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: set });
  const past = () => new Date(Date.now() - 60_000);
  const future = () => new Date(Date.now() + 60_000);

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      user = await User.create({ name: 'Lease User', email: `lease-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Lease Tests] MongoDB unavailable: ${err.message}`);
    }
  });

  beforeEach(async () => {
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

  it('grants epoch 1 to the first taker and refuses everyone while the lease is live', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    assert.deepEqual(await acquireLease(c._id), { epoch: 1 });
    assert.equal(await acquireLease(c._id), null, 'even the same process cannot re-acquire a live lease');
    const doc = await raw(c._id);
    assert.equal(doc.dispatchLeaseOwner, INSTANCE_ID);
    assert.equal(doc.dispatchLeaseEpoch, 1);
  });

  it('exactly one of many concurrent acquisitions wins', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const results = await Promise.all(Array.from({ length: 12 }, () => acquireLease(c._id)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await raw(c._id)).dispatchLeaseEpoch, 1);
  });

  it('takes an expired lease (by database time) under epoch + 1', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    await acquireLease(c._id);
    await setRaw(c._id, { dispatchLeaseUntil: past(), dispatchLeaseOwner: 'someone-else' });
    assert.deepEqual(await acquireLease(c._id), { epoch: 2 });
    assert.equal((await raw(c._id)).dispatchLeaseOwner, INSTANCE_ID);
  });

  it('is not fooled by this process clock: skew in either direction changes nothing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const live = await newCampaign();
    await acquireLease(live._id);
    const expired = await newCampaign();
    await acquireLease(expired._id);
    await setRaw(expired._id, { dispatchLeaseUntil: past() });

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3600_000; // an hour fast
      assert.equal(await acquireLease(live._id), null, 'a fast clock cannot steal a live lease');
      Date.now = () => realNow() - 3600_000; // an hour slow
      assert.deepEqual(await acquireLease(expired._id), { epoch: 2 }, 'a slow clock cannot keep a dead lease alive');
    } finally {
      Date.now = realNow;
    }
  });

  it('renews only for the matching owner and epoch', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const { epoch } = await acquireLease(c._id);
    const before = (await raw(c._id)).dispatchLeaseUntil.getTime();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await renewLease(c._id, epoch), true);
    assert.ok((await raw(c._id)).dispatchLeaseUntil.getTime() > before);
    assert.equal(await renewLease(c._id, epoch + 1), false, 'wrong epoch');

    await setRaw(c._id, { dispatchLeaseOwner: 'other-process' });
    assert.equal(await renewLease(c._id, epoch), false, 'wrong owner');
    await setRaw(c._id, { dispatchLeaseOwner: INSTANCE_ID, status: 'sent' });
    assert.equal(await renewLease(c._id, epoch), false, 'campaign no longer sending');
  });

  it('verifyLease demands owner, epoch, sending status and an unexpired lease', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const { epoch } = await acquireLease(c._id);
    assert.equal(await verifyLease(c._id, epoch), true);
    assert.equal(await verifyLease(c._id, epoch + 1), false);
    await setRaw(c._id, { dispatchLeaseUntil: past() });
    assert.equal(await verifyLease(c._id, epoch), false, 'expired');
    await setRaw(c._id, { dispatchLeaseUntil: future(), dispatchLeaseOwner: 'other-process' });
    assert.equal(await verifyLease(c._id, epoch), false, 'someone else');
    await setRaw(c._id, { dispatchLeaseOwner: INSTANCE_ID, status: 'failed' });
    assert.equal(await verifyLease(c._id, epoch), false, 'not sending');
  });

  it('a release ends the lease at once, keeps the epoch, and only works for the owner epoch', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const { epoch } = await acquireLease(c._id);

    await releaseLease(c._id, epoch + 5); // wrong epoch: no effect
    assert.equal((await raw(c._id)).dispatchLeaseOwner, INSTANCE_ID);

    await releaseLease(c._id, epoch);
    const released = await raw(c._id);
    assert.equal(released.dispatchLeaseOwner, undefined);
    assert.equal(released.dispatchLeaseEpoch, epoch, 'the epoch is never reset');
    assert.deepEqual(await acquireLease(c._id), { epoch: epoch + 1 }, 'the next owner gets a higher epoch');

    await releaseAllLeases();
    assert.equal((await raw(c._id)).dispatchLeaseOwner, undefined);
  });

  it('canClaim confirms ownership in the database and a fenced session never recovers', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const session = await acquireLeaseSession(c._id, { leaseMs: 30000 });
    try {
      assert.equal(await session.canClaim(), true);

      // Someone else takes over (epoch 2)...
      await setRaw(c._id, { dispatchLeaseEpoch: 2, dispatchLeaseOwner: 'newer-owner' });
      assert.equal(await session.canClaim(), false);
      assert.equal(session.fencedBecause, 'lost');

      // ...and even if the database now looks exactly like it did, the session stays fenced
      await setRaw(c._id, { dispatchLeaseEpoch: session.epoch, dispatchLeaseOwner: INSTANCE_ID, dispatchLeaseUntil: future() });
      assert.equal(await session.canClaim(), false);
      assert.equal(session.isFenced(), true);
    } finally {
      session.stop();
    }
  });

  it('canClaim fences on a database error instead of guessing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const session = await acquireLeaseSession(c._id, { leaseMs: 30000 });
    const original = Campaign.findOne;
    try {
      Campaign.findOne = () => {
        throw new Error('simulated database failure');
      };
      assert.equal(await session.canClaim(), false);
      assert.equal(session.fencedBecause, 'verification-failed');
    } finally {
      Campaign.findOne = original;
      session.stop();
    }
  });
});

describe('Fenced dispatch work', () => {
  let isDbConnected = false;
  let user;
  let transportMock;
  let emailService;

  const future = () => new Date(Date.now() + 60_000);
  const setRaw = (id, set) => Campaign.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: set });

  /** A 'sending' campaign with `n` pending deliveries. */
  const seed = async (n = 3, overrides = {}) => {
    const contacts = await Contact.insertMany(
      Array.from({ length: n }, (_, i) => ({ userId: user._id, name: `Person ${i}`, email: `d${i}-${new mongoose.Types.ObjectId().toString().slice(-6)}@example.com` }))
    );
    const campaign = await Campaign.create({
      userId: user._id,
      name: 'Fenced campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sending',
      sendStartedAt: new Date(),
      recipientIds: contacts.map((c) => c._id),
      stats: { total: n, sent: 0, failed: 0 },
      ...overrides,
    });
    await Delivery.insertMany(contacts.map((c) => ({ campaignId: campaign._id, userId: user._id, contactId: c._id, email: c.email, status: 'pending' })));
    return campaign;
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      user = await User.create({ name: 'Fence User', email: `fence-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Lease Tests] MongoDB unavailable: ${err.message}`);
    }
  });

  beforeEach(async () => {
    transportMock = createMockTransport();
    emailService = createEmailService({ transport: transportMock, from: 'Test <no-reply@mailpulse.test>' });
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

  const message = { subject: 'Hello', text: 'Body', html: '<p>Body</p>' };

  it('claims under its own epoch and records it on the delivery', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await seed(1);
    const session = await acquireLeaseSession(c._id, { leaseMs: 30000 });
    try {
      assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, session), true);
      const d = await Delivery.findOne({ campaignId: c._id }).lean();
      assert.equal(d.status, 'sent');
      assert.equal(d.claimEpoch, session.epoch);
      assert.equal((await Campaign.findById(c._id).lean()).stats.sent, 1);
    } finally {
      session.stop();
    }
  });

  it('a worker whose lease was taken claims nothing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await seed(3);
    const session = await acquireLeaseSession(c._id, { leaseMs: 30000 });
    try {
      await setRaw(c._id, { dispatchLeaseEpoch: session.epoch + 1, dispatchLeaseOwner: 'newer-owner', dispatchLeaseUntil: future() });
      assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, session), false);
      assert.equal(await Delivery.countDocuments({ campaignId: c._id, status: 'pending' }), 3);
      assert.equal(transportMock.count, 0);
    } finally {
      session.stop();
    }
  });

  it('a stale worker cannot rewrite a delivery or the counts after a takeover mid-send', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await seed(2);
    const session = await acquireLeaseSession(c._id, { leaseMs: 30000 });
    // The transport "takes a long time": while it runs, another instance takes over and records the
    // in-flight delivery as INTERRUPTED (exactly what recovery does)
    const slowTransport = {
      name: 'takeover-during-send',
      async sendMail() {
        await setRaw(c._id, { dispatchLeaseEpoch: session.epoch + 1, dispatchLeaseOwner: 'newer-owner', dispatchLeaseUntil: future() });
        await Delivery.updateMany({ campaignId: c._id, status: 'processing' }, { $set: { status: 'failed', errorCode: 'INTERRUPTED', failedAt: new Date() } });
        return { messageId: '<m@mock>' };
      },
    };
    const stale = createEmailService({ transport: slowTransport, from: 'Test <no-reply@mailpulse.test>' });
    try {
      assert.equal(await processNextDelivery(c._id, message, stale, quietLogger, session), true);
      const d = await Delivery.findOne({ campaignId: c._id, claimEpoch: session.epoch }).lean();
      assert.equal(d.status, 'failed', 'not rewritten as sent');
      assert.equal(d.errorCode, 'INTERRUPTED');
      assert.deepEqual((await Campaign.findById(c._id).lean()).stats, { total: 2, sent: 0, failed: 0 }, 'late increments ignored');
      // and it will not claim the next one
      assert.equal(await processNextDelivery(c._id, message, stale, quietLogger, session), false);
      assert.equal(await Delivery.countDocuments({ campaignId: c._id, status: 'pending' }), 1);
    } finally {
      session.stop();
    }
  });

  it('a fence that trips between claim and send leaves the claim in processing (never handed back)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await seed(1);
    let t0 = 0;
    const session = new LeaseSession(c._id, 1, { confirmedAt: 0, leaseMs: 4000, now: () => t0 });
    await setRaw(c._id, { dispatchLeaseEpoch: 1, dispatchLeaseOwner: INSTANCE_ID, dispatchLeaseUntil: future() });
    // canClaim() passes the first check, then the local clock runs past the lease window
    const realCanClaim = session.canClaim.bind(session);
    session.canClaim = async () => {
      const ok = await realCanClaim();
      t0 = 10_000;
      return ok;
    };
    assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, session), false);
    assert.equal(transportMock.count, 0, 'nothing was sent');
    const d = await Delivery.findOne({ campaignId: c._id }).lean();
    assert.equal(d.status, 'processing', 'it stays claimed: it is NOT returned to pending');
    assert.equal(d.claimEpoch, 1, 'the claim epoch is kept');
    assert.equal(d.attempts, 1, 'attempts are not decremented');
    assert.equal(d.fence, undefined, 'no fence is written');
  });

  it('only the current owner can finalize, and finalizing is idempotent', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await seed(2);
    await Delivery.updateMany({ campaignId: c._id }, { $set: { status: 'sent' } });
    const session = await acquireLeaseSession(c._id, { leaseMs: 30000 });
    try {
      assert.equal(await finalizeCampaign(c._id, { epoch: session.epoch + 1 }), null, 'wrong epoch');
      await setRaw(c._id, { dispatchLeaseOwner: 'other-process' });
      assert.equal(await finalizeCampaign(c._id, session), null, 'wrong owner');
      await setRaw(c._id, { dispatchLeaseOwner: INSTANCE_ID });
      assert.equal((await Campaign.findById(c._id).lean()).status, 'sending');

      const results = await Promise.all(Array.from({ length: 6 }, () => finalizeCampaign(c._id, session)));
      assert.equal(results.filter(Boolean).length, 1, 'exactly one concurrent finalizer wins');
      const done = await Campaign.findById(c._id).lean();
      assert.equal(done.status, 'sent');
      assert.equal(done.dispatchLeaseOwner, undefined);
      assert.equal(done.dispatchLeaseEpoch, session.epoch, 'epoch survives finalization');
    } finally {
      session.stop();
    }
  });

  it('the draft -> sending lock takes the lease in the same atomic update', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await Contact.insertMany(
      [0, 1].map((i) => ({ userId: user._id, name: `Lock ${i}`, email: `l${i}-${new mongoose.Types.ObjectId().toString().slice(-6)}@example.com` }))
    );
    const draft = await Campaign.create({
      userId: user._id,
      name: 'Lock lease',
      subject: 'Hello',
      textContent: 'Body',
      status: 'draft',
      recipientIds: contacts.map((c) => c._id),
    });
    const locked = await startCampaignDispatch({ campaign: draft, userId: user._id, eligibleContacts: contacts, emailService, logger: quietLogger });
    assert.equal(locked.status, 'sending');
    assert.equal(locked.dispatchLeaseOwner, INSTANCE_ID);
    assert.equal(locked.dispatchLeaseEpoch, 1);
    assert.ok(locked.dispatchLeaseUntil > new Date(Date.now() - 1000));
    assert.ok(locked.sendStartedAt instanceof Date);
    assert.deepEqual({ ...locked.stats.toObject?.() }, { total: 2, sent: 0, failed: 0 });

    await waitForCampaignDispatch(draft._id);
    const done = await Campaign.findById(draft._id).lean();
    assert.equal(done.status, 'sent');
    assert.equal(transportMock.count, 2);
    assert.equal(await Delivery.countDocuments({ campaignId: draft._id, claimEpoch: 1 }), 2);
    assert.equal(done.dispatchLeaseOwner, undefined, 'lease cleared on completion');
  });

  it('recovery marks older-epoch in-flight deliveries INTERRUPTED and never re-sends them', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await seed(3);
    const [first] = await Delivery.find({ campaignId: c._id }).sort({ _id: 1 });
    await Delivery.updateOne({ _id: first._id }, { $set: { status: 'processing', claimEpoch: 4, attempts: 1 } });
    await setRaw(c._id, { dispatchLeaseOwner: 'dead-process', dispatchLeaseEpoch: 4, dispatchLeaseUntil: new Date(Date.now() - 5000) });

    assert.equal(await recoverCampaign(c._id, { emailService, logger: quietLogger }), 'resumed');
    await waitForCampaignDispatch(c._id);

    const interrupted = await Delivery.findById(first._id).lean();
    assert.equal(interrupted.errorCode, 'INTERRUPTED');
    assert.ok(!transportMock.sentEmails.some((m) => m.to === first.email), 'the uncertain recipient was not re-sent');
    assert.equal(transportMock.count, 2);
    const done = await Campaign.findById(c._id).lean();
    assert.equal(done.status, 'sent');
    assert.equal(done.dispatchLeaseEpoch, 5, 'recovery took the lease under epoch 5');
  });

  it('recovery leaves a campaign alone while another owner holds a live lease', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await seed(2);
    await Delivery.updateOne({ campaignId: c._id }, { $set: { status: 'processing' } });
    await setRaw(c._id, { dispatchLeaseOwner: 'live-process', dispatchLeaseEpoch: 3, dispatchLeaseUntil: future() });
    assert.equal(await recoverCampaign(c._id, { emailService, logger: quietLogger }), 'skipped');
    assert.equal(await Delivery.countDocuments({ campaignId: c._id, status: 'processing' }), 1, 'the live worker\'s delivery was not failed');
    assert.equal((await Campaign.findById(c._id).lean()).dispatchLeaseEpoch, 3);
  });

  describe('watchdog candidates', () => {
    const sweep = () => reapStalledCampaigns({ emailService, logger: quietLogger, stallTimeoutMs: 15 * 60 * 1000 });

    it('picks up a lease released by a graceful shutdown, but not a live one', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const released = await seed(1);
      const live = await seed(1);
      const s1 = await acquireLeaseSession(released._id, { leaseMs: 30000 });
      const s2 = await acquireLeaseSession(live._id, { leaseMs: 30000 });
      try {
        await releaseLease(released._id, s1.epoch); // what stopAllDispatches does for its campaigns
        assert.equal(await sweep(), 1);
        await waitForCampaignDispatch(released._id);
        assert.equal((await Campaign.findById(released._id).lean()).status, 'sent');
        assert.equal((await Campaign.findById(live._id).lean()).status, 'sending');
        assert.equal(await Delivery.countDocuments({ campaignId: live._id, status: 'pending' }), 1);
      } finally {
        s1.stop();
        s2.stop();
      }
    });

    it('picks up an expired lease immediately (database time), not only after the stall timeout', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(1);
      await setRaw(c._id, { dispatchLeaseOwner: 'dead', dispatchLeaseEpoch: 1, dispatchLeaseUntil: new Date(Date.now() - 1000) });
      assert.equal(await sweep(), 1);
      await waitForCampaignDispatch(c._id);
      assert.equal((await Campaign.findById(c._id).lean()).status, 'sent');
    });

    it('leaves a recent campaign that never had a lease to the stall timeout', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(1); // may still be running on an older version of the app
      assert.equal(await sweep(), 0);
      assert.equal((await Campaign.findById(c._id).lean()).status, 'sending');
    });
  });
});


// ---------------------------------------------------------------------------------------------
describe('Strict lease renewal', () => {
  let isDbConnected = false;
  let user;
  const raw = (id) => Campaign.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  const setRaw = (id, set) => Campaign.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: set });
  const newCampaign = () =>
    Campaign.create({ userId: user._id, name: 'Strict renewal', subject: 'Hello', textContent: 'Body', status: 'sending', sendStartedAt: new Date() });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (fn, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await fn())) {
      if (Date.now() > deadline) throw new Error('timed out');
      await sleep(20);
    }
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      user = await User.create({ name: 'Renew User', email: `renew-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Lease Tests] MongoDB unavailable: ${err.message}`);
    }
  });
  beforeEach(async () => {
    if (isDbConnected) await Campaign.deleteMany({});
  });
  after(async () => {
    if (isDbConnected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  it('renews a valid, unexpired lease for the exact owner and epoch', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const { epoch } = await acquireLease(c._id);
    assert.equal(await renewLease(c._id, epoch), true);
  });

  it('refuses to renew an expired lease, even though owner and epoch match and nobody took it', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const { epoch } = await acquireLease(c._id);
    await setRaw(c._id, { dispatchLeaseUntil: new Date(Date.now() - 1000) });
    assert.equal(await renewLease(c._id, epoch), false);
    assert.ok((await raw(c._id)).dispatchLeaseUntil < new Date(), 'the lease was not revived');
  });

  it('refuses a different owner and a stale epoch', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const { epoch } = await acquireLease(c._id);
    await setRaw(c._id, { dispatchLeaseOwner: 'someone-else' });
    assert.equal(await renewLease(c._id, epoch), false, 'different owner');
    await setRaw(c._id, { dispatchLeaseOwner: INSTANCE_ID, dispatchLeaseEpoch: epoch + 1 });
    assert.equal(await renewLease(c._id, epoch), false, 'stale epoch');
  });

  it('a worker whose lease expired is fenced by its heartbeat, and stays fenced when the lease looks valid again', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await newCampaign();
    const session = await acquireLeaseSession(c._id, { leaseMs: 3000, heartbeatMs: 25 });
    try {
      await setRaw(c._id, { dispatchLeaseUntil: new Date(Date.now() - 1000) });
      await waitFor(() => session.isFenced());
      assert.equal(session.fencedBecause, 'lost');
      await setRaw(c._id, { dispatchLeaseUntil: new Date(Date.now() + 60_000) });
      await sleep(150);
      assert.equal(session.isFenced(), true, 'a fenced worker never comes back');
      assert.equal((await raw(c._id)).dispatchLeaseUntil.getTime() > Date.now() + 50_000, true, 'and it did not renew');
    } finally {
      session.stop();
    }
  });

  it('database errors eventually fence the worker, and it stays fenced after the database recovers', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    let clock = 0;
    let renewImpl = async () => {
      throw new Error('database unreachable');
    };
    const session = new LeaseSession('any-campaign', 1, { confirmedAt: 0, leaseMs: 4000, heartbeatMs: 20, now: () => clock, renew: (...a) => renewImpl(...a) }).start();
    try {
      clock = 1000;
      await sleep(100);
      assert.equal(session.isFenced(), false, 'one lost renewal is tolerated');
      clock = 3500; // past 3/4 of the lease with no confirmation
      assert.equal(session.isFenced(), true);
      assert.equal(session.fencedBecause, 'unconfirmed');

      renewImpl = async () => true; // the database is back and would happily renew
      clock = 3600;
      await sleep(100);
      assert.equal(session.isFenced(), true, 'recovery does not un-fence it');
    } finally {
      session.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('Takeover fencing hook and the atomic claim', () => {
  let isDbConnected = false;
  let user;
  let emailService;
  let transportMock;

  const setRaw = (id, set) => Campaign.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: set });
  const raw = (id) => Campaign.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  const seed = async (n, deliveryFields = [], overrides = {}) => {
    const contacts = await Contact.insertMany(
      Array.from({ length: n }, (_, i) => ({ userId: user._id, name: `Person ${i}`, email: `h${i}-${new mongoose.Types.ObjectId().toString().slice(-6)}@example.com` }))
    );
    const campaign = await Campaign.create({
      userId: user._id,
      name: 'Hook campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sending',
      sendStartedAt: new Date(),
      recipientIds: contacts.map((c) => c._id),
      stats: { total: n, sent: 0, failed: 0 },
      ...overrides,
    });
    await Delivery.collection.insertMany(
      contacts.map((c, i) => ({
        campaignId: campaign._id,
        userId: user._id,
        contactId: c._id,
        email: c.email,
        name: c.name,
        variant: 'A',
        status: 'pending',
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(deliveryFields[i] || {}),
      }))
    );
    return campaign;
  };
  const fencesOf = async (id) => (await Delivery.find({ campaignId: id }).sort({ _id: 1 }).lean()).map((d) => d.fence);
  const message = { subject: 'Hello', text: 'Body', html: '<p>Body</p>' };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      user = await User.create({ name: 'Hook User', email: `hook-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Lease Tests] MongoDB unavailable: ${err.message}`);
    }
  });
  beforeEach(async () => {
    transportMock = createMockTransport();
    emailService = createEmailService({ transport: transportMock, from: 'Test <no-reply@mailpulse.test>' });
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

  describe('takeover order', () => {
    it('reads the expired lease, runs the hook with epoch + 1 while ownership is unchanged, and only then acquires', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(2, [], { dispatchLeaseOwner: 'dead', dispatchLeaseEpoch: 4, dispatchLeaseUntil: new Date(Date.now() - 5000) });
      let seenInHook;
      const result = await acquireLease(c._id, {
        beforeAcquire: async ({ nextEpoch }) => {
          const doc = await raw(c._id);
          seenInHook = { nextEpoch, epoch: doc.dispatchLeaseEpoch, owner: doc.dispatchLeaseOwner };
        },
      });
      assert.deepEqual(seenInHook, { nextEpoch: 5, epoch: 4, owner: 'dead' }, 'the old owner still held the lease while the hook ran');
      assert.deepEqual(result, { epoch: 5 });
      assert.equal((await raw(c._id)).dispatchLeaseOwner, INSTANCE_ID);
    });

    it('a hook failure means the lease is NOT acquired and nothing changes', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(1, [], { dispatchLeaseOwner: 'dead', dispatchLeaseEpoch: 4, dispatchLeaseUntil: new Date(Date.now() - 5000) });
      await assert.rejects(
        () => acquireLease(c._id, { beforeAcquire: async () => { throw new Error('fencing failed'); } }),
        /fencing failed/
      );
      const doc = await raw(c._id);
      assert.equal(doc.dispatchLeaseEpoch, 4);
      assert.equal(doc.dispatchLeaseOwner, 'dead');
    });

    it('does not even run the hook while a live owner holds the lease', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(1, [], { dispatchLeaseOwner: 'alive', dispatchLeaseEpoch: 2, dispatchLeaseUntil: new Date(Date.now() + 60_000) });
      let ran = false;
      assert.equal(await acquireLease(c._id, { beforeAcquire: async () => { ran = true; } }), null);
      assert.equal(ran, false);
    });

    it('compare-and-swap: concurrent takers that read the same epoch produce exactly one winner, granted exactly the fenced epoch', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(4, [], { dispatchLeaseOwner: 'dead', dispatchLeaseEpoch: 4, dispatchLeaseUntil: new Date(Date.now() - 5000) });
      const targets = [];
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          acquireLease(c._id, {
            beforeAcquire: async (info) => {
              targets.push(info.nextEpoch);
              await fenceDeliveriesBeforeTakeover(c._id)(info);
            },
          })
        )
      );
      assert.deepEqual([...new Set(targets)], [5], 'every taker observed epoch 4 and targeted 5');
      const winners = results.filter(Boolean);
      assert.equal(winners.length, 1);
      assert.equal(winners[0].epoch, 5, 'the granted epoch equals the epoch the deliveries were fenced to');
      assert.deepEqual(await fencesOf(c._id), [5, 5, 5, 5]);
      assert.equal((await raw(c._id)).dispatchLeaseEpoch, 5);
    });

    it('compare-and-swap: if the epoch changed after the read, the acquire fails instead of granting a higher epoch', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(2, [], { dispatchLeaseOwner: 'dead', dispatchLeaseEpoch: 4, dispatchLeaseUntil: new Date(Date.now() - 5000) });
      const result = await acquireLease(c._id, {
        beforeAcquire: async (info) => {
          await fenceDeliveriesBeforeTakeover(c._id)(info); // fences to 5
          // meanwhile another taker acquired epoch 5 and its lease ended again
          await setRaw(c._id, { dispatchLeaseEpoch: 5, dispatchLeaseOwner: 'other-taker', dispatchLeaseUntil: new Date(Date.now() - 1000) });
        },
      });
      assert.equal(result, null, 'a stale taker cannot acquire epoch 6 with a fence of 5');
      const doc = await raw(c._id);
      assert.equal(doc.dispatchLeaseEpoch, 5, 'the epoch was not advanced by the loser');
      assert.equal(doc.dispatchLeaseOwner, 'other-taker', 'and the lease was not taken');

      // A fresh attempt observes epoch 5 and is granted exactly the epoch it fences to
      let target;
      const retry = await acquireLease(c._id, {
        beforeAcquire: async (info) => {
          target = info.nextEpoch;
          await fenceDeliveriesBeforeTakeover(c._id)(info);
        },
      });
      assert.deepEqual({ target, epoch: retry.epoch }, { target: 6, epoch: 6 });
      assert.deepEqual(await fencesOf(c._id), [6, 6]);
    });

    it('compare-and-swap handles a missing, null and literal-zero epoch as epoch 0', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      for (const stored of [undefined, null, 0]) {
        const c = await seed(1, [], {});
        await Campaign.collection.updateOne(
          { _id: c._id },
          { $unset: { dispatchLeaseEpoch: '', dispatchLeaseUntil: '', dispatchLeaseOwner: '' } }
        );
        if (stored !== undefined) await setRaw(c._id, { dispatchLeaseEpoch: stored });
        let target;
        const result = await acquireLease(c._id, {
          beforeAcquire: async (info) => {
            target = info.nextEpoch;
          },
        });
        assert.deepEqual({ target, epoch: result?.epoch }, { target: 1, epoch: 1 }, `stored epoch: ${String(stored)}`);
      }
    });

    it('a lost compare-and-swap starts no recovery and no dispatch', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(2, [{ status: 'processing', claimEpoch: 4, attempts: 1 }, {}], {
        dispatchLeaseOwner: 'dead',
        dispatchLeaseEpoch: 4,
        dispatchLeaseUntil: new Date(Date.now() - 5000),
      });
      const realUpdateMany = Delivery.updateMany;
      Delivery.updateMany = async (...args) => {
        const result = await realUpdateMany.apply(Delivery, args);
        if (args[1]?.$max?.fence !== undefined) {
          // another taker takes epoch 5 and lets it lapse right after we fenced
          await setRaw(c._id, { dispatchLeaseEpoch: 5, dispatchLeaseOwner: 'other-taker', dispatchLeaseUntil: new Date(Date.now() - 1000) });
        }
        return result;
      };
      try {
        assert.equal(await recoverCampaign(c._id, { emailService, logger: quietLogger }), 'skipped');
      } finally {
        Delivery.updateMany = realUpdateMany;
      }
      assert.equal(transportMock.count, 0, 'nothing was dispatched');
      assert.equal((await raw(c._id)).dispatchLeaseOwner, 'other-taker', 'the lease was not taken');
      const processing = await Delivery.findOne({ campaignId: c._id, claimEpoch: 4 }).lean();
      assert.equal(processing.status, 'processing', 'no recovery sweep ran');
      assert.equal(await Delivery.countDocuments({ campaignId: c._id, status: 'pending' }), 1, 'nothing was claimed');
    });

    it('a recovery whose fencing fails acquires nothing, dispatches nothing, and can be retried', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(2, [], { dispatchLeaseOwner: 'dead', dispatchLeaseEpoch: 4, dispatchLeaseUntil: new Date(Date.now() - 5000) });
      const realUpdateMany = Delivery.updateMany;
      const errors = [];
      Delivery.updateMany = () => Promise.reject(new Error('simulated fencing failure'));
      try {
        assert.equal(await recoverCampaign(c._id, { emailService, logger: { log() {}, warn() {}, error: (m) => errors.push(m) } }), 'skipped');
      } finally {
        Delivery.updateMany = realUpdateMany;
      }
      assert.ok(errors.some((m) => /fencing failed/.test(m)));
      assert.equal((await raw(c._id)).dispatchLeaseEpoch, 4);
      assert.equal(transportMock.count, 0);
      assert.equal(await recoverCampaign(c._id, { emailService, logger: quietLogger }), 'resumed');
      await waitForCampaignDispatch(c._id);
      assert.equal((await Campaign.findById(c._id).lean()).status, 'sent');
    });
  });

  describe('the fence itself', () => {
    it('raises fences only upward, only for pending deliveries, and is idempotent', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(4, [{}, { fence: 2 }, { fence: 7 }, { status: 'processing', claimEpoch: 1, attempts: 1 }]);
      const before = await Delivery.find({ campaignId: c._id }).sort({ _id: 1 }).lean();

      await fenceDeliveriesBeforeTakeover(c._id)({ nextEpoch: 5 });
      assert.deepEqual(await fencesOf(c._id), [5, 5, 7, undefined], 'raised to 5; the 7 and the in-flight delivery are untouched');

      await fenceDeliveriesBeforeTakeover(c._id)({ nextEpoch: 5 }); // repeating changes nothing
      assert.deepEqual(await fencesOf(c._id), [5, 5, 7, undefined]);
      await fenceDeliveriesBeforeTakeover(c._id)({ nextEpoch: 3 }); // a stale, lower taker cannot lower anything
      assert.deepEqual(await fencesOf(c._id), [5, 5, 7, undefined]);

      const after = await Delivery.find({ campaignId: c._id }).sort({ _id: 1 }).lean();
      assert.deepEqual(after.map((d) => d.updatedAt.getTime()), before.map((d) => d.updatedAt.getTime()), 'fencing does not touch updatedAt');
    });

    it('lets a worker claim deliveries whose fence is absent, null or not above its epoch, and no others', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(4, [{ fence: null }, {}, { fence: 3 }, { fence: 4 }]);
      await setRaw(c._id, { dispatchLeaseOwner: INSTANCE_ID, dispatchLeaseEpoch: 3, dispatchLeaseUntil: new Date(Date.now() + 60_000) });
      const session = new LeaseSession(c._id, 3, { confirmedAt: performance.now(), leaseMs: 60_000 });
      const claimed = [];
      for (let i = 0; i < 5; i += 1) {
        if (!(await processNextDelivery(c._id, message, emailService, quietLogger, session))) break;
        claimed.push(i);
      }
      assert.equal(claimed.length, 3, 'null, absent and fence 3 are claimable by epoch 3');
      const left = await Delivery.findOne({ campaignId: c._id, status: 'pending' }).lean();
      assert.equal(left.fence, 4, 'the delivery fenced to epoch 4 was refused');
      assert.equal(session.fencedBecause, 'fenced-out', 'and the worker recognises it has been fenced out');
    });

    it('a claim and a fence racing on the same delivery always produce one consistent outcome', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      let claimFirst = 0;
      let fenceFirst = 0;
      for (let i = 0; i < 80; i += 1) {
        const c = await seed(1, [], { dispatchLeaseOwner: INSTANCE_ID, dispatchLeaseEpoch: 1, dispatchLeaseUntil: new Date(Date.now() + 60_000) });
        const session = new LeaseSession(c._id, 1, { confirmedAt: performance.now(), leaseMs: 60_000 });
        transportMock.clear();
        await Promise.all([
          processNextDelivery(c._id, message, emailService, quietLogger, session),
          fenceDeliveriesBeforeTakeover(c._id)({ nextEpoch: 2 }),
        ]);
        const d = await Delivery.findOne({ campaignId: c._id }).lean();
        if (d.claimEpoch === 1) {
          claimFirst += 1;
          assert.equal(d.status, 'sent', 'a claim that won was a real, complete send');
          assert.equal(d.fence ?? null, null, 'the fence did not reach a delivery that was no longer pending');
          assert.equal(transportMock.count, 1);
        } else {
          fenceFirst += 1;
          assert.equal(d.status, 'pending');
          assert.equal(d.fence, 2);
          assert.equal(transportMock.count, 0, 'no send without a claim');
        }
      }
      assert.equal(claimFirst + fenceFirst, 80);
    });
  });

  describe('SMTP boundary: a claimed delivery never returns to pending', () => {
    /** A fence whose isFenced() answers come from a script (call 1 = after the claim, call 2 = just before SMTP). */
    const scripted = (epoch, answers) => {
      let calls = 0;
      return { epoch, canClaim: async () => true, isFenced: () => answers[Math.min(calls++, answers.length - 1)], fenceNow() {} };
    };
    const seedClaimable = async (n = 1) => {
      const c = await seed(n, [], { dispatchLeaseOwner: INSTANCE_ID, dispatchLeaseEpoch: 1, dispatchLeaseUntil: new Date(Date.now() + 60_000) });
      return c;
    };

    it('the fence tripping just before the SMTP call sends nothing and leaves the claim in processing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seedClaimable();
      const fence = scripted(1, [false, true]); // passes right after the claim, trips before the send
      assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, fence), false);
      assert.equal(transportMock.count, 0, 'the transport was never invoked');
      const d = await Delivery.findOne({ campaignId: c._id }).lean();
      assert.equal(d.status, 'processing');
      assert.equal(d.attempts, 1);
      assert.equal(d.claimEpoch, 1);
      assert.equal(d.fence, undefined);
    });

    it('recovery then records that claim INTERRUPTED, and it is never claimed or sent again', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seedClaimable(3);
      assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, scripted(1, [false, true])), false);
      const abandoned = await Delivery.findOne({ campaignId: c._id, status: 'processing' }).lean();

      // The lease lapses; a new owner recovers the campaign (fence, acquire, sweep, dispatch)
      await setRaw(c._id, { dispatchLeaseUntil: new Date(Date.now() - 1000) });
      assert.equal(await recoverCampaign(c._id, { emailService, logger: quietLogger }), 'resumed');
      await waitForCampaignDispatch(c._id);

      const d = await Delivery.findById(abandoned._id).lean();
      assert.equal(d.status, 'failed');
      assert.equal(d.errorCode, 'INTERRUPTED');
      assert.equal(d.claimEpoch, 1);
      assert.ok(!transportMock.sentEmails.some((m) => m.to === abandoned.email), 'the abandoned recipient was not emailed');
      assert.equal(transportMock.count, 2, 'the other two were sent');

      // and no later worker, of any epoch, can claim it again
      const later = new LeaseSession(c._id, 9, { confirmedAt: performance.now(), leaseMs: 60_000 });
      assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, later), false);
      assert.equal((await Delivery.findById(abandoned._id).lean()).errorCode, 'INTERRUPTED');
    });

    it('no code path writes a delivery back to pending (checked across the failure and boundary cases)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const writes = [];
      const realUpdateOne = Delivery.updateOne.bind(Delivery);
      const realUpdateMany = Delivery.updateMany.bind(Delivery);
      const realFindOneAndUpdate = Delivery.findOneAndUpdate.bind(Delivery);
      const record = (update) => {
        const status = update?.$set?.status;
        if (status) writes.push(status);
      };
      Delivery.updateOne = (f, u, o) => (record(u), realUpdateOne(f, u, o));
      Delivery.updateMany = (f, u, o) => (record(u), realUpdateMany(f, u, o));
      Delivery.findOneAndUpdate = (f, u, o) => (record(u), realFindOneAndUpdate(f, u, o));
      try {
        // fence trips right after the claim, and again just before SMTP
        const a = await seedClaimable();
        await processNextDelivery(a._id, message, emailService, quietLogger, scripted(1, [true]));
        const b = await seedClaimable();
        await processNextDelivery(b._id, message, emailService, quietLogger, scripted(1, [false, true]));
        // explicit transport failure
        const f = await seedClaimable();
        transportMock.setFail(true);
        await processNextDelivery(f._id, message, emailService, quietLogger, scripted(1, [false]));
        transportMock.setFail(false);
        // transport accepted but the write of 'sent' fails (PERSIST_ERROR)
        const p = await seedClaimable();
        const base = Delivery.updateOne;
        Delivery.updateOne = (fl, u, o) => (u?.$set?.status === 'sent' ? Promise.reject(new Error('write failed')) : base(fl, u, o));
        await processNextDelivery(p._id, message, emailService, quietLogger, scripted(1, [false]));
        Delivery.updateOne = base;
      } finally {
        Delivery.updateOne = realUpdateOne;
        Delivery.updateMany = realUpdateMany;
        Delivery.findOneAndUpdate = realFindOneAndUpdate;
      }
      assert.ok(writes.includes('processing'), 'the claims were observed');
      assert.ok(writes.includes('failed'));
      assert.ok(!writes.includes('pending'), `a delivery was written back to pending: ${writes.join(',')}`);
    });

    it('never returns a delivery to pending once the transport has been invoked (fence trips DURING the send)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seedClaimable();
      let tripped = false;
      const fence = { epoch: 1, canClaim: async () => true, isFenced: () => tripped, fenceNow() {} };
      const transport = {
        name: 'trips-during-send',
        async sendMail() {
          tripped = true; // the fence trips once the SMTP call is under way
          return { messageId: '<m@mock>' };
        },
      };
      const service = createEmailService({ transport, from: 'Test <no-reply@mailpulse.test>' });
      assert.equal(await processNextDelivery(c._id, message, service, quietLogger, fence), true);
      const d = await Delivery.findOne({ campaignId: c._id }).lean();
      assert.equal(d.status, 'sent', 'recorded as sent, not handed back');
      assert.equal(d.claimEpoch, 1);
    });

    it('an explicit SMTP failure is recorded as failed, never returned to pending', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seedClaimable();
      transportMock.setFail(true);
      const fence = { epoch: 1, canClaim: async () => true, isFenced: () => false, fenceNow() {} };
      assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, fence), true);
      const d = await Delivery.findOne({ campaignId: c._id }).lean();
      assert.equal(d.status, 'failed');
      assert.ok(d.errorCode);
      assert.equal(d.fence, undefined, 'untouched by any return path');
    });

    it('accepted by SMTP but not persistable is recorded PERSIST_ERROR, never returned to pending', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seedClaimable();
      const realUpdateOne = Delivery.updateOne.bind(Delivery);
      Delivery.updateOne = (filter, update, options) =>
        update?.$set?.status === 'sent' ? Promise.reject(new Error('write failed')) : realUpdateOne(filter, update, options);
      const fence = { epoch: 1, canClaim: async () => true, isFenced: () => false, fenceNow() {} };
      try {
        assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, fence), true);
      } finally {
        Delivery.updateOne = realUpdateOne;
      }
      assert.equal(transportMock.count, 1, 'the message really was handed to the transport');
      const d = await Delivery.findOne({ campaignId: c._id }).lean();
      assert.equal(d.status, 'failed');
      assert.equal(d.errorCode, 'PERSIST_ERROR');
    });

    it('a delivery recorded INTERRUPTED can never be claimed or sent again', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await seed(1, [{ status: 'failed', errorCode: 'INTERRUPTED', claimEpoch: 1, attempts: 1 }], {
        dispatchLeaseOwner: INSTANCE_ID,
        dispatchLeaseEpoch: 2,
        dispatchLeaseUntil: new Date(Date.now() + 60_000),
      });
      const session = new LeaseSession(c._id, 2, { confirmedAt: performance.now(), leaseMs: 60_000 });
      for (let i = 0; i < 3; i += 1) assert.equal(await processNextDelivery(c._id, message, emailService, quietLogger, session), false);
      assert.equal(transportMock.count, 0);
      assert.equal((await Delivery.findOne({ campaignId: c._id }).lean()).errorCode, 'INTERRUPTED');
    });
  });
});
