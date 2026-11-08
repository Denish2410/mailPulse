import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

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
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  recoverCampaign,
  reapStalledCampaigns,
  processCampaignDeliveries,
  startCampaignDispatch,
  waitForCampaignDispatch,
} from '../src/services/campaignDispatch.service.js';
import {
  INSTANCE_ID,
  DEFAULT_LEASE_MS,
  getLeaseMs,
  acquireLease,
  releaseLease,
  startLeaseHeartbeat,
} from '../src/services/dispatchLease.service.js';

const quietLogger = { log() {}, warn() {}, error() {} };

describe('Lease configuration (no DB)', () => {
  it('uses a sane default and rejects tiny or invalid values', () => {
    assert.equal(getLeaseMs({}), DEFAULT_LEASE_MS);
    assert.equal(getLeaseMs({ CAMPAIGN_LEASE_MS: 'abc' }), DEFAULT_LEASE_MS);
    assert.equal(getLeaseMs({ CAMPAIGN_LEASE_MS: '100' }), DEFAULT_LEASE_MS);
    assert.equal(getLeaseMs({ CAMPAIGN_LEASE_MS: '20000' }), 20000);
  });
});

describe('Dispatch leases across instances', () => {
  let isDbConnected = false;
  const prefix = `lease-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let user;
  let contacts = [];
  let transport;
  let emailService;

  const future = () => new Date(Date.now() + 5 * 60 * 1000);
  const past = () => new Date(Date.now() - 5 * 60 * 1000);

  /** A campaign in 'sending' with two pending deliveries, optionally held by another instance. */
  const makeSending = async ({ lease, startedAt = new Date() } = {}) => {
    const c = await Campaign.create({
      userId: user._id,
      name: 'Lease campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sending',
      sendStartedAt: startedAt,
      recipientIds: contacts.map((x) => x._id),
      ...(lease && { dispatchLeaseOwner: lease.owner, dispatchLeaseUntil: lease.until }),
    });
    await Delivery.insertMany(
      contacts.map((x, i) => ({
        campaignId: c._id,
        userId: user._id,
        contactId: x._id,
        email: x.email,
        status: i === 0 ? 'processing' : 'pending',
      }))
    );
    return c;
  };
  const cleanup = async () => {
    await Delivery.deleteMany({ userId: user._id });
    await Campaign.deleteMany({ userId: user._id });
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Lease Tests] MongoDB unavailable: ${err.message}`);
    }
    if (isDbConnected) {
      user = await User.create({
        name: 'Lease One',
        email: `${prefix}@example.com`,
        passwordHash: await hashPassword('StrongPassword123!'),
      });
      contacts = await Contact.insertMany(
        [0, 1].map((i) => ({ userId: user._id, name: `Person ${i}`, email: `${prefix}-p${i}@example.com` }))
      );
    }
  });

  beforeEach(async () => {
    transport = createMockTransport();
    emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
    if (isDbConnected) await cleanup();
  });

  after(async () => {
    if (isDbConnected) {
      await cleanup();
      await Contact.deleteMany({ userId: user._id });
      await User.deleteMany({ _id: user._id });
      await mongoose.disconnect();
    }
  });

  it('acquires a free or expired lease, renews its own, and is refused a live foreign one', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const free = await makeSending();
    assert.equal(await acquireLease(free._id), true);
    assert.equal((await Campaign.findById(free._id)).dispatchLeaseOwner, INSTANCE_ID);
    assert.equal(await acquireLease(free._id), true); // renew

    const expired = await makeSending({ lease: { owner: 'other-instance', until: past() } });
    assert.equal(await acquireLease(expired._id), true);

    const held = await makeSending({ lease: { owner: 'other-instance', until: future() } });
    assert.equal(await acquireLease(held._id), false);
    assert.equal((await Campaign.findById(held._id)).dispatchLeaseOwner, 'other-instance');

    await releaseLease(free._id);
    assert.equal((await Campaign.findById(free._id)).dispatchLeaseOwner, undefined);
  });

  it('recovery skips a campaign another live instance is sending, untouched', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await makeSending({ lease: { owner: 'other-instance', until: future() } });
    const outcome = await recoverCampaign(c._id, { emailService, logger: quietLogger });
    assert.equal(outcome, 'skipped');
    // The peer's in-flight delivery must not be failed as INTERRUPTED
    assert.equal(await Delivery.countDocuments({ campaignId: c._id, status: 'processing' }), 1);
    assert.equal(transport.count, 0);
  });

  it('recovery resumes a campaign whose owner lease expired', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await makeSending({ lease: { owner: 'crashed-instance', until: past() } });
    assert.equal(await recoverCampaign(c._id, { emailService, logger: quietLogger }), 'resumed');
    await waitForCampaignDispatch(c._id);

    assert.equal(await Delivery.countDocuments({ campaignId: c._id, errorCode: 'INTERRUPTED' }), 1);
    assert.equal(transport.count, 1); // the one pending delivery
    const done = await Campaign.findById(c._id);
    assert.equal(done.status, 'sent');
    assert.equal(done.dispatchLeaseOwner, undefined); // lease cleared on finalize
  });

  it('the watchdog picks up expired-lease campaigns early but never live-lease ones', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    // started just now (younger than the stall timeout) but its owner died
    const dead = await makeSending({ lease: { owner: 'crashed-instance', until: past() } });
    // started long ago but a peer is demonstrably alive
    const alive = await makeSending({
      startedAt: new Date(Date.now() - 3600_000),
      lease: { owner: 'other-instance', until: future() },
    });

    const recovered = await reapStalledCampaigns({ emailService, logger: quietLogger, stallTimeoutMs: 15 * 60 * 1000 });
    await waitForCampaignDispatch(dead._id);

    assert.equal(recovered >= 1, true);
    assert.equal((await Campaign.findById(dead._id)).status, 'sent');
    const stillSending = await Campaign.findById(alive._id);
    assert.equal(stillSending.status, 'sending');
    assert.equal(stillSending.dispatchLeaseOwner, 'other-instance');
  });

  it('a worker does not process a campaign held by another live instance', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await makeSending({ lease: { owner: 'other-instance', until: future() } });
    await processCampaignDeliveries(c._id, { emailService, concurrency: 1, logger: quietLogger });
    assert.equal(transport.count, 0);
    assert.equal(await Delivery.countDocuments({ campaignId: c._id, status: 'pending' }), 1);
  });

  it('locking a campaign for dispatch takes the lease for this instance', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const draft = await Campaign.create({
      userId: user._id,
      name: 'Lock lease',
      subject: 'Hello',
      textContent: 'Body',
      status: 'draft',
      recipientIds: contacts.map((x) => x._id),
    });
    const locked = await startCampaignDispatch({
      campaign: draft,
      userId: user._id,
      eligibleContacts: contacts,
      emailService,
      logger: quietLogger,
    });
    assert.equal(locked.dispatchLeaseOwner, INSTANCE_ID);
    assert.ok(locked.dispatchLeaseUntil > new Date());
    await waitForCampaignDispatch(draft._id);
    assert.equal(transport.count, 2);
    assert.equal((await Campaign.findById(draft._id)).status, 'sent');
  });

  it('the heartbeat reports a lost lease once another instance takes it', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await makeSending();
    assert.equal(await acquireLease(c._id), true);

    let lost = 0;
    const stop = startLeaseHeartbeat(c._id, { onLost: () => (lost += 1), leaseMs: 3000 });
    // Simulate a peer stealing the lease (e.g. after a long pause on this instance)
    await Campaign.updateOne({ _id: c._id }, { $set: { dispatchLeaseOwner: 'peer', dispatchLeaseUntil: future() } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    stop();
    assert.equal(lost, 1);
  });
});
