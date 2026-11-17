/**
 * The send lock only takes a DUE scheduled campaign, judged by MongoDB's clock: never a draft,
 * never a campaign scheduled for later, and never one that is due only by a worker's (skewed)
 * clock. Real MongoDB (isolated database); mock transport only, no email is sent.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('duelock');
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
import { pollScheduledCampaigns } from '../src/services/campaignScheduler.service.js';
import { serverNow } from './helpers/childHarness.js';

const quiet = { log() {}, warn() {}, error() {} };

describe('The send lock takes only due scheduled campaigns (MongoDB clock)', () => {
  let isDbConnected = false;
  let owner;
  let transport;
  let emailService;

  const makeContacts = () =>
    Contact.insertMany(
      ['Due One', 'Due Two'].map((name, i) => ({
        userId: owner._id,
        name,
        email: `due${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );

  const makeCampaign = (contacts, fields) =>
    Campaign.create({
      userId: owner._id,
      name: 'Due lock',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      recipientIds: contacts.map((c) => c._id),
      ...fields,
    });

  const lock = (campaign, contacts) =>
    startCampaignDispatch({ campaign, userId: owner._id, eligibleContacts: contacts, emailService, logger: quiet });

  /** Nothing was written: no lock, no manifest, no deliveries, no sends. */
  const assertUntouched = async (campaign, status) => {
    const raw = await mongoose.connection.collection('campaigns').findOne({ _id: campaign._id });
    assert.equal(raw.status, status);
    assert.ok(!('dispatchManifestVersion' in raw), 'no manifest');
    assert.ok(!('dispatchLeaseOwner' in raw), 'no lease');
    assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 0);
    assert.equal(transport.count, 0);
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Due Owner', email: `due-owner-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Due lock tests] MongoDB unavailable: ${err.message}`);
    }
    transport = createMockTransport();
    emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
  });

  afterEach(async () => {
    transport.clear();
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

  it('a draft is never locked', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await makeContacts();
    const draft = await makeCampaign(contacts, { status: 'draft' });
    assert.equal(await lock(draft, contacts), null);
    await assertUntouched(draft, 'draft');
  });

  it('a campaign scheduled for later is never locked', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await makeContacts();
    const later = await makeCampaign(contacts, { status: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000) });
    assert.equal(await lock(later, contacts), null);
    await assertUntouched(later, 'scheduled');
  });

  it('a worker whose clock runs ahead cannot lock a campaign that is not yet due by MongoDB time', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await makeContacts();
    const dbNow = await serverNow();
    const soon = await makeCampaign(contacts, { status: 'scheduled', scheduledAt: new Date(dbNow.getTime() + 30 * 60_000) });

    // The worker believes it is an hour later: by its clock the campaign is due
    const result = await pollScheduledCampaigns({ emailService, logger: quiet, now: new Date(dbNow.getTime() + 3600_000) });
    assert.equal(result.due, 1, 'the worker saw it as due');
    assert.equal(result.dispatched, 0, 'but the lock refused it');
    await assertUntouched(soon, 'scheduled');
  });

  it('a due scheduled campaign is locked exactly once', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await makeContacts();
    const due = await makeCampaign(contacts, { status: 'scheduled', scheduledAt: new Date(Date.now() - 1000) });

    const [first, second] = await Promise.all([lock(due, contacts), lock(due, contacts)]);
    assert.equal([first, second].filter(Boolean).length, 1);
    await waitForCampaignDispatch(due._id);
    assert.equal(transport.count, 2);
    assert.equal((await Campaign.findById(due._id).lean()).status, 'sent');
  });

  it('a campaign rescheduled into the future after the worker read it is not locked', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await makeContacts();
    const due = await makeCampaign(contacts, { status: 'scheduled', scheduledAt: new Date(Date.now() - 1000) });
    const readByWorker = await Campaign.findById(due._id);
    // Written without touching updatedAt, so only the due-time condition can refuse the lock
    await mongoose.connection
      .collection('campaigns')
      .updateOne({ _id: due._id }, { $set: { scheduledAt: new Date(Date.now() + 3600_000) } });

    assert.equal(await lock(readByWorker, contacts), null);
    await assertUntouched(due, 'scheduled');
  });
});
