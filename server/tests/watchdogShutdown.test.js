/**
 * Shutdown while recovery is in progress: `stopAllDispatches` stops new watchdog sweeps, awaits the
 * sweep (and any recovery) already running, and no dispatch work starts once shutdown has begun.
 * The interrupted recovery leaves the campaign safely recoverable: lease given back, deliveries
 * still pending, in-flight ones INTERRUPTED, and a later owner sends each pending one exactly once.
 * Real MongoDB (isolated database); mock transport only, no email is sent.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('watchdogshutdown');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  stopAllDispatches,
  resetDispatcherState,
  reapStalledCampaigns,
  resumeInterruptedDispatches,
  recoverCampaign,
  scheduleCampaignProcessing,
  startDispatchWatchdog,
  stopDispatchWatchdog,
  waitForCampaignDispatch,
  isDispatchActive,
  isDispatchStopRequested,
} from '../src/services/campaignDispatch.service.js';
import { manifestFieldsFor } from './helpers/manifest.js';

const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True if the promise settles within `ms`. */
const settlesWithin = async (promise, ms) => {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await sleep(ms);
  return settled;
};

/**
 * Holds recovery at its first write under the new lease (the INTERRUPTED sweep) until `open()`.
 * By then the recovery has fenced the deliveries and acquired the lease: the worst moment for a
 * shutdown to begin.
 */
const holdRecoveryAfterLeaseAcquired = () => {
  let markReached;
  const reached = new Promise((resolve) => {
    markReached = resolve;
  });
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  const real = Delivery.updateMany;
  Delivery.updateMany = function gatedUpdateMany(filter, update, ...rest) {
    if (update?.$set?.errorCode === 'INTERRUPTED') {
      markReached();
      return opened.then(() => real.call(this, filter, update, ...rest));
    }
    return real.call(this, filter, update, ...rest);
  };
  return {
    reached,
    open,
    restore: () => {
      Delivery.updateMany = real;
    },
  };
};

