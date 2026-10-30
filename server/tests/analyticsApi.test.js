import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import {
  buildDailySeries,
  computeRate,
  startOfUtcDay,
  getAnalyticsOverview,
} from '../src/services/analytics.service.js';
import { getAnalyticsOverviewSchema } from '../src/validators/analytics.validator.js';

describe('Analytics helpers', () => {
  it('computeRate returns one-decimal percentages and null for an empty base', () => {
    assert.equal(computeRate(0, 0), null);
    assert.equal(computeRate(1, 3), 33.3);
    assert.equal(computeRate(5, 5), 100);
  });

  it('startOfUtcDay truncates to midnight UTC', () => {
    assert.equal(
      startOfUtcDay(new Date('2026-10-30T23:59:59.999Z')).toISOString(),
      '2026-10-30T00:00:00.000Z'
    );
  });

  it('buildDailySeries fills gaps with zeros, oldest first, ending today', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    const series = buildDailySeries([{ _id: '2026-10-29', sent: 4, failed: 1 }], 3, now);
    assert.deepEqual(series, [
      { date: '2026-10-28', sent: 0, failed: 0 },
      { date: '2026-10-29', sent: 4, failed: 1 },
      { date: '2026-10-30', sent: 0, failed: 0 },
    ]);
  });

  it('days query accepts 7/30/90, defaults to 30 and rejects anything else', async () => {
    const parse = (query) => getAnalyticsOverviewSchema.safeParseAsync({ query });
    assert.equal((await parse({})).data.query.days, 30);
    assert.equal((await parse({ days: '7' })).data.query.days, 7);
    assert.equal((await parse({ days: '90' })).data.query.days, 90);
    assert.equal((await parse({ days: '45' })).success, false);
    assert.equal((await parse({ days: 'abc' })).success, false);
    assert.equal((await parse({ days: '30', extra: '1' })).success, false);
  });
});

describe('Analytics API (GET /api/v1/analytics/overview)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `analytics-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let owner;
  let other;
  let ownerToken;
  let otherToken;

  const get = (urlPath, token) =>
    fetch(`${baseUrl}${urlPath}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
    } catch (err) {
      console.warn(`[Analytics API Tests] MongoDB unavailable: ${err.message}`);
    }

    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    if (!isDbConnected) return;

    const passwordHash = await hashPassword('StrongPassword123!');
    owner = await User.create({ name: 'Owner', email: `${prefix}-owner@example.com`, passwordHash });
    other = await User.create({ name: 'Other', email: `${prefix}-other@example.com`, passwordHash });
    ownerToken = signAccessToken(owner);
    otherToken = signAccessToken(other);

    const [alice, bob, carol] = await Contact.create([
      { userId: owner._id, name: 'Alice', email: `${prefix}-a@example.com` },
      { userId: owner._id, name: 'Bob', email: `${prefix}-b@example.com` },
      { userId: owner._id, name: 'Carol', email: `${prefix}-c@example.com` },
    ]);
    const foreign = await Contact.create({
      userId: other._id,
      name: 'Foreign',
      email: `${prefix}-f@example.com`,
    });

    const base = { subject: 'Hello', textContent: 'Hi' };
    await Campaign.create({ ...base, userId: owner._id, name: 'Draft One', status: 'draft' });
    const sentCampaign = await Campaign.create({
      ...base,
      userId: owner._id,
      name: 'Launch',
      status: 'sent',
      sendStartedAt: new Date(),
      sendCompletedAt: new Date(),
      stats: { total: 3, sent: 2, failed: 1 },
    });
    const foreignCampaign = await Campaign.create({
      ...base,
      userId: other._id,
      name: 'Foreign Launch',
      status: 'sent',
      stats: { total: 1, sent: 1, failed: 0 },
    });

    const now = new Date();
    const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    await Delivery.create([
      { campaignId: sentCampaign._id, userId: owner._id, contactId: alice._id, email: alice.email, status: 'sent', sentAt: now },
      { campaignId: sentCampaign._id, userId: owner._id, contactId: bob._id, email: bob.email, status: 'sent', sentAt: old },
      { campaignId: sentCampaign._id, userId: owner._id, contactId: carol._id, email: carol.email, status: 'failed', errorCode: 'TRANSPORT_ERROR', failedAt: now },
      { campaignId: foreignCampaign._id, userId: other._id, contactId: foreign._id, email: foreign.email, status: 'sent', sentAt: now },
    ]);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      const ids = [owner._id, other._id];
      await Delivery.deleteMany({ userId: { $in: ids } });
      await Campaign.deleteMany({ userId: { $in: ids } });
      await Contact.deleteMany({ userId: { $in: ids } });
      await User.deleteMany({ _id: { $in: ids } });
      await mongoose.disconnect();
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await get('/api/v1/analytics/overview');
    assert.equal(res.status, 401);
  });

  it('rejects an unsupported range with 400', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await get('/api/v1/analytics/overview?days=45', ownerToken);
    assert.equal(res.status, 400);
  });

  it('returns owner-scoped totals, daily series and failure reasons', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await get('/api/v1/analytics/overview?days=7', ownerToken);
    assert.equal(res.status, 200);
    const { data } = await res.json();

    assert.equal(data.range.days, 7);
    assert.equal(data.contacts.total, 3);
    assert.deepEqual(data.campaigns.byStatus, { draft: 1, sending: 0, sent: 1, failed: 0 });
    assert.equal(data.campaigns.total, 2);
    assert.deepEqual(
      { ...data.deliveries },
      { total: 3, sent: 2, failed: 1, inProgress: 0, acceptanceRate: 66.7 }
    );
    // The 60-day-old send is outside the 7-day window
    assert.deepEqual(data.period, { sent: 1, failed: 1, acceptanceRate: 50 });
    assert.equal(data.daily.length, 7);
    assert.equal(data.daily.at(-1).sent + data.daily.at(-1).failed, 2);
    assert.deepEqual(data.failureReasons, [{ code: 'TRANSPORT_ERROR', count: 1 }]);
    assert.equal(data.recentCampaigns.length, 1);
    assert.equal(data.recentCampaigns[0].name, 'Launch');
    assert.equal(data.recentCampaigns[0].acceptanceRate, 66.7);
  });

  it('includes older sends in a wider window', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const data = await getAnalyticsOverview(owner._id.toString(), { days: 90 });
    assert.equal(data.daily.length, 90);
    assert.equal(data.period.sent, 2);
  });

  it('never leaks another tenant’s data', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await get('/api/v1/analytics/overview', otherToken);
    const { data } = await res.json();
    assert.equal(data.contacts.total, 1);
    assert.equal(data.deliveries.total, 1);
    assert.equal(data.deliveries.failed, 0);
    assert.deepEqual(data.recentCampaigns.map((c) => c.name), ['Foreign Launch']);
  });
});
