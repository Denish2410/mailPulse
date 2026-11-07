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
import {
  normalizeCustomKey,
  normalizeCustomFields,
  toPlainCustomFields,
  MAX_CUSTOM_FIELDS,
} from '../src/utils/customFields.js';

describe('Custom field helpers (no DB)', () => {
  it('normalizes keys', () => {
    assert.equal(normalizeCustomKey(' Company '), 'company');
    assert.equal(normalizeCustomKey('plan_tier2'), 'plan_tier2');
    for (const bad of ['', '2x', 'a-b', 'a b', 'a.b', 'x'.repeat(31), null, 5]) {
      assert.equal(normalizeCustomKey(bad), null, String(bad));
    }
  });

  it('normalizes field maps and reports the first problem', () => {
    assert.deepEqual(normalizeCustomFields({ A: ' 1 ', b: '' }), { fields: { a: '1' }, error: null });
    assert.deepEqual(normalizeCustomFields(new Map([['k', 'v']])), { fields: { k: 'v' }, error: null });
    assert.match(normalizeCustomFields({ '9': 'x' }).error, /Invalid custom field name/);
    assert.match(normalizeCustomFields({ a: 1 }).error, /must be text/);
    assert.match(normalizeCustomFields([]).error, /must be an object/);
    const many = Object.fromEntries(Array.from({ length: MAX_CUSTOM_FIELDS + 1 }, (_, i) => [`f${i}`, 'v']));
    assert.match(normalizeCustomFields(many).error, /at most/);
  });

  it('reads maps, plain objects and missing values', () => {
    assert.deepEqual(toPlainCustomFields(new Map([['a', 'b']])), { a: 'b' });
    assert.deepEqual(toPlainCustomFields({ a: 'b' }), { a: 'b' });
    assert.deepEqual(toPlainCustomFields(undefined), {});
  });
});

describe('Contact custom fields API', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `cf-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let user;
  let token;

  const request = (method, urlPath, body) =>
    fetch(`${baseUrl}/api/v1/contacts${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Custom Fields Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      user = await User.create({ name: 'CF User', email: `${prefix}@example.com`, passwordHash: await hashPassword('StrongPassword123!') });
      token = signAccessToken(user);
    }
  });

  beforeEach(async () => {
    if (isDbConnected) await Contact.deleteMany({ userId: user._id });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Contact.deleteMany({ userId: user._id });
      await User.deleteMany({ _id: user._id });
      await mongoose.disconnect();
    }
  });

  it('creates a contact with normalized custom fields and returns them as a plain object', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await request('POST', '', {
      name: 'Ada',
      email: `${prefix}-a@example.com`,
      customFields: { Company: ' Acme ', plan: 'pro' },
    });
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).data.contact.customFields, { company: 'Acme', plan: 'pro' });

    const plain = await request('POST', '', { name: 'Plain', email: `${prefix}-p@example.com` });
    assert.deepEqual((await plain.json()).data.contact.customFields, {});
  });

  it('replaces and clears custom fields through PATCH', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const created = (await (await request('POST', '', { name: 'Bob', email: `${prefix}-b@example.com`, customFields: { a: '1', b: '2' } })).json()).data.contact;

    let res = await request('PATCH', `/${created.id}`, { customFields: { c: '3' } });
    assert.deepEqual((await res.json()).data.contact.customFields, { c: '3' });

    res = await request('PATCH', `/${created.id}`, { name: 'Bob Two' });
    assert.deepEqual((await res.json()).data.contact.customFields, { c: '3' });

    res = await request('PATCH', `/${created.id}`, { customFields: {} });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.contact.customFields, {});
    assert.equal(await Contact.countDocuments({ userId: user._id, customFields: { $exists: true } }), 0);

    assert.equal((await request('PATCH', `/${created.id}`, { customFields: { 'bad key': 'x' } })).status, 400);
  });

  it('lists contacts with their custom fields', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await request('POST', '', { name: 'Cara', email: `${prefix}-c@example.com`, customFields: { team: 'blue' } });
    const list = (await (await request('GET', '')).json()).data.contacts;
    assert.deepEqual(list[0].customFields, { team: 'blue' });
  });
});
