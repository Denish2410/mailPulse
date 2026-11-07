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
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { normalizeTag, normalizeTags } from '../src/utils/tags.js';
import { createContactSchema, updateContactSchema } from '../src/validators/contact.validator.js';

describe('Tag normalization (no DB)', () => {
  it('normalizes and rejects tags', () => {
    assert.equal(normalizeTag('  VIP '), 'vip');
    assert.equal(normalizeTag('Hot   Lead'), 'hot lead');
    assert.equal(normalizeTag('a_b-c'), 'a_b-c');
    for (const bad of ['', '   ', '-start', 'x'.repeat(31), 'a<b>', 'a,b', 42, null]) {
      assert.equal(normalizeTag(bad), null, String(bad));
    }
    assert.deepEqual(normalizeTags(['VIP', 'vip', ' Lead ', '!!', 'lead']), ['vip', 'lead']);
    assert.deepEqual(normalizeTags('nope'), []);
  });

  it('validators normalize, de-duplicate and reject invalid tags', () => {
    const ok = createContactSchema.safeParse({ body: { name: 'Ada', email: 'a@b.co', tags: ['VIP', 'vip', 'Lead'] } });
    assert.equal(ok.success, true);
    assert.deepEqual(ok.data.body.tags, ['vip', 'lead']);
    assert.equal(createContactSchema.safeParse({ body: { name: 'Ada', email: 'a@b.co', tags: ['bad!'] } }).success, false);
    assert.equal(
      createContactSchema.safeParse({
        body: { name: 'Ada', email: 'a@b.co', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      }).success,
      false
    );
    const id = new mongoose.Types.ObjectId().toString();
    assert.equal(updateContactSchema.safeParse({ params: { id }, body: { tags: [] } }).success, true);
    assert.equal(updateContactSchema.safeParse({ params: { id }, body: {} }).success, false);
  });
});

describe('Contact tags API', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `tags-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userOne;
  let userTwo;
  let tokenOne;
  let tokenTwo;

  const request = (method, urlPath, { token = tokenOne, body } = {}) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Contact Tags Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      userOne = await User.create({ name: 'Tag One', email: `${prefix}-one@example.com`, passwordHash });
      userTwo = await User.create({ name: 'Tag Two', email: `${prefix}-two@example.com`, passwordHash });
      tokenOne = signAccessToken(userOne);
      tokenTwo = signAccessToken(userTwo);
    }
  });

  beforeEach(async () => {
    if (isDbConnected) await Contact.deleteMany({ userId: { $in: [userOne._id, userTwo._id] } });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Contact.deleteMany({ userId: { $in: [userOne._id, userTwo._id] } });
      await User.deleteMany({ _id: { $in: [userOne._id, userTwo._id] } });
      await mongoose.disconnect();
    }
  });

  const create = async (name, tags, token) => {
    const res = await request('POST', '/api/v1/contacts', {
      token,
      body: { name, email: `${prefix}-${name.toLowerCase()}@example.com`, ...(tags && { tags }) },
    });
    return (await res.json()).data?.contact;
  };

  it('creates contacts with normalized tags and defaults to none', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const tagged = await create('Alice', ['VIP', ' Lead ', 'vip']);
    assert.deepEqual(tagged.tags, ['vip', 'lead']);
    const plain = await create('Bobby');
    assert.deepEqual(plain.tags, []);
  });

  it('replaces tags via PATCH, including clearing them', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const c = await create('Carol', ['vip']);
    let res = await request('PATCH', `/api/v1/contacts/${c.id}`, { body: { tags: ['lead', 'newsletter'] } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.contact.tags, ['lead', 'newsletter']);
    res = await request('PATCH', `/api/v1/contacts/${c.id}`, { body: { tags: [] } });
    assert.deepEqual((await res.json()).data.contact.tags, []);
    res = await request('PATCH', `/api/v1/contacts/${c.id}`, { body: { tags: ['bad!'] } });
    assert.equal(res.status, 400);
  });

  it('filters the contact list by tag and lists tag counts per tenant', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await create('Dave', ['vip', 'lead']);
    await create('Erin', ['vip']);
    await create('Frank', ['lead']);
    await create('Gina', ['vip'], tokenTwo);

    let res = await request('GET', '/api/v1/contacts?tag=VIP');
    let data = (await res.json()).data;
    assert.equal(data.total, 2);
    assert.ok(data.contacts.every((c) => c.tags.includes('vip')));

    res = await request('GET', '/api/v1/contacts?tag=nobody');
    assert.equal((await res.json()).data.total, 0);

    res = await request('GET', '/api/v1/contacts?tag=bad!');
    assert.equal(res.status, 400);

    res = await request('GET', '/api/v1/contacts/tags');
    data = (await res.json()).data;
    assert.deepEqual(data.tags, [
      { tag: 'vip', count: 2 },
      { tag: 'lead', count: 2 },
    ].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)));
  });
});

describe('Contact custom fields', () => {
  const id = new mongoose.Types.ObjectId().toString();

  it('normalizes keys and values in the validators', () => {
    const ok = createContactSchema.safeParse({
      body: { name: 'Ada', email: 'a@b.co', customFields: { Company: '  Acme  ', plan_tier: 'pro', empty: '   ' } },
    });
    assert.equal(ok.success, true);
    assert.deepEqual(ok.data.body.customFields, { company: 'Acme', plan_tier: 'pro' });
  });

  it('rejects invalid names, values, duplicates and too many fields', () => {
    const parse = (customFields) => createContactSchema.safeParse({ body: { name: 'Ada', email: 'a@b.co', customFields } });
    assert.equal(parse({ '1bad': 'x' }).success, false);
    assert.equal(parse({ 'has space': 'x' }).success, false);
    assert.equal(parse({ 'dotted.key': 'x' }).success, false);
    assert.equal(parse({ $where: 'x' }).success, false);
    assert.equal(parse({ company: 5 }).success, false);
    assert.equal(parse({ company: 'x'.repeat(201) }).success, false);
    assert.equal(parse({ Company: 'a', company: 'b' }).success, false);
    assert.equal(parse(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, 'v']))).success, false);
    assert.equal(parse('nope').success, false);
    assert.equal(updateContactSchema.safeParse({ params: { id }, body: { customFields: {} } }).success, true);
  });
});
