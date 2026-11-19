/**
 * The dispatch lock records a versioned recipient manifest in the SAME atomic update that moves a
 * campaign to 'sending' and takes its lease.
 *
 * These tests use real MongoDB (an isolated database, because they leave campaigns in 'sending')
 * and, for the competing-workers case, real separate Node.js processes. No email is ever sent:
 * every transport is a mock.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';
import { createChildHarness } from './helpers/childHarness.js';

const DB_URI = isolatedMongoUri('manifestlock');
process.env.MONGODB_URI = DB_URI;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import { installAutoSender } from './helpers/sender.js';
installAutoSender(Campaign);
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  startCampaignDispatch,
  waitForCampaignDispatch,
} from '../src/services/campaignDispatch.service.js';
import { pollScheduledCampaigns } from '../src/services/campaignScheduler.service.js';
import { INSTANCE_ID } from '../src/services/dispatchLease.service.js';
import { formatSafeCampaign } from '../src/controllers/campaign.controller.js';
import { buildAccountExport } from '../src/services/account.service.js';
import { DISPATCH_MANIFEST_VERSION, DispatchManifestError } from '../src/utils/dispatchManifest.js';

const LEASE_MS = 3000;
const quiet = { log() {}, warn() {}, error() {} };
const MANIFEST_FIELDS = ['dispatchManifestVersion', 'dispatchManifestCount', 'dispatchManifest'];

describe('Dispatch lock records a versioned recipient manifest', () => {
  let isDbConnected = false;
  let server;
  let baseUrl;
  let owner;
  let ownerToken;
  let otherTenant;
  let otherToken;
  let openGates = [];
  const { spawnChild, killAll } = createChildHarness({ dbUri: DB_URI, leaseMs: LEASE_MS });

  /** The stored document exactly as MongoDB holds it (no Mongoose projection or casting). */
  const rawCampaign = (id) =>
    mongoose.connection.collection('campaigns').findOne({ _id: new mongoose.Types.ObjectId(String(id)) });

  const makeContacts = (names, user = owner) =>
    Contact.insertMany(
      names.map((name) => ({
        userId: user._id,
        name,
        email: `${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );

  const makeCampaign = (contacts, overrides = {}) =>
    Campaign.create({
      userId: owner._id,
      name: 'Manifest lock campaign',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000), // due: only due scheduled campaigns can be locked
      recipientIds: contacts.map((c) => c._id),
      ...overrides,
    });

  /** A mock email service whose sends block until `open()`, so the campaign stays 'sending'. */
  const gatedEmailService = () => {
    const transport = createMockTransport();
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    openGates.push(open);
    const emailService = createEmailService({
      transport: {
        async sendMail(message) {
          await gate;
          return transport.sendMail(message);
        },
      },
      from: 'MailPulse Test <no-reply@mailpulse.test>',
    });
    return { emailService, transport, open };
  };

  const lock = (campaign, contacts, extra = {}) =>
    startCampaignDispatch({
      campaign,
      userId: owner._id,
      eligibleContacts: contacts,
      logger: quiet,
      ...extra,
    });

  const assertNoManifest = (raw) => {
    for (const field of MANIFEST_FIELDS) {
      assert.ok(!(field in raw), `${field} must not be present`);
    }
  };

  const request = (urlPath, token) =>
    fetch(`${baseUrl}${urlPath}`, { headers: { Authorization: `Bearer ${token}` } });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Manifest Owner', email: `ml-owner-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
      otherTenant = await User.create({ name: 'Other Tenant', email: `ml-other-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
      ownerToken = signAccessToken(owner);
      otherToken = signAccessToken(otherTenant);
    } catch (err) {
      console.warn(`[Manifest lock tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    killAll();
    for (const open of openGates) open();
    openGates = [];
    if (isDbConnected) {
      const campaigns = await Campaign.find({}).select('_id').lean();
      await Promise.all(campaigns.map((c) => waitForCampaignDispatch(c._id)));
      await mongoose.connection.collection('probe_sends').deleteMany({});
      await Delivery.deleteMany({});
      await Campaign.deleteMany({});
      await Contact.deleteMany({});
    }
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  // ---------------------------------------------------------------------------------------------
  describe('written atomically with the lock', () => {
    it('status, lease and all three manifest fields appear together in one update', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Ada Lovelace', 'Grace Hopper', 'Edsger Dijkstra']);
      const campaign = await makeCampaign(contacts);
      assertNoManifest(await rawCampaign(campaign._id));

      // An observer reads the stored document as fast as it can while the lock runs. Whatever it
      // sees must be all-or-nothing: 'sending' + lease + complete manifest, or none of them.
      const inconsistencies = [];
      let observing = true;
      const observer = (async () => {
        while (observing) {
          const raw = await rawCampaign(campaign._id);
          const sending = raw.status === 'sending';
          const leased = Boolean(raw.dispatchLeaseOwner) && raw.dispatchLeaseUntil instanceof Date;
          const hasManifest =
            raw.dispatchManifestVersion === DISPATCH_MANIFEST_VERSION &&
            raw.dispatchManifestCount === contacts.length &&
            Array.isArray(raw.dispatchManifest) &&
            raw.dispatchManifest.length === contacts.length;
          const anyManifestField = MANIFEST_FIELDS.some((field) => field in raw);
          if (sending !== leased || sending !== hasManifest || sending !== anyManifestField) {
            inconsistencies.push({ status: raw.status, leased, hasManifest, anyManifestField });
          }
        }
      })();

      const { emailService } = gatedEmailService();
      const locked = await lock(campaign, contacts, { emailService });
      await new Promise((resolve) => setTimeout(resolve, 100));
      observing = false;
      await observer;

      assert.ok(locked, 'the lock must be granted');
      assert.deepEqual(inconsistencies, []);

      const raw = await rawCampaign(campaign._id);
      assert.equal(raw.status, 'sending');
      assert.equal(raw.dispatchLeaseOwner, INSTANCE_ID);
      assert.equal(raw.dispatchLeaseEpoch, 1);
      assert.equal(raw.dispatchManifestVersion, DISPATCH_MANIFEST_VERSION);
      assert.equal(raw.dispatchManifestCount, contacts.length);
      assert.equal(raw.dispatchManifest.length, contacts.length);
    });

    it('a lock that is refused writes no manifest field at all', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Stale Version']);
      const { emailService } = gatedEmailService();

      // 1. The campaign changed after it was evaluated (different updatedAt)
      const edited = await makeCampaign(contacts);
      const staleCopy = await Campaign.findById(edited._id);
      await mongoose.connection.collection('campaigns').updateOne(
        { _id: edited._id },
        { $set: { subject: 'Edited after evaluation', updatedAt: new Date(staleCopy.updatedAt.getTime() + 1000) } }
      );
      assert.equal(await lock(staleCopy, contacts, { emailService }), null);
      const afterStale = await rawCampaign(edited._id);
      assert.equal(afterStale.status, 'scheduled');
      assertNoManifest(afterStale);

      // 2. The campaign is not a draft or scheduled campaign
      const sent = await makeCampaign(contacts, { status: 'sent' });
      assert.equal(await lock(sent, contacts, { emailService }), null);
      assertNoManifest(await rawCampaign(sent._id));

      assert.equal(await Delivery.countDocuments({}), 0);
    });

    it('a recipient list that cannot be stored throws before the lock and changes nothing', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Too Many One', 'Too Many Two']);
      const campaign = await makeCampaign(contacts);
      const { emailService } = gatedEmailService();

      await assert.rejects(
        lock(campaign, contacts, { emailService, manifestLimits: { maxRecipients: 1 } }),
        (error) => error instanceof DispatchManifestError && error.code === 'TOO_MANY_RECIPIENTS'
      );
      const raw = await rawCampaign(campaign._id);
      assert.equal(raw.status, 'scheduled');
      assert.ok(!('dispatchLeaseOwner' in raw));
      assertNoManifest(raw);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
    });

    it('the scheduler fails a due campaign whose recipients cannot be stored, without locking it', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Sched One', 'Sched Two']);
      const campaign = await makeCampaign(contacts, {
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 1000),
      });
      const { emailService, transport } = gatedEmailService();

      const result = await pollScheduledCampaigns({
        emailService,
        logger: quiet,
        manifestLimits: { maxRecipients: 1 },
      });
      assert.equal(result.failed, 1);
      assert.equal(result.dispatched, 0);

      const raw = await rawCampaign(campaign._id);
      assert.equal(raw.status, 'failed');
      assert.ok(!('dispatchLeaseOwner' in raw));
      assertNoManifest(raw);
      assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
      assert.equal(transport.count, 0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('competing workers (real processes)', () => {
    it('only one of two simultaneous workers obtains the lock, and the manifest is exactly its snapshot', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      for (let round = 0; round < 3; round += 1) {
        const contacts = await makeContacts(['Racer Alpha', 'Racer Beta', 'Racer Gamma']);
        const campaign = await makeCampaign(contacts);
        const ids = contacts.map((c) => String(c._id));
        // The two workers evaluated DIFFERENT eligible snapshots, so the stored manifest shows
        // unambiguously whose lock was recorded, and that the loser contributed nothing.
        const snapshots = [ids.slice(0, 2), ids];

        const workers = await Promise.all([spawnChild(), spawnChild()]);
        const startAt = Date.now() + 600;
        const results = await Promise.all(
          workers.map((worker, i) =>
            worker.ask('lock', { campaignId: String(campaign._id), contactIds: snapshots[i], startAt })
          )
        );

        const winners = results.filter((r) => r.locked);
        assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
        assert.equal(winners[0].epoch, 1);
        const winnerIndex = results.findIndex((r) => r.locked);
        const winnerInfo = await workers[winnerIndex].ask('info');

        const raw = await rawCampaign(campaign._id);
        assert.equal(raw.status, 'sending');
        assert.equal(raw.dispatchLeaseEpoch, 1);
        assert.equal(raw.dispatchLeaseOwner, winnerInfo.instanceId);
        assert.equal(raw.dispatchManifestVersion, DISPATCH_MANIFEST_VERSION);
        assert.equal(raw.dispatchManifestCount, snapshots[winnerIndex].length);
        assert.deepEqual(
          raw.dispatchManifest.map((entry) => String(entry.c)).sort(),
          [...snapshots[winnerIndex]].sort()
        );
        assert.equal(raw.stats.total, snapshots[winnerIndex].length);

        killAll();
        await Delivery.deleteMany({});
        await Campaign.deleteMany({});
        await Contact.deleteMany({});
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('persisted contents', () => {
    it('stores version 1, the count, and one { c, e, n } entry per eligible contact, in order', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Ada Lovelace', 'Grace Hopper', 'Edsger Dijkstra']);
      const campaign = await makeCampaign(contacts);
      const { emailService } = gatedEmailService();

      await lock(campaign, contacts, { emailService });
      const raw = await rawCampaign(campaign._id);

      assert.equal(raw.dispatchManifestVersion, 1);
      assert.equal(raw.dispatchManifestCount, 3);
      assert.equal(raw.dispatchManifest.length, 3);
      raw.dispatchManifest.forEach((entry, i) => {
        assert.deepEqual(Object.keys(entry).sort(), ['c', 'e', 'n']);
        assert.ok(entry.c instanceof mongoose.Types.ObjectId);
        assert.ok(entry.c.equals(contacts[i]._id));
        assert.equal(entry.e, contacts[i].email);
        assert.equal(entry.n, contacts[i].name);
      });
    });

    it('stores names that look like MongoDB expressions as literal text', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const names = ['$status', '$$NOW', '$dispatchLeaseOwner', '{ "$literal": 1 }'];
      const contacts = names.map((name, i) => ({
        _id: new mongoose.Types.ObjectId(),
        name,
        email: `expr-${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
      }));
      const campaign = await makeCampaign(contacts);
      const { emailService } = gatedEmailService();

      await lock(campaign, contacts, { emailService });
      const raw = await rawCampaign(campaign._id);
      assert.deepEqual(raw.dispatchManifest.map((entry) => entry.n), names);
      assert.equal(raw.status, 'sending');
    });

    it('is not changed by any later write path: updateOne, $unset, findOneAndUpdate or save()', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Immutable One', 'Immutable Two']);
      const campaign = await makeCampaign(contacts);
      const { emailService } = gatedEmailService();
      await lock(campaign, contacts, { emailService });
      const before = await rawCampaign(campaign._id);

      const tamper = { dispatchManifestVersion: 7, dispatchManifestCount: 99, dispatchManifest: [] };
      const attempts = [
        () => Campaign.updateOne({ _id: campaign._id }, { $set: tamper }),
        () => Campaign.updateOne({ _id: campaign._id }, tamper),
        () => Campaign.updateMany({ _id: campaign._id }, { $set: tamper }),
        () => Campaign.findOneAndUpdate({ _id: campaign._id }, { $set: tamper }),
        () =>
          Campaign.updateOne(
            { _id: campaign._id },
            { $unset: { dispatchManifestVersion: '', dispatchManifestCount: '', dispatchManifest: '' } }
          ),
        async () => {
          const doc = await Campaign.findById(campaign._id).select('+dispatchManifest');
          doc.dispatchManifestVersion = 7;
          doc.dispatchManifestCount = 99;
          doc.dispatchManifest = [];
          doc.name = 'Renamed while tampering';
          await doc.save();
        },
      ];
      for (const attempt of attempts) {
        // Mongoose may ignore the immutable paths or reject the write; either way nothing changes
        await attempt().catch(() => {});
        const now = await rawCampaign(campaign._id);
        assert.equal(now.dispatchManifestVersion, before.dispatchManifestVersion);
        assert.equal(now.dispatchManifestCount, before.dispatchManifestCount);
        assert.deepEqual(now.dispatchManifest, before.dispatchManifest);
      }
    });

    it('a campaign that already carries a manifest can never be locked again, so it is never replaced', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['First Lock A', 'First Lock B', 'Second Lock Only']);
      const campaign = await makeCampaign(contacts);
      const first = gatedEmailService();
      await lock(campaign, contacts.slice(0, 2), { emailService: first.emailService });
      first.open();
      await waitForCampaignDispatch(campaign._id);
      const before = await rawCampaign(campaign._id);

      // Even if the campaign were forced back to 'draft' (no supported path does this), a second
      // lock must not match: the stored manifest stays exactly the first one.
      await mongoose.connection
        .collection('campaigns')
        .updateOne({ _id: campaign._id }, { $set: { status: 'draft' }, $unset: { dispatchLeaseOwner: '', dispatchLeaseUntil: '' } });
      const again = await Campaign.findById(campaign._id);
      const second = gatedEmailService();
      const relocked = await lock(again, [contacts[2]], { emailService: second.emailService });

      assert.equal(relocked, null);
      const raw = await rawCampaign(campaign._id);
      assert.equal(raw.status, 'draft');
      assert.equal(raw.dispatchLeaseEpoch, before.dispatchLeaseEpoch);
      assert.equal(raw.dispatchManifestCount, 2);
      assert.deepEqual(raw.dispatchManifest, before.dispatchManifest);
      assert.equal(second.transport.count, 0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('query visibility', () => {
    it('ordinary queries never load the manifest; explicit selection does', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Hidden One', 'Hidden Two']);
      const campaign = await makeCampaign(contacts);
      const { emailService } = gatedEmailService();
      const locked = await lock(campaign, contacts, { emailService });

      // The document returned by the lock itself
      assert.equal(locked.dispatchManifest, undefined);
      assert.ok(!('dispatchManifest' in locked.toObject()));

      const ordinary = [
        await Campaign.findById(campaign._id),
        await Campaign.findById(campaign._id).lean(),
        await Campaign.findOne({ _id: campaign._id, userId: owner._id }),
        (await Campaign.find({ userId: owner._id }).lean())[0],
        (await Campaign.find({ userId: owner._id }).select('name status'))[0],
        await Campaign.findOneAndUpdate({ _id: campaign._id }, { $set: { name: 'Renamed' } }, { new: true }),
      ];
      for (const doc of ordinary) {
        const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
        assert.ok(!('dispatchManifest' in plain), 'manifest loaded by an ordinary query');
      }

      const explicit = await Campaign.findById(campaign._id)
        .select('+dispatchManifest dispatchManifestVersion dispatchManifestCount')
        .lean();
      assert.equal(explicit.dispatchManifestVersion, 1);
      assert.equal(explicit.dispatchManifestCount, 2);
      assert.deepEqual(
        explicit.dispatchManifest.map((entry) => ({ c: String(entry.c), e: entry.e, n: entry.n })),
        contacts.map((c) => ({ c: String(c._id), e: c.email, n: c.name }))
      );

      const withEverything = await Campaign.findById(campaign._id).select('+dispatchManifest').lean();
      assert.equal(withEverything.dispatchManifest.length, 2);
      assert.equal(withEverything.status, 'sending');
    });

    it('a campaign that was never locked has no manifest fields, not empty ones', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Never Locked']);
      const campaign = await makeCampaign(contacts);
      assertNoManifest(await rawCampaign(campaign._id));
      const loaded = await Campaign.findById(campaign._id).select('+dispatchManifest').lean();
      assert.equal(loaded.dispatchManifest, undefined);
      assert.equal(loaded.dispatchManifestVersion, undefined);
      assert.equal(loaded.dispatchManifestCount, undefined);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('tenant isolation and response privacy', () => {
    it("the lock is scoped to the owner: another tenant's user id locks nothing and records nothing", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Scoped One']);
      const campaign = await makeCampaign(contacts);
      const { emailService } = gatedEmailService();

      const locked = await startCampaignDispatch({
        campaign,
        userId: otherTenant._id,
        eligibleContacts: contacts,
        emailService,
        logger: quiet,
      });
      assert.equal(locked, null);
      const raw = await rawCampaign(campaign._id);
      assert.equal(raw.status, 'scheduled');
      assertNoManifest(raw);
      assert.equal(await Delivery.countDocuments({}), 0);
    });

    it('API responses, safe formatting and the account export never contain the manifest', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const contacts = await makeContacts(['Private Recipient Uno', 'Private Recipient Dos']);
      const campaign = await makeCampaign(contacts);
      const { emailService } = gatedEmailService();
      await lock(campaign, contacts, { emailService });

      const assertPrivate = (text) => {
        assert.ok(!/dispatchManifest/.test(text), 'response mentions the manifest');
        for (const c of contacts) {
          assert.ok(!text.includes(c.email), 'response contains a recipient address');
          assert.ok(!text.includes(c.name), 'response contains a recipient name');
        }
      };

      // Owner: detail and list
      const detail = await request(`/api/v1/campaigns/${campaign._id}`, ownerToken);
      assert.equal(detail.status, 200);
      assertPrivate(await detail.text());
      const list = await request('/api/v1/campaigns', ownerToken);
      assert.equal(list.status, 200);
      assertPrivate(await list.text());

      // Another tenant: nothing at all
      const foreign = await request(`/api/v1/campaigns/${campaign._id}`, otherToken);
      assert.equal(foreign.status, 404);
      assertPrivate(await foreign.text());
      const foreignList = await request('/api/v1/campaigns', otherToken);
      assertPrivate(await foreignList.text());

      // Safe formatting drops the manifest even when a caller explicitly loaded it
      const loaded = await Campaign.findById(campaign._id).select('+dispatchManifest');
      assert.equal(loaded.dispatchManifest.length, 2);
      assertPrivate(JSON.stringify(formatSafeCampaign(loaded)));

      // Account data export: campaigns carry no manifest fields
      const exported = await buildAccountExport(owner._id);
      const exportedCampaign = exported.campaigns.find((c) => String(c._id) === String(campaign._id));
      assert.ok(exportedCampaign);
      for (const field of MANIFEST_FIELDS) {
        assert.ok(!(field in exportedCampaign), `${field} present in the account export`);
      }
    });
  });
});
