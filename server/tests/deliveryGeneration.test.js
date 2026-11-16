/**
 * Delivery generation from the stored dispatch manifest: classification, idempotent generation and
 * exact-membership verification. Real MongoDB (isolated database); no email is ever sent.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('deliverygen');
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
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  startCampaignDispatch,
  waitForCampaignDispatch,
} from '../src/services/campaignDispatch.service.js';
import {
  DeliveryGenerationError,
  classifyStoredManifest,
  loadCampaignManifest,
  generateDeliveriesFromManifest,
  verifyDeliveriesMatchManifest,
  ensureDeliveriesFromManifest,
} from '../src/services/deliveryGeneration.service.js';
import { buildDispatchManifest } from '../src/utils/dispatchManifest.js';

const quiet = { log() {}, warn() {}, error() {} };
const oid = () => new mongoose.Types.ObjectId();

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof DeliveryGenerationError, `expected DeliveryGenerationError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });

describe('classifyStoredManifest (no DB)', () => {
  const entry = (overrides = {}) => ({ c: oid(), e: 'a@example.com', n: 'A', ...overrides });
  const valid = (n = 2) => {
    const entries = Array.from({ length: n }, (_, i) => entry({ e: `p${i}@example.com` }));
    return { dispatchManifestVersion: 1, dispatchManifestCount: n, dispatchManifest: entries };
  };

  it('valid: version 1, matching positive count, well-formed unique entries', () => {
    assert.equal(classifyStoredManifest(valid(1)), 'valid');
    assert.equal(classifyStoredManifest(valid(50)), 'valid');
    assert.equal(classifyStoredManifest({ ...valid(1), dispatchManifest: [entry({ n: '' })] }), 'valid');
  });

  it('legacy: only when all three fields are absent', () => {
    assert.equal(classifyStoredManifest({}), 'legacy');
    assert.equal(classifyStoredManifest({ status: 'sending', stats: { total: 3 } }), 'legacy');
    assert.equal(
      classifyStoredManifest({ dispatchManifestVersion: null, dispatchManifestCount: null, dispatchManifest: null }),
      'legacy'
    );
    assert.equal(classifyStoredManifest(null), 'legacy');
  });

  it('corrupt: a partial set of fields is never mistaken for legacy or valid', () => {
    const full = valid(2);
    assert.equal(classifyStoredManifest({ dispatchManifestVersion: 1 }), 'corrupt');
    assert.equal(classifyStoredManifest({ dispatchManifestCount: 2 }), 'corrupt');
    assert.equal(classifyStoredManifest({ dispatchManifest: full.dispatchManifest }), 'corrupt');
    assert.equal(classifyStoredManifest({ ...full, dispatchManifestVersion: undefined }), 'corrupt');
    assert.equal(classifyStoredManifest({ ...full, dispatchManifestCount: undefined }), 'corrupt');
    assert.equal(classifyStoredManifest({ ...full, dispatchManifest: undefined }), 'corrupt');
  });

  it('corrupt: unknown version, wrong count, empty, malformed or duplicated entries', () => {
    const full = valid(2);
    assert.equal(classifyStoredManifest({ ...full, dispatchManifestVersion: 2 }), 'corrupt');
    assert.equal(classifyStoredManifest({ ...full, dispatchManifestVersion: '1' }), 'corrupt');
    assert.equal(classifyStoredManifest({ ...full, dispatchManifestCount: 3 }), 'corrupt');
    assert.equal(classifyStoredManifest({ ...full, dispatchManifestCount: 1 }), 'corrupt');
    assert.equal(classifyStoredManifest({ ...full, dispatchManifestCount: 2.5 }), 'corrupt');
    assert.equal(
      classifyStoredManifest({ dispatchManifestVersion: 1, dispatchManifestCount: 0, dispatchManifest: [] }),
      'corrupt'
    );
    assert.equal(classifyStoredManifest({ ...full, dispatchManifest: 'not-an-array' }), 'corrupt');
    const withEntries = (entries) => ({ dispatchManifestVersion: 1, dispatchManifestCount: entries.length, dispatchManifest: entries });
    assert.equal(classifyStoredManifest(withEntries([entry({ c: String(oid()) })])), 'corrupt');
    assert.equal(classifyStoredManifest(withEntries([entry({ c: undefined })])), 'corrupt');
    assert.equal(classifyStoredManifest(withEntries([entry({ e: '' })])), 'corrupt');
    assert.equal(classifyStoredManifest(withEntries([entry({ e: 5 })])), 'corrupt');
    assert.equal(classifyStoredManifest(withEntries([entry({ n: undefined })])), 'corrupt');
    assert.equal(classifyStoredManifest(withEntries([null])), 'corrupt');
    const same = oid();
    assert.equal(classifyStoredManifest(withEntries([entry({ c: same }), entry({ c: same })])), 'corrupt');
  });
});

describe('Delivery generation from the stored manifest', () => {
  let isDbConnected = false;
  let owner;
  let otherTenant;
  let transport;
  let emailService;

  const makeContacts = (n, user = owner) =>
    Contact.insertMany(
      Array.from({ length: n }, (_, i) => ({
        userId: user._id,
        name: `Recipient ${i}`,
        email: `${oid().toString()}@example.com`,
      }))
    );

  /** A campaign already locked for sending, carrying a real manifest for `contacts`. */
  const makeLockedCampaign = async (contacts, overrides = {}) => {
    const manifest = buildDispatchManifest(contacts);
    return Campaign.create({
      userId: owner._id,
      name: 'Generation campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sending',
      sendStartedAt: new Date(),
      recipientIds: contacts.map((c) => c._id),
      dispatchManifestVersion: manifest.version,
      dispatchManifestCount: manifest.count,
      dispatchManifest: manifest.entries,
      ...overrides,
    });
  };

  const paramsFor = async (campaignId) => {
    const stored = await loadCampaignManifest(campaignId);
    return {
      campaignId: stored._id,
      userId: stored.userId,
      subjectB: stored.subjectB,
      entries: stored.dispatchManifest,
    };
  };

  const deliveriesOf = (campaignId) => Delivery.find({ campaignId }).sort({ _id: 1 }).lean();

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Gen Owner', email: `gen-owner-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
      otherTenant = await User.create({ name: 'Gen Other', email: `gen-other-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Delivery generation tests] MongoDB unavailable: ${err.message}`);
    }
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
  describe('generate', () => {
    it('creates exactly one pending delivery per manifest entry, with the manifest snapshot', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(4);
      const campaign = await makeLockedCampaign(contacts);

      await generateDeliveriesFromManifest(await paramsFor(campaign._id));

      const deliveries = await deliveriesOf(campaign._id);
      assert.equal(deliveries.length, 4);
      const byContact = new Map(deliveries.map((d) => [String(d.contactId), d]));
      for (const contact of contacts) {
        const delivery = byContact.get(String(contact._id));
        assert.ok(delivery, 'a manifest entry has no delivery');
        assert.equal(delivery.email, contact.email);
        assert.equal(delivery.name, contact.name);
        assert.equal(String(delivery.userId), String(owner._id));
        assert.equal(delivery.status, 'pending');
        assert.equal(delivery.variant, 'A');
        assert.equal(delivery.fence ?? null, null);
      }
    });

    it('assigns A/B variants by manifest position, identically on every run', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(5);
      const campaign = await makeLockedCampaign(contacts, { subjectB: 'Variant B subject' });
      const params = await paramsFor(campaign._id);

      await generateDeliveriesFromManifest(params);
      const first = new Map((await deliveriesOf(campaign._id)).map((d) => [String(d.contactId), d.variant]));
      await Delivery.deleteMany({ campaignId: campaign._id });
      await generateDeliveriesFromManifest(params);
      const second = new Map((await deliveriesOf(campaign._id)).map((d) => [String(d.contactId), d.variant]));

      params.entries.forEach((entry, index) => {
        const expected = index % 2 === 1 ? 'B' : 'A';
        assert.equal(first.get(String(entry.c)), expected);
        assert.equal(second.get(String(entry.c)), expected);
      });
    });

    it('is idempotent: repeating it adds nothing and changes nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(3);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);

      await generateDeliveriesFromManifest(params);
      const before = await deliveriesOf(campaign._id);
      await generateDeliveriesFromManifest(params);
      await generateDeliveriesFromManifest(params);
      assert.deepEqual(await deliveriesOf(campaign._id), before);
    });

    it('fills only what is missing and never touches deliveries that already exist', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(5);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);

      // A partial list left behind by an interrupted generator, already in different states
      await Delivery.insertMany([
        { campaignId: campaign._id, userId: owner._id, contactId: contacts[0]._id, email: contacts[0].email, status: 'sent', sentAt: new Date(), messageId: '<kept@test>' },
        { campaignId: campaign._id, userId: owner._id, contactId: contacts[1]._id, email: contacts[1].email, status: 'failed', errorCode: 'INTERRUPTED' },
        { campaignId: campaign._id, userId: owner._id, contactId: contacts[2]._id, email: contacts[2].email, status: 'processing', claimEpoch: 1 },
      ]);
      const existing = await deliveriesOf(campaign._id);

      await generateDeliveriesFromManifest(params);

      const all = await deliveriesOf(campaign._id);
      assert.equal(all.length, 5);
      for (const kept of existing) {
        assert.deepEqual(all.find((d) => String(d._id) === String(kept._id)), kept);
      }
      const added = all.filter((d) => !existing.some((kept) => String(kept._id) === String(d._id)));
      assert.deepEqual(
        added.map((d) => String(d.contactId)).sort(),
        [String(contacts[3]._id), String(contacts[4]._id)].sort()
      );
      assert.ok(added.every((d) => d.status === 'pending'));
    });

    it('two generators running at once still produce exactly the manifest', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(40);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);

      await Promise.all([
        generateDeliveriesFromManifest(params),
        generateDeliveriesFromManifest(params),
        generateDeliveriesFromManifest(params),
      ]);
      assert.equal(await verifyDeliveriesMatchManifest(params), 40);
    });

    it('gives inserted deliveries the requested fence', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(2);
      const campaign = await makeLockedCampaign(contacts);
      await generateDeliveriesFromManifest({ ...(await paramsFor(campaign._id)), fence: 7 });
      const deliveries = await deliveriesOf(campaign._id);
      assert.deepEqual(deliveries.map((d) => d.fence), [7, 7]);
    });

    it('fails on any insert error that is not a duplicate key, even alongside duplicates', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(2);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);

      const failures = [
        Object.assign(new Error('mixed'), { writeErrors: [{ code: 11000 }, { code: 121 }] }),
        Object.assign(new Error('network'), { name: 'MongoNetworkError' }),
        Object.assign(new Error('nested'), { writeErrors: [{ err: { code: 11000 } }, { err: { code: 50 } }] }),
      ];
      for (const failure of failures) {
        const mock = t.mock.method(Delivery, 'insertMany', async () => {
          throw failure;
        });
        await rejectsWith(generateDeliveriesFromManifest(params), 'INSERT_FAILED');
        mock.mock.restore();
      }

      // Duplicate-key rejections alone are the normal "already generated" outcome
      for (const duplicateOnly of [
        Object.assign(new Error('dups'), { writeErrors: [{ code: 11000 }, { err: { code: 11000 } }] }),
        Object.assign(new Error('dup'), { code: 11000 }),
      ]) {
        const mock = t.mock.method(Delivery, 'insertMany', async () => {
          throw duplicateOnly;
        });
        await generateDeliveriesFromManifest(params);
        mock.mock.restore();
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('verify', () => {
    it('passes only when the deliveries are exactly the manifest', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(3);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);

      await rejectsWith(verifyDeliveriesMatchManifest(params), 'MEMBERSHIP_MISMATCH'); // nothing yet
      await generateDeliveriesFromManifest(params);
      assert.equal(await verifyDeliveriesMatchManifest(params), 3);
    });

    it('rejects a missing delivery', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(3);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);
      await generateDeliveriesFromManifest(params);
      await Delivery.deleteOne({ campaignId: campaign._id, contactId: contacts[1]._id });
      await rejectsWith(verifyDeliveriesMatchManifest(params), 'MEMBERSHIP_MISMATCH');
    });

    it('rejects an extra delivery for a contact that is not in the manifest, even when the count matches', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(3);
      const [stray] = await makeContacts(1);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);
      await generateDeliveriesFromManifest(params);

      await Delivery.create({ campaignId: campaign._id, userId: owner._id, contactId: stray._id, email: stray.email, status: 'pending' });
      await rejectsWith(verifyDeliveriesMatchManifest(params), 'MEMBERSHIP_MISMATCH');

      // Same count as the manifest, wrong membership
      await Delivery.deleteOne({ campaignId: campaign._id, contactId: contacts[0]._id });
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 3);
      await rejectsWith(verifyDeliveriesMatchManifest(params), 'MEMBERSHIP_MISMATCH');
    });

    it('rejects a delivery whose address or owner differs from the manifest', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(2);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);
      await generateDeliveriesFromManifest(params);

      await Delivery.updateOne({ campaignId: campaign._id, contactId: contacts[0]._id }, { $set: { email: 'someone-else@example.com' } });
      await rejectsWith(verifyDeliveriesMatchManifest(params), 'MEMBERSHIP_MISMATCH');
      await Delivery.updateOne({ campaignId: campaign._id, contactId: contacts[0]._id }, { $set: { email: contacts[0].email } });
      assert.equal(await verifyDeliveriesMatchManifest(params), 2);

      await Delivery.updateOne({ campaignId: campaign._id, contactId: contacts[1]._id }, { $set: { userId: otherTenant._id } });
      await rejectsWith(verifyDeliveriesMatchManifest(params), 'MEMBERSHIP_MISMATCH');
    });

    it('never puts recipient data in the error message', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(2);
      const campaign = await makeLockedCampaign(contacts);
      const params = await paramsFor(campaign._id);
      await generateDeliveriesFromManifest({ ...params, entries: params.entries.slice(0, 1) });

      await assert.rejects(verifyDeliveriesMatchManifest(params), (error) => {
        for (const contact of contacts) {
          assert.ok(!error.message.includes(contact.email));
          assert.ok(!error.message.includes(contact.name));
          assert.ok(!error.message.includes(String(contact._id)));
        }
        assert.match(error.message, /expected 2, found 1, missing 1/);
        return true;
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ensure (classify, generate, verify) against the STORED manifest', () => {
    it('reads the manifest from the database, generates and verifies', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(6);
      const campaign = await makeLockedCampaign(contacts);
      assert.deepEqual(await ensureDeliveriesFromManifest(campaign._id), { count: 6 });
      assert.deepEqual(await ensureDeliveriesFromManifest(campaign._id), { count: 6 });
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 6);
    });

    it('refuses a campaign without a manifest, and creates nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(2);
      const legacy = await Campaign.create({
        userId: owner._id,
        name: 'Legacy',
        subject: 'Hello',
        textContent: 'Body',
        status: 'sending',
        recipientIds: contacts.map((c) => c._id),
      });
      await rejectsWith(ensureDeliveriesFromManifest(legacy._id), 'MANIFEST_LEGACY');
      assert.equal(await Delivery.countDocuments({ campaignId: legacy._id }), 0);
    });

    it('refuses a corrupt manifest, and creates nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(3);
      const campaign = await makeLockedCampaign(contacts);
      const raw = mongoose.connection.collection('campaigns');

      await raw.updateOne({ _id: campaign._id }, { $set: { dispatchManifestCount: 4 } });
      await rejectsWith(ensureDeliveriesFromManifest(campaign._id), 'MANIFEST_CORRUPT');

      await raw.updateOne({ _id: campaign._id }, { $set: { dispatchManifestCount: 3 }, $unset: { dispatchManifestVersion: '' } });
      await rejectsWith(ensureDeliveriesFromManifest(campaign._id), 'MANIFEST_CORRUPT');

      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
    });

    it('reports a campaign that does not exist', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      await rejectsWith(ensureDeliveriesFromManifest(oid()), 'CAMPAIGN_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('the send lock generates from the stored manifest and verifies before dispatch', () => {
    const draftFor = (contacts, overrides = {}) =>
      Campaign.create({
        userId: owner._id,
        name: 'Lock generation',
        subject: 'Hello',
        textContent: 'Body',
        htmlContent: '<p>Body</p>',
        status: 'draft',
        recipientIds: contacts.map((c) => c._id),
        ...overrides,
      });

    const useTransport = () => {
      transport = createMockTransport();
      emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
    };

    it('deliveries are exactly the stored manifest and every recipient is sent once', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      useTransport();
      const contacts = await makeContacts(7);
      const campaign = await draftFor(contacts);

      const locked = await startCampaignDispatch({ campaign, userId: owner._id, eligibleContacts: contacts, emailService, logger: quiet });
      assert.ok(locked);
      await waitForCampaignDispatch(campaign._id);

      assert.equal(await verifyDeliveriesMatchManifest(await paramsFor(campaign._id)), 7);
      assert.equal(transport.count, 7);
      assert.deepEqual(
        transport.sentEmails.map((mail) => mail.to).sort(),
        contacts.map((c) => c.email).sort()
      );
      assert.equal((await Campaign.findById(campaign._id).lean()).status, 'sent');
    });

    const assertAcceptedButNotDispatched = async (campaignId) => {
      await waitForCampaignDispatch(campaignId);
      assert.equal(transport.count, 0, 'nothing was sent');
      const stored = await mongoose.connection.collection('campaigns').findOne({ _id: campaignId });
      assert.equal(stored.status, 'sending', 'accepted, not returned to draft');
      assert.equal(stored.dispatchManifestVersion, 1);
      assert.ok(stored.dispatchLeaseUntil <= new Date(), 'lease handed back for recovery');
      assert.equal(await Delivery.countDocuments({ campaignId, status: { $ne: 'pending' } }), 0, 'nothing was claimed');
    };

    it('does not dispatch anything when the deliveries do not match the manifest', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      useTransport();
      const contacts = await makeContacts(3);
      const [stray] = await makeContacts(1);
      const campaign = await draftFor(contacts);
      // A delivery that does not belong to this campaign's manifest already exists
      await Delivery.create({ campaignId: campaign._id, userId: owner._id, contactId: stray._id, email: stray.email, status: 'pending' });
      const errors = [];

      const locked = await startCampaignDispatch({
        campaign, userId: owner._id, eligibleContacts: contacts, emailService,
        logger: { ...quiet, error: (m) => errors.push(m) },
      });
      assert.ok(locked);
      assert.ok(errors.some((m) => /MEMBERSHIP_MISMATCH/.test(m)));
      await assertAcceptedButNotDispatched(campaign._id);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 4, 'no delivery was deleted');
    });

    it('does not dispatch anything when generation fails, and deletes nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      useTransport();
      const contacts = await makeContacts(3);
      const campaign = await draftFor(contacts);
      const errors = [];
      const mock = t.mock.method(Delivery, 'insertMany', async () => {
        throw Object.assign(new Error('boom'), { name: 'MongoNetworkError' });
      });

      const locked = await startCampaignDispatch({
        campaign, userId: owner._id, eligibleContacts: contacts, emailService,
        logger: { ...quiet, error: (m) => errors.push(m) },
      });
      mock.mock.restore();
      assert.ok(locked);
      assert.ok(errors.some((m) => /INSERT_FAILED/.test(m)));
      await assertAcceptedButNotDispatched(campaign._id);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
    });
  });
});
