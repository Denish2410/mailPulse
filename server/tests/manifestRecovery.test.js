/**
 * Recovery completes interrupted delivery generation from the stored manifest, and refuses any
 * campaign whose recipient list cannot be proven complete (legacy or corrupt manifest, or
 * deliveries that do not match it). Real MongoDB (isolated database); mock transport only.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('manifestrecovery');
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
  recoverCampaign,
  resumeInterruptedDispatches,
  reapStalledCampaigns,
  waitForCampaignDispatch,
} from '../src/services/campaignDispatch.service.js';
import { manifestFieldsFor } from './helpers/manifest.js';

const quiet = { log() {}, warn() {}, error() {} };

describe('Recovery completes generation from the stored manifest', () => {
  let isDbConnected = false;
  let owner;
  let transport;
  let emailService;
  let errors;
  const logger = { log() {}, warn() {}, error: (m) => errors.push(m) };

  const raw = (id) => mongoose.connection.collection('campaigns').findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  const setRaw = (id, update) => mongoose.connection.collection('campaigns').updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, update);

  const makeContacts = (n) =>
    Contact.insertMany(
      Array.from({ length: n }, (_, i) => ({
        userId: owner._id,
        name: `Recovered ${i}`,
        email: `${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );

  /** 'sending', locked by a process that has since died (expired lease, epoch 3). */
  const orphan = async (contacts, { manifest = true, overrides = {} } = {}) =>
    Campaign.create({
      userId: owner._id,
      name: 'Orphaned campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sending',
      sendStartedAt: new Date(),
      recipientIds: contacts.map((c) => c._id),
      stats: { total: contacts.length, sent: 0, failed: 0 },
      dispatchLeaseOwner: 'dead-process',
      dispatchLeaseEpoch: 3,
      dispatchLeaseUntil: new Date(Date.now() - 5000),
      ...(manifest && manifestFieldsFor(contacts)),
      ...overrides,
    });

  const deliveryFor = (campaign, contact, fields = {}) => ({
    campaignId: campaign._id,
    userId: owner._id,
    contactId: contact._id,
    email: contact.email,
    name: contact.name,
    status: 'pending',
    ...fields,
  });

  const sentTo = () => transport.sentEmails.map((m) => m.to).sort();

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Recovery Owner', email: `rec-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Manifest recovery tests] MongoDB unavailable: ${err.message}`);
    }
  });

  beforeEach(() => {
    errors = [];
    transport = createMockTransport();
    emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
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

  // ---------------------------------------------------------------------------------------------
  describe('valid manifest', () => {
    it('owner died after the lock, before any delivery existed: all recipients are sent once', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(4);
      const c = await orphan(contacts);

      assert.equal(await recoverCampaign(c._id, { emailService, logger }), 'resumed');
      await waitForCampaignDispatch(c._id);

      assert.deepEqual(sentTo(), contacts.map((x) => x.email).sort());
      const done = await raw(c._id);
      assert.equal(done.status, 'sent');
      assert.equal(done.stats.total, 4);
      assert.equal(done.stats.sent, 4);
      assert.equal(done.dispatchLeaseEpoch, 4);
    });

    it('owner died part-way through generation: the rest are generated, nobody is sent twice', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(6);
      const c = await orphan(contacts);
      // Two were generated (one already sent, one in flight when the owner died), four were not
      await Delivery.insertMany([
        deliveryFor(c, contacts[0], { status: 'sent', sentAt: new Date(), claimEpoch: 3, attempts: 1 }),
        deliveryFor(c, contacts[1], { status: 'processing', claimEpoch: 3, attempts: 1 }),
      ]);

      assert.equal(await recoverCampaign(c._id, { emailService, logger }), 'resumed');
      await waitForCampaignDispatch(c._id);

      assert.deepEqual(sentTo(), contacts.slice(2).map((x) => x.email).sort());
      const inFlight = await Delivery.findOne({ campaignId: c._id, contactId: contacts[1]._id }).lean();
      assert.equal(inFlight.status, 'failed');
      assert.equal(inFlight.errorCode, 'INTERRUPTED', 'an uncertain send is never retried');
      assert.equal(await Delivery.countDocuments({ campaignId: c._id }), 6);
      const done = await raw(c._id);
      assert.equal(done.status, 'sent');
      assert.deepEqual(
        { total: done.stats.total, sent: done.stats.sent, failed: done.stats.failed },
        { total: 6, sent: 5, failed: 1 }
      );
    });

    it('deliveries filled by recovery carry the new owner epoch as their fence', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(3);
      const c = await orphan(contacts);
      await Delivery.create(deliveryFor(c, contacts[0]));

      // Hold the transport so the filled deliveries can be inspected before they are claimed
      let open;
      const gate = new Promise((resolve) => (open = resolve));
      emailService = createEmailService({
        transport: { async sendMail(m) { await gate; return transport.sendMail(m); } },
        from: 'MailPulse Test <no-reply@mailpulse.test>',
      });

      assert.equal(await recoverCampaign(c._id, { emailService, logger, concurrency: 1 }), 'resumed');
      const deliveries = await Delivery.find({ campaignId: c._id }).lean();
      assert.equal(deliveries.length, 3);
      assert.ok(deliveries.every((d) => d.fence === 4), JSON.stringify(deliveries.map((d) => d.fence)));
      open();
      await waitForCampaignDispatch(c._id);
      assert.equal(transport.count, 3);
    });

    it('the watchdog and startup resume both complete generation, and count only resumed campaigns', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const a = await orphan(await makeContacts(2));
      const legacy = await orphan(await makeContacts(1), { manifest: false });

      assert.equal(await reapStalledCampaigns({ emailService, logger, stallTimeoutMs: 15 * 60 * 1000 }), 1);
      await waitForCampaignDispatch(a._id);
      assert.equal((await raw(a._id)).status, 'sent');

      const b = await orphan(await makeContacts(2));
      assert.equal(await resumeInterruptedDispatches({ emailService, logger: quiet }), 1);
      await waitForCampaignDispatch(b._id);
      assert.equal((await raw(b._id)).status, 'sent');

      assert.equal((await raw(legacy._id)).status, 'sending', 'the legacy campaign was never touched');
      assert.equal(transport.count, 4);
    });

    it('two recoveries of the same campaign at once: one lease, every recipient exactly once', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(10);
      const c = await orphan(contacts);
      await Delivery.insertMany(contacts.slice(0, 3).map((x) => deliveryFor(c, x)));

      const outcomes = await Promise.all([
        recoverCampaign(c._id, { emailService, logger }),
        recoverCampaign(c._id, { emailService, logger }),
      ]);
      assert.deepEqual(outcomes.sort(), ['resumed', 'skipped']);
      await waitForCampaignDispatch(c._id);
      assert.deepEqual(sentTo(), contacts.map((x) => x.email).sort());
      assert.equal(await Delivery.countDocuments({ campaignId: c._id }), 10);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('refused: nothing is swept, generated, sent or changed', () => {
    const assertUntouched = async (c, deliveriesBefore) => {
      const stored = await raw(c._id);
      assert.equal(stored.status, 'sending');
      assert.equal(stored.dispatchLeaseOwner, 'dead-process', 'the lease was not taken');
      assert.equal(stored.dispatchLeaseEpoch, 3);
      assert.deepEqual(await Delivery.find({ campaignId: c._id }).sort({ _id: 1 }).lean(), deliveriesBefore);
      assert.equal(transport.count, 0);
    };

    it('a legacy campaign (no manifest fields at all)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(3);
      const c = await orphan(contacts, { manifest: false });
      await Delivery.insertMany([deliveryFor(c, contacts[0], { status: 'processing', claimEpoch: 3 }), deliveryFor(c, contacts[1])]);
      const before = await Delivery.find({ campaignId: c._id }).sort({ _id: 1 }).lean();

      assert.equal(await recoverCampaign(c._id, { emailService, logger }), 'refused');
      assert.ok(errors.some((m) => /no dispatch manifest/.test(m)));
      await assertUntouched(c, before);
    });

    it('a corrupt manifest: partial fields, wrong count, unknown version, duplicate entry', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const corruptions = [
        { $unset: { dispatchManifestVersion: '' } },
        { $unset: { dispatchManifest: '' } },
        { $set: { dispatchManifestCount: 5 } },
        { $set: { dispatchManifestVersion: 2 } },
      ];
      for (const corruption of corruptions) {
        const contacts = await makeContacts(2);
        const c = await orphan(contacts);
        await setRaw(c._id, corruption);
        await Delivery.create(deliveryFor(c, contacts[0]));
        const before = await Delivery.find({ campaignId: c._id }).sort({ _id: 1 }).lean();

        assert.equal(await recoverCampaign(c._id, { emailService, logger }), 'refused', JSON.stringify(corruption));
        await assertUntouched(c, before);
      }
      const contacts = await makeContacts(1);
      const dup = await orphan(contacts);
      const [entry] = (await raw(dup._id)).dispatchManifest;
      await setRaw(dup._id, { $set: { dispatchManifest: [entry, entry], dispatchManifestCount: 2 } });
      assert.equal(await recoverCampaign(dup._id, { emailService, logger }), 'refused');
      await assertUntouched(dup, []);
      assert.ok(errors.every((m) => !contacts.some((x) => m.includes(x.email))), 'no recipient data in logs');
    });

    it('deliveries that do not match the manifest: nothing is dispatched', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(3);
      const [stray] = await makeContacts(1);
      const c = await orphan(contacts);
      await Delivery.insertMany([deliveryFor(c, contacts[0]), deliveryFor(c, stray)]);

      assert.equal(await recoverCampaign(c._id, { emailService, logger }), 'refused');
      assert.ok(errors.some((m) => /MEMBERSHIP_MISMATCH/.test(m)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(transport.count, 0);
      assert.equal(await Delivery.countDocuments({ campaignId: c._id, status: { $ne: 'pending' } }), 0, 'nothing was claimed');
      const stored = await raw(c._id);
      assert.equal(stored.status, 'sending');
      assert.ok(stored.dispatchLeaseUntil <= new Date(), 'the lease was given back');
    });

    it('a refusal is repeated on every sweep and never changes its mind', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const c = await orphan(await makeContacts(2), { manifest: false });
      for (let i = 0; i < 3; i += 1) {
        assert.equal(await reapStalledCampaigns({ emailService, logger, stallTimeoutMs: 15 * 60 * 1000 }), 0);
      }
      assert.equal((await raw(c._id)).status, 'sending');
      assert.equal(await Delivery.countDocuments({ campaignId: c._id }), 0);
      assert.equal(transport.count, 0);
    });
  });
});