describe('Shutdown while a recovery sweep is in progress', () => {
  let isDbConnected = false;
  let owner;
  let transport;
  let emailService;
  let gate = null;

  /** A campaign whose owner died: two deliveries pending, one stuck 'processing' (older epoch). */
  const orphanCampaign = async () => {
    const contacts = await Contact.insertMany(
      ['Pending One', 'Pending Two', 'In Flight'].map((name, i) => ({
        userId: owner._id,
        name,
        email: `ws${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Shutdown campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sending',
      sendStartedAt: new Date(),
      recipientIds: contacts.map((c) => c._id),
      stats: { total: contacts.length, sent: 0, failed: 0 },
      dispatchLeaseOwner: 'dead-process',
      dispatchLeaseEpoch: 1,
      dispatchLeaseUntil: new Date(Date.now() - 5000),
      ...manifestFieldsFor(contacts),
    });
    await Delivery.insertMany(
      contacts.map((c, i) => ({
        campaignId: campaign._id,
        userId: owner._id,
        contactId: c._id,
        email: c.email,
        name: c.name,
        status: i === 2 ? 'processing' : 'pending',
        ...(i === 2 ? { claimEpoch: 1, attempts: 1 } : {}),
      }))
    );
    return { campaign, contacts };
  };

  /** What an interrupted recovery must leave behind: nothing sent, nothing dispatching, lease back. */
  const assertLeftRecoverable = async (campaign) => {
    assert.equal(transport.count, 0, 'no email was sent after shutdown began');
    assert.equal(isDispatchActive(campaign._id), false, 'no dispatch was started');
    const stored = await Campaign.findById(campaign._id).lean();
    assert.equal(stored.status, 'sending', 'left for the next owner');
    assert.equal(stored.dispatchLeaseOwner, undefined, 'the lease was given back');
    assert.ok(stored.dispatchLeaseUntil <= new Date(Date.now() + 1000), 'the lease has ended');
    const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
    assert.equal(deliveries.filter((d) => d.status === 'pending').length, 2, 'pending deliveries stay pending');
    const inFlight = deliveries.find((d) => d.status !== 'pending');
    assert.equal(inFlight.status, 'failed');
    assert.equal(inFlight.errorCode, 'INTERRUPTED', 'the uncertain one is never re-sent');
  };

  /** After a restart, the next owner sends each pending delivery exactly once. */
  const assertNextOwnerFinishesOnce = async (campaign) => {
    resetDispatcherState();
    assert.equal(await recoverCampaign(campaign._id, { emailService, logger: quiet }), 'resumed');
    await waitForCampaignDispatch(campaign._id);
    assert.equal(transport.count, 2);
    assert.equal(new Set(transport.sentEmails.map((m) => m.to)).size, 2);
    const done = await Campaign.findById(campaign._id).lean();
    assert.equal(done.status, 'sent');
    assert.deepEqual({ sent: done.stats.sent, failed: done.stats.failed }, { sent: 2, failed: 1 });
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Shutdown Owner', email: `ws-owner-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Watchdog shutdown tests] MongoDB unavailable: ${err.message}`);
    }
  });

  beforeEach(() => {
    resetDispatcherState();
    transport = createMockTransport();
    emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
  });

  afterEach(async () => {
    gate?.open();
    gate?.restore();
    gate = null;
    stopDispatchWatchdog();
    if (isDbConnected) {
      await stopAllDispatches();
      resetDispatcherState();
      await Delivery.deleteMany({});
      await Campaign.deleteMany({});
      await Contact.deleteMany({});
    }
    resetDispatcherState();
  });

  after(async () => {
    if (isDbConnected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  it('awaits a sweep that holds a lease mid-recovery, then starts no dispatch', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { campaign } = await orphanCampaign();
    gate = holdRecoveryAfterLeaseAcquired();

    const sweep = reapStalledCampaigns({ emailService, logger: quiet, stallTimeoutMs: 60_000 });
    await gate.reached;
    const held = await Campaign.findById(campaign._id).lean();
    assert.notEqual(held.dispatchLeaseOwner, 'dead-process', 'the sweep holds the lease');

    const stopping = stopAllDispatches();
    assert.equal(isDispatchStopRequested(), true);
    assert.equal(await settlesWithin(stopping, 150), false, 'shutdown waits for the in-flight sweep');

    gate.open();
    await stopping;
    assert.equal(await sweep, 0, 'the sweep recovered (dispatched) nothing');

    await assertLeftRecoverable(campaign);
    gate.restore();
    gate = null;
    await assertNextOwnerFinishesOnce(campaign);
  });

  it('awaits a sweep started by the watchdog timer, and no sweep runs after shutdown', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { campaign } = await orphanCampaign();
    gate = holdRecoveryAfterLeaseAcquired();

    startDispatchWatchdog({ emailService, logger: quiet, intervalMs: 20, stallTimeoutMs: 60_000 });
    await gate.reached;

    const stopping = stopAllDispatches();
    assert.equal(await settlesWithin(stopping, 150), false, 'shutdown waits for the timer-started sweep');
    gate.open();
    await stopping;
    await assertLeftRecoverable(campaign);

    // The timer is gone: a campaign that becomes recoverable now is not touched by this process
    const { campaign: later } = await orphanCampaign();
    await sleep(150);
    const untouched = await Campaign.findById(later._id).lean();
    assert.equal(untouched.dispatchLeaseOwner, 'dead-process', 'no sweep ran after shutdown');
    assert.equal(untouched.dispatchLeaseEpoch, 1);
    assert.equal(await Delivery.countDocuments({ campaignId: later._id, status: 'pending' }), 2);
    assert.equal(transport.count, 0);
  });

  it('awaits a startup resume that is mid-recovery, then starts no dispatch', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { campaign } = await orphanCampaign();
    gate = holdRecoveryAfterLeaseAcquired();

    const resume = resumeInterruptedDispatches({ emailService, logger: quiet });
    await gate.reached;
    const stopping = stopAllDispatches();
    assert.equal(await settlesWithin(stopping, 150), false);
    gate.open();
    await stopping;
    assert.equal(await resume, 0);
    await assertLeftRecoverable(campaign);
  });

  it('once shutdown has begun, recovery and sweeps touch nothing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { campaign } = await orphanCampaign();
    await stopAllDispatches();

    assert.equal(await recoverCampaign(campaign._id, { emailService, logger: quiet }), 'skipped');
    assert.equal(await reapStalledCampaigns({ emailService, logger: quiet, stallTimeoutMs: 1 }), 0);
    assert.equal(await resumeInterruptedDispatches({ emailService, logger: quiet }), 0);

    const stored = await Campaign.findById(campaign._id).lean();
    assert.equal(stored.dispatchLeaseOwner, 'dead-process', 'the lease was not taken');
    assert.equal(stored.dispatchLeaseEpoch, 1, 'no new epoch');
    const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
    assert.equal(deliveries.filter((d) => d.status === 'pending').length, 2);
    assert.equal(deliveries.filter((d) => d.status === 'processing').length, 1, 'not even the sweep ran');
    assert.ok(deliveries.every((d) => d.fence === undefined), 'nothing was fenced');
    assert.equal(transport.count, 0);
  });

  it('a dispatch handed over after shutdown began is not started; its lease is given back', async () => {
    await stopAllDispatches();
    let released = 0;
    const leaseSession = {
      async release() {
        released += 1;
      },
      stop() {},
    };
    const campaignId = new mongoose.Types.ObjectId();
    await scheduleCampaignProcessing(campaignId, { emailService, logger: quiet, leaseSession });
    assert.equal(released, 1);
    assert.equal(isDispatchActive(campaignId), false);
    assert.equal(transport.count, 0);
  });
});
