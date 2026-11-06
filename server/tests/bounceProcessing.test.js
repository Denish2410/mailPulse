import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();
process.env.NODE_ENV = 'test';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import Suppression from '../src/models/Suppression.js';
import BounceEvent from '../src/models/BounceEvent.js';
import { connectDB } from '../src/config/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { processBounceEvents, SOFT_BOUNCE_THRESHOLD } from '../src/services/bounceProcessing.service.js';

describe('Bounce event processing', () => {
  let isDbConnected = false;
  const prefix = `bnc-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let owner;
  let other;
  let campaign;
  let alice;
  let delivery;
  let foreignDelivery;
  let seq = 0;

  const ev = (overrides = {}) => ({
    providerEventId: `evt-${prefix}-${++seq}`,
    deliveryId: String(delivery._id),
    messageId: null,
    email: alice.email,
    eventType: 'hard_bounce',
    reason: '550 user unknown',
    occurredAt: new Date(),
    ...overrides,
  });

  const ids = () => [owner._id, other._id];
  const wipe = async () => {
    await BounceEvent.deleteMany({ userId: { $in: ids() } });
    await Suppression.deleteMany({ userId: { $in: ids() } });
    await Contact.updateMany({ userId: { $in: ids() } }, { $set: { isUnsubscribed: false, unsubscribedAt: null } });
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Bounce Processing Tests] MongoDB unavailable: ${err.message}`);
      return;
    }
    await BounceEvent.init();
    const passwordHash = await hashPassword('StrongPassword123!');
    owner = await User.create({ name: 'Bounce Owner', email: `${prefix}-o@example.com`, passwordHash });
    other = await User.create({ name: 'Bounce Other', email: `${prefix}-x@example.com`, passwordHash });
    campaign = await Campaign.create({ userId: owner._id, name: 'Bounce Campaign', subject: 'S', status: 'sent' });
    const otherCampaign = await Campaign.create({ userId: other._id, name: 'Other Campaign', subject: 'S', status: 'sent' });
    alice = await Contact.create({ userId: owner._id, name: 'Alice', email: `${prefix}-alice@example.com` });
    const sameAddressOther = await Contact.create({ userId: other._id, name: 'Alice', email: alice.email });
    delivery = await Delivery.create({
      campaignId: campaign._id,
      userId: owner._id,
      contactId: alice._id,
      email: alice.email,
      status: 'sent',
      messageId: `<${prefix}-msg@mailpulse.test>`,
    });
    foreignDelivery = await Delivery.create({
      campaignId: otherCampaign._id,
      userId: other._id,
      contactId: sameAddressOther._id,
      email: alice.email,
      status: 'sent',
    });
  });

  beforeEach(async () => {
    if (isDbConnected) await wipe();
  });

  after(async () => {
    if (!isDbConnected) return;
    await wipe();
    await Delivery.deleteMany({ userId: { $in: ids() } });
    await Campaign.deleteMany({ userId: { $in: ids() } });
    await Contact.deleteMany({ userId: { $in: ids() } });
    await User.deleteMany({ _id: { $in: ids() } });
    await mongoose.disconnect();
  });

  it('suppresses a hard bounce for the delivery owner only', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const summary = await processBounceEvents('sendgrid', [ev()]);
    assert.deepEqual(summary, { received: 1, processed: 1, duplicates: 0, unmatched: 0, suppressed: 1 });

    const sup = await Suppression.findOne({ userId: owner._id, email: alice.email }).lean();
    assert.equal(sup.source, 'bounce');
    assert.equal(sup.reason, '550 user unknown');
    assert.equal(String(sup.campaignId), String(campaign._id));
    assert.equal(await Suppression.countDocuments({ userId: other._id }), 0);

    const stored = await BounceEvent.findOne({ userId: owner._id }).lean();
    assert.equal(stored.eventType, 'hard_bounce');
    assert.equal(String(stored.deliveryId), String(delivery._id));
  });

  it('is idempotent for retried events', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const event = ev();
    await processBounceEvents('mailgun', [event]);
    const retry = await processBounceEvents('mailgun', [event]);
    assert.deepEqual(retry, { received: 1, processed: 0, duplicates: 1, unmatched: 0, suppressed: 0 });
    assert.equal(await BounceEvent.countDocuments({ userId: owner._id }), 1);
    // Same ID from a different provider is a different event
    const other = await processBounceEvents('ses', [event]);
    assert.equal(other.processed, 1);
  });

  it('marks the contact unsubscribed and suppresses on complaints', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await processBounceEvents('ses', [ev({ eventType: 'complaint', reason: 'abuse' })]);
    const sup = await Suppression.findOne({ userId: owner._id, email: alice.email }).lean();
    assert.equal(sup.source, 'complaint');
    const contact = await Contact.findById(alice._id).lean();
    assert.equal(contact.isUnsubscribed, true);
    assert.equal(contact.unsubscribeReason, 'Spam complaint');
    const foreignContact = await Contact.findOne({ userId: other._id, email: alice.email }).lean();
    assert.equal(foreignContact.isUnsubscribed, false);
  });

  it('suppresses only after repeated soft bounces within the window', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 1; i < SOFT_BOUNCE_THRESHOLD; i += 1) {
      const s = await processBounceEvents('sendgrid', [ev({ eventType: 'soft_bounce', reason: 'mailbox full' })]);
      assert.equal(s.suppressed, 0);
    }
    assert.equal(await Suppression.countDocuments({ userId: owner._id }), 0);
    const last = await processBounceEvents('sendgrid', [ev({ eventType: 'soft_bounce' })]);
    assert.equal(last.suppressed, 1);
    assert.equal((await Suppression.findOne({ userId: owner._id }).lean()).reason, 'Repeated soft bounces');
  });

  it('ignores soft bounces outside the window', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const old = new Date(Date.now() - 60 * 86400000);
    for (let i = 0; i < SOFT_BOUNCE_THRESHOLD; i += 1) {
      await processBounceEvents('sendgrid', [ev({ eventType: 'soft_bounce', occurredAt: old })]);
    }
    assert.equal(await Suppression.countDocuments({ userId: owner._id }), 0);
  });

  it('matches by message id and drops unmatched, spoofed-address and malformed events', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const viaMessageId = await processBounceEvents('mailgun', [
      ev({ deliveryId: null, messageId: `${prefix}-msg@mailpulse.test` }),
    ]);
    assert.equal(viaMessageId.processed, 1);
    await wipe();

    const summary = await processBounceEvents('sendgrid', [
      ev({ deliveryId: String(new mongoose.Types.ObjectId()) }),
      ev({ deliveryId: 'not-an-id', messageId: null }),
      ev({ email: 'someone-else@example.com' }), // tag points at a delivery for another address
      ev({ deliveryId: null, messageId: 'unknown-id' }),
    ]);
    assert.deepEqual(summary, { received: 4, processed: 0, duplicates: 0, unmatched: 4, suppressed: 0 });
    assert.equal(await Suppression.countDocuments({ userId: { $in: ids() } }), 0);
  });

  it('keeps an existing suppression untouched', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Suppression.create({ userId: owner._id, email: alice.email, source: 'link', reason: 'user asked' });
    const summary = await processBounceEvents('sendgrid', [ev()]);
    assert.equal(summary.suppressed, 0);
    const sup = await Suppression.findOne({ userId: owner._id }).lean();
    assert.equal(sup.source, 'link');
    assert.equal(sup.reason, 'user asked');
    assert.ok(foreignDelivery);
  });
});
