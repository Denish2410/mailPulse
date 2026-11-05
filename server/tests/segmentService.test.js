import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();
process.env.NODE_ENV = 'test';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import TrackingEvent from '../src/models/TrackingEvent.js';
import { connectDB } from '../src/config/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { normalizeCriteria, hasCriteria, resolveSegment } from '../src/services/segment.service.js';

describe('Segment criteria normalization (no DB)', () => {
  it('normalizes tags, drops junk and bounds days', () => {
    const c = normalizeCriteria({
      tagsAny: ['VIP', 'vip', 'bad!'],
      tagsAll: 'nope',
      engagement: { type: 'opened', days: 30 },
      createdWithinDays: 0,
      hacker: { $where: '1' },
    });
    assert.deepEqual(c, {
      tagsAny: ['vip'],
      tagsAll: [],
      tagsNone: [],
      engagement: { type: 'opened', days: 30 },
      createdWithinDays: null,
    });
    assert.equal(normalizeCriteria({ engagement: { type: 'weird', days: 5 } }).engagement, null);
    assert.equal(normalizeCriteria({ engagement: { type: 'opened', days: 400 } }).engagement, null);
    assert.equal(normalizeCriteria({ engagement: { type: 'opened', days: '7' } }).engagement, null);
  });

  it('detects empty criteria', () => {
    assert.equal(hasCriteria(normalizeCriteria({})), false);
    assert.equal(hasCriteria(normalizeCriteria(undefined)), false);
    assert.equal(hasCriteria(normalizeCriteria({ tagsNone: ['x'] })), true);
  });
});

describe('Segment resolution', () => {
  let isDbConnected = false;
  const prefix = `seg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let owner;
  let other;
  const byName = {};

  const emailsOf = (result) => result.contacts.map((c) => c.name).sort();

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Segment Tests] MongoDB unavailable: ${err.message}`);
      return;
    }
    const passwordHash = await hashPassword('StrongPassword123!');
    owner = await User.create({ name: 'Seg Owner', email: `${prefix}-o@example.com`, passwordHash });
    other = await User.create({ name: 'Seg Other', email: `${prefix}-x@example.com`, passwordHash });

    const make = async (name, tags, extra = {}, userId = owner._id) => {
      byName[name] = await Contact.create({
        userId,
        name,
        email: `${prefix}-${name.toLowerCase()}@example.com`,
        tags,
        ...extra,
      });
    };
    await make('Alice', ['vip', 'lead']);
    await make('Bobby', ['vip']);
    await make('Carol', ['lead', 'newsletter']);
    await make('Dave', []);
    await make('Erin', ['vip'], { isUnsubscribed: true });
    await make('Frank', ['vip'], {}, other._id);

    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Seg Campaign',
      subject: 'S',
      status: 'sent',
    });
    const otherCampaign = await Campaign.create({
      userId: other._id,
      name: 'Other Campaign',
      subject: 'S',
      status: 'sent',
    });
    const ev = (c, name, eventType, daysAgo) =>
      TrackingEvent.create({
        campaignId: c._id,
        recipientId: byName[name]._id,
        recipientEmail: byName[name].email,
        eventType,
        timestamp: new Date(Date.now() - daysAgo * 86400000),
      });
    await ev(campaign, 'Alice', 'open', 2);
    await ev(campaign, 'Alice', 'click', 2);
    await ev(campaign, 'Bobby', 'open', 40);
    // An open on a foreign campaign must not count for the owner's segment
    await ev(otherCampaign, 'Dave', 'open', 1);
    byName._campaigns = [campaign._id, otherCampaign._id];
    await Contact.collection.updateOne({ _id: byName.Dave._id }, { $set: { createdAt: new Date(Date.now() - 100 * 86400000) } });
  });

  after(async () => {
    if (!isDbConnected) return;
    await TrackingEvent.deleteMany({ campaignId: { $in: byName._campaigns } });
    await Campaign.deleteMany({ userId: { $in: [owner._id, other._id] } });
    await Contact.deleteMany({ userId: { $in: [owner._id, other._id] } });
    await User.deleteMany({ _id: { $in: [owner._id, other._id] } });
    await mongoose.disconnect();
  });

  it('returns nothing for empty criteria', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.deepEqual(await resolveSegment(owner._id, {}), { total: 0, contacts: [] });
  });

  it('matches tagsAny / tagsAll / tagsNone, excluding unsubscribed and foreign contacts', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.deepEqual(emailsOf(await resolveSegment(owner._id, { tagsAny: ['vip'] })), ['Alice', 'Bobby']);
    assert.deepEqual(emailsOf(await resolveSegment(owner._id, { tagsAll: ['vip', 'lead'] })), ['Alice']);
    assert.deepEqual(
      emailsOf(await resolveSegment(owner._id, { tagsAny: ['vip', 'lead'], tagsNone: ['newsletter'] })),
      ['Alice', 'Bobby']
    );
    assert.deepEqual(emailsOf(await resolveSegment(owner._id, { tagsNone: ['vip'] })), ['Carol', 'Dave']);
  });

  it('matches engagement windows using only the owner campaigns', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const opened30 = await resolveSegment(owner._id, { engagement: { type: 'opened', days: 30 } });
    assert.deepEqual(emailsOf(opened30), ['Alice']);
    assert.deepEqual(
      emailsOf(await resolveSegment(owner._id, { engagement: { type: 'opened', days: 90 } })),
      ['Alice', 'Bobby']
    );
    assert.deepEqual(emailsOf(await resolveSegment(owner._id, { engagement: { type: 'clicked', days: 30 } })), ['Alice']);
    // Dave's open belongs to a foreign campaign, so he has not "opened" for this owner
    assert.deepEqual(
      emailsOf(await resolveSegment(owner._id, { engagement: { type: 'not_opened', days: 30 } })),
      ['Bobby', 'Carol', 'Dave']
    );
  });

  it('combines criteria with AND and supports createdWithinDays and limit', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.deepEqual(
      emailsOf(await resolveSegment(owner._id, { tagsAny: ['vip'], engagement: { type: 'opened', days: 30 } })),
      ['Alice']
    );
    assert.deepEqual(
      emailsOf(await resolveSegment(owner._id, { createdWithinDays: 30 })),
      ['Alice', 'Bobby', 'Carol']
    );
    const limited = await resolveSegment(owner._id, { tagsAny: ['vip'] }, { limit: 1 });
    assert.equal(limited.total, 2);
    assert.equal(limited.contacts.length, 1);
  });
});
