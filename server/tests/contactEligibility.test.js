/**
 * Pre-send eligibility against LIVE contact data. The manifest fixes who a campaign was locked
 * to; it never makes a recipient eligible. Immediately before each send the dispatcher skips:
 *   - SUPPRESSED       address on the suppression list, or contact unsubscribed
 *   - CONTACT_REMOVED  contact deleted after the lock, or no longer the owner's
 *   - CONTACT_CHANGED  contact's email address changed after the lock
 * Real MongoDB (isolated database); mock transport only, no email is sent.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('contacteligibility');
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
import Delivery, { DELIVERY_ERROR_CODES } from '../src/models/Delivery.js';
import Suppression from '../src/models/Suppression.js';
import { connectDB } from '../src/config/db.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  startCampaignDispatch,
  recoverCampaign,
  waitForCampaignDispatch,
} from '../src/services/campaignDispatch.service.js';
import { manifestFieldsFor } from './helpers/manifest.js';

const quiet = { log() {}, warn() {}, error() {} };

describe('Pre-send contact eligibility', () => {
  let isDbConnected = false;
  let owner;
  let otherTenant;
  let transport;
  let emailService;

  const makeContacts = (names, user = owner) =>
    Contact.insertMany(
      names.map((name, i) => ({
        userId: user._id,
        name,
        email: `elig${i}-${new mongoose.Types.ObjectId().toString()}@example.com`,
      }))
    );

  /** A campaign already locked and generated, whose owner died: recovery dispatches it. */
  const orphanWithDeliveries = async (contacts) => {
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Eligibility campaign',
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
      contacts.map((c) => ({
        campaignId: campaign._id,
        userId: owner._id,
        contactId: c._id,
        email: c.email,
        name: c.name,
        status: 'pending',
      }))
    );
    return campaign;
  };

  const recoverAndWait = async (campaign) => {
    assert.equal(await recoverCampaign(campaign._id, { emailService, logger: quiet }), 'resumed');
    await waitForCampaignDispatch(campaign._id);
  };

  const outcomeOf = async (campaign, contact) =>
    Delivery.findOne({ campaignId: campaign._id, contactId: contact._id }).lean();

  const sentTo = () => transport.sentEmails.map((m) => m.to);

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init(), Suppression.init()]);
      owner = await User.create({ name: 'Elig Owner', email: `elig-owner-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
      otherTenant = await User.create({ name: 'Elig Other', email: `elig-other-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Contact eligibility tests] MongoDB unavailable: ${err.message}`);
    }
  });

  beforeEach(() => {
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
      await Suppression.deleteMany({});
    }
  });

  after(async () => {
    if (isDbConnected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  it('the new codes are valid delivery error codes', () => {
    assert.ok(DELIVERY_ERROR_CODES.includes('CONTACT_REMOVED'));
    assert.ok(DELIVERY_ERROR_CODES.includes('CONTACT_CHANGED'));
  });

  it('a contact deleted after the lock is skipped as CONTACT_REMOVED; the others are sent', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const [kept, removed, alsoKept] = await makeContacts(['Kept', 'Removed', 'Also Kept']);
    const campaign = await orphanWithDeliveries([kept, removed, alsoKept]);
    await Contact.deleteOne({ _id: removed._id });

    await recoverAndWait(campaign);

    const skipped = await outcomeOf(campaign, removed);
    assert.equal(skipped.status, 'failed');
    assert.equal(skipped.errorCode, 'CONTACT_REMOVED');
    assert.deepEqual(sentTo().sort(), [kept.email, alsoKept.email].sort());
    const done = await Campaign.findById(campaign._id).lean();
    assert.equal(done.status, 'sent');
    assert.deepEqual({ sent: done.stats.sent, failed: done.stats.failed }, { sent: 2, failed: 1 });
  });

  it('a contact whose email changed after the lock is skipped as CONTACT_CHANGED (neither address is emailed)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const [changed, kept] = await makeContacts(['Changed', 'Kept']);
    const campaign = await orphanWithDeliveries([changed, kept]);
    const newAddress = `moved-${new mongoose.Types.ObjectId().toString()}@example.com`;
    await Contact.updateOne({ _id: changed._id }, { $set: { email: newAddress } });

    await recoverAndWait(campaign);

    assert.equal((await outcomeOf(campaign, changed)).errorCode, 'CONTACT_CHANGED');
    assert.deepEqual(sentTo(), [kept.email]);
    assert.ok(!sentTo().includes(newAddress));
    assert.ok(!sentTo().includes(changed.email));
  });

  it('an address that only differs in letter case or surrounding spaces is still the same address', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const [contact] = await makeContacts(['Case Only']);
    const campaign = await orphanWithDeliveries([contact]);
    await Contact.collection.updateOne(
      { _id: contact._id },
      { $set: { email: `  ${contact.email.toUpperCase()} ` } }
    );

    await recoverAndWait(campaign);
    assert.equal((await outcomeOf(campaign, contact)).status, 'sent');
    assert.equal(transport.count, 1);
  });

  it("a contact that now belongs to another tenant is CONTACT_REMOVED, never sent", async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const [moved, kept] = await makeContacts(['Moved Tenant', 'Kept']);
    const campaign = await orphanWithDeliveries([moved, kept]);
    await Contact.collection.updateOne({ _id: moved._id }, { $set: { userId: otherTenant._id } });

    await recoverAndWait(campaign);
    assert.equal((await outcomeOf(campaign, moved)).errorCode, 'CONTACT_REMOVED');
    assert.deepEqual(sentTo(), [kept.email]);
  });

  it('a contact deleted and re-created with the same address is CONTACT_REMOVED (a new contact did not consent to this campaign)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const [original] = await makeContacts(['Original']);
    const campaign = await orphanWithDeliveries([original]);
    await Contact.deleteOne({ _id: original._id });
    await Contact.create({ userId: owner._id, name: 'Re-created', email: original.email });

    await recoverAndWait(campaign);
    assert.equal((await outcomeOf(campaign, original)).errorCode, 'CONTACT_REMOVED');
    assert.equal(transport.count, 0);
  });

  it('suppression and unsubscribe still win, and are still SUPPRESSED', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const [suppressedAndDeleted, unsubscribed, kept] = await makeContacts(['Suppressed', 'Unsubscribed', 'Kept']);
    const campaign = await orphanWithDeliveries([suppressedAndDeleted, unsubscribed, kept]);
    await Suppression.create({ userId: owner._id, email: suppressedAndDeleted.email, reason: 'manual' });
    await Contact.deleteOne({ _id: suppressedAndDeleted._id });
    await Contact.updateOne({ _id: unsubscribed._id }, { $set: { isUnsubscribed: true } });

    await recoverAndWait(campaign);
    assert.equal((await outcomeOf(campaign, suppressedAndDeleted)).errorCode, 'SUPPRESSED');
    assert.equal((await outcomeOf(campaign, unsubscribed)).errorCode, 'SUPPRESSED');
    assert.deepEqual(sentTo(), [kept.email]);
  });

  it('a contact deleted WHILE the campaign is sending is not emailed', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const [first, second] = await makeContacts(['First', 'Second']);
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Deleted mid-dispatch',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'draft',
      recipientIds: [first._id, second._id],
    });
    // Whichever recipient is sent first deletes the other contact before it is reached
    let deleted = null;
    emailService = createEmailService({
      transport: {
        async sendMail(message) {
          if (!deleted) {
            deleted = message.to === first.email ? second : first;
            await Contact.deleteOne({ _id: deleted._id });
          }
          return transport.sendMail(message);
        },
      },
      from: 'MailPulse Test <no-reply@mailpulse.test>',
    });

    assert.ok(
      await startCampaignDispatch({
        campaign,
        userId: owner._id,
        eligibleContacts: [first, second],
        emailService,
        concurrency: 1,
        logger: quiet,
      })
    );
    await waitForCampaignDispatch(campaign._id);

    assert.equal(transport.count, 1);
    assert.ok(!sentTo().includes(deleted.email));
    assert.equal((await outcomeOf(campaign, deleted)).errorCode, 'CONTACT_REMOVED');
    assert.equal((await Campaign.findById(campaign._id).lean()).status, 'sent');
  });
});
