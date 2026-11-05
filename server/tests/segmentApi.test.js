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

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Segment from '../src/models/Segment.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createSegmentSchema, previewCriteriaSchema } from '../src/validators/segment.validator.js';

describe('Segment validators (no DB)', () => {
  const parse = (criteria, name = 'VIP list') => createSegmentSchema.safeParse({ body: { name, criteria } });

  it('requires at least one rule and rejects unknown keys', () => {
    assert.equal(parse({}).success, false);
    assert.equal(parse({ tagsAny: [] }).success, false);
    assert.equal(parse({ tagsAny: ['vip'], $where: '1' }).success, false);
    assert.equal(parse({ tagsAny: ['VIP', 'vip'] }).data.body.criteria.tagsAny.length, 1);
  });

  it('validates engagement and tag formats', () => {
    assert.equal(parse({ engagement: { type: 'opened', days: 30 } }).success, true);
    assert.equal(parse({ engagement: { type: 'opened', days: 0 } }).success, false);
    assert.equal(parse({ engagement: { type: 'bounced', days: 5 } }).success, false);
    assert.equal(parse({ tagsAll: ['bad!'] }).success, false);
    assert.equal(parse({ createdWithinDays: 366 }).success, false);
    assert.equal(previewCriteriaSchema.safeParse({ body: { criteria: { tagsNone: ['x'] } } }).success, true);
  });
});

describe('Segment API (/api/v1/segments)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `segapi-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userOne;
  let userTwo;
  let tokenOne;
  let tokenTwo;

  const request = (method, urlPath, { token = tokenOne, body } = {}) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const ids = () => [userOne._id, userTwo._id];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Segment.init();
    } catch (err) {
      console.warn(`[Segment API Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      userOne = await User.create({ name: 'Seg One', email: `${prefix}-one@example.com`, passwordHash });
      userTwo = await User.create({ name: 'Seg Two', email: `${prefix}-two@example.com`, passwordHash });
      tokenOne = signAccessToken(userOne);
      tokenTwo = signAccessToken(userTwo);
    }
  });

  beforeEach(async () => {
    if (isDbConnected) {
      await Segment.deleteMany({ userId: { $in: ids() } });
      await Contact.deleteMany({ userId: { $in: ids() } });
    }
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Segment.deleteMany({ userId: { $in: ids() } });
      await Contact.deleteMany({ userId: { $in: ids() } });
      await User.deleteMany({ _id: { $in: ids() } });
      await mongoose.disconnect();
    }
  });

  const createSeg = (body, token) => request('POST', '/api/v1/segments', { token, body });

  it('requires authentication', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await request('GET', '/api/v1/segments', { token: null })).status, 401);
  });

  it('creates, reads, updates (criteria replaced) and deletes a segment', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    let res = await createSeg({
      name: 'Engaged VIPs',
      description: 'VIPs who opened recently',
      criteria: { tagsAny: ['VIP'], engagement: { type: 'opened', days: 30 } },
    });
    assert.equal(res.status, 201);
    const seg = (await res.json()).data.segment;
    assert.deepEqual(seg.criteria.tagsAny, ['vip']);
    assert.deepEqual(seg.criteria.engagement, { type: 'opened', days: 30 });
    assert.equal(seg.userId, undefined);

    res = await request('PATCH', `/api/v1/segments/${seg.id}`, { body: { criteria: { tagsAll: ['lead'] } } });
    assert.equal(res.status, 200);
    const updated = (await res.json()).data.segment;
    assert.deepEqual(updated.criteria.tagsAll, ['lead']);
    assert.equal(updated.criteria.engagement, null);
    assert.deepEqual(updated.criteria.tagsAny, []);

    assert.equal((await request('GET', `/api/v1/segments/${seg.id}`)).status, 200);
    const list = (await (await request('GET', '/api/v1/segments?search=engaged')).json()).data;
    assert.equal(list.count, 1);

    assert.equal((await request('DELETE', `/api/v1/segments/${seg.id}`)).status, 200);
    assert.equal((await request('GET', `/api/v1/segments/${seg.id}`)).status, 404);
  });

  it('rejects empty criteria, bad ids and duplicate names', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await createSeg({ name: 'Empty', criteria: {} })).status, 400);
    assert.equal((await request('GET', '/api/v1/segments/not-an-id')).status, 400);
    const body = { name: 'Dup', criteria: { tagsAny: ['a'] } };
    assert.equal((await createSeg(body)).status, 201);
    assert.equal((await createSeg(body)).status, 409);
    assert.equal((await createSeg(body, tokenTwo)).status, 201);
  });

  it('isolates tenants', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const id = (await (await createSeg({ name: 'Private', criteria: { tagsAny: ['a'] } })).json()).data.segment.id;
    assert.equal((await request('GET', `/api/v1/segments/${id}`, { token: tokenTwo })).status, 404);
    assert.equal((await request('GET', `/api/v1/segments/${id}/preview`, { token: tokenTwo })).status, 404);
    assert.equal(
      (await request('PATCH', `/api/v1/segments/${id}`, { token: tokenTwo, body: { name: 'Stolen' } })).status,
      404
    );
    assert.equal((await request('DELETE', `/api/v1/segments/${id}`, { token: tokenTwo })).status, 404);
    assert.ok(await Segment.exists({ _id: id }));
  });

  it('previews saved and unsaved criteria with exact counts and a sample', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const mk = (n, tags, userId = userOne._id) =>
      Contact.create({ userId, name: n, email: `${prefix}-${n.toLowerCase()}@example.com`, tags });
    await mk('Alice', ['vip']);
    await mk('Bobby', ['vip']);
    await mk('Carol', ['lead']);
    await mk('Zed', ['vip'], userTwo._id);

    const id = (await (await createSeg({ name: 'VIPs', criteria: { tagsAny: ['vip'] } })).json()).data.segment.id;
    let preview = (await (await request('GET', `/api/v1/segments/${id}/preview`)).json()).data.preview;
    assert.equal(preview.total, 2);
    assert.equal(preview.sample.length, 2);
    assert.ok(preview.sample.every((c) => c.email && c.name && c.id));

    preview = (
      await (await request('POST', '/api/v1/segments/preview', { body: { criteria: { tagsNone: ['vip'] } } })).json()
    ).data.preview;
    assert.equal(preview.total, 1);
    assert.equal(preview.sample[0].name, 'Carol');

    assert.equal((await request('POST', '/api/v1/segments/preview', { body: { criteria: {} } })).status, 400);
  });
});
