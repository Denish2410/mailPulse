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
import { MAX_IMPORT_ROWS } from '../src/services/contactImport.service.js';

describe('Contact CSV import API', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `imp-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userOne;
  let userTwo;
  let tokenOne;
  let tokenTwo;

  const em = (n) => `${prefix}-${n}@example.com`;
  const post = (csv, token = tokenOne, body) =>
    fetch(`${baseUrl}/api/v1/contacts/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body ?? { csv }),
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Contact Import Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      userOne = await User.create({ name: 'Imp One', email: em('u1'), passwordHash });
      userTwo = await User.create({ name: 'Imp Two', email: em('u2'), passwordHash });
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

  it('requires authentication and a csv string', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await post('email\na@b.co', null)).status, 401);
    assert.equal((await post(null, tokenOne, {})).status, 400);
    assert.equal((await post(null, tokenOne, { csv: 'x', extra: 1 })).status, 400);
  });

  it('imports valid rows with names, tags and quoted fields', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const csv = `Name,EMAIL,Tags\r\n"Doe, Jane",${em('jane').toUpperCase()},VIP;Lead\r\nBob Builder,${em('bob')},\r\n`;
    const res = await post(csv);
    assert.equal(res.status, 200);
    const data = (await res.json()).data;
    assert.deepEqual({ total: data.total, created: data.created, skipped: data.skipped, invalid: data.invalid }, { total: 2, created: 2, skipped: 0, invalid: 0 });

    const jane = await Contact.findOne({ userId: userOne._id, email: em('jane') }).lean();
    assert.equal(jane.name, 'Doe, Jane');
    assert.deepEqual(jane.tags, ['vip', 'lead']);
  });

  it('derives a name from the email and works without name/tags columns', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await post(`email\n${em('only')}\n`);
    assert.equal((await res.json()).data.created, 1);
    const c = await Contact.findOne({ userId: userOne._id, email: em('only') }).lean();
    assert.equal(c.name, `${prefix}-only`);
  });

  it('reports invalid rows and skips duplicates (in file and in database)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Contact.create({ userId: userOne._id, name: 'Existing', email: em('exists'), tags: ['keep'] });
    const csv = [
      'name,email,tags',
      `Ok One,${em('ok')},`,
      `Dup,${em('ok')},`,
      `Existing Again,${em('exists')},new`,
      'No Email,not-an-email,',
      `A,${em('shortname')},`,
      `Bad Tag,${em('badtag')},ok;bad!`,
    ].join('\n');
    const data = (await (await post(csv)).json()).data;
    assert.equal(data.created, 1);
    assert.equal(data.skipped, 2);
    assert.equal(data.invalid, 3);
    assert.deepEqual(data.errors.map((e) => e.row), [5, 6, 7]);

    // Existing contact is not overwritten
    const existing = await Contact.findOne({ userId: userOne._id, email: em('exists') }).lean();
    assert.deepEqual(existing.tags, ['keep']);
    assert.equal(existing.name, 'Existing');
  });

  it('is tenant-scoped: the same address can be imported by another user', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const csv = `name,email\nShared Person,${em('shared')}\n`;
    assert.equal((await (await post(csv)).json()).data.created, 1);
    assert.equal((await (await post(csv, tokenTwo)).json()).data.created, 1);
    assert.equal((await (await post(csv)).json()).data.skipped, 1);
    assert.equal(await Contact.countDocuments({ email: em('shared') }), 2);
  });

  it('rejects empty files, missing email header, malformed CSV and oversized files', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await post('\n\n')).status, 400);
    const noEmail = await post('name,phone\nA Person,123\n');
    assert.equal(noEmail.status, 400);
    assert.match((await noEmail.json()).message, /email/);
    assert.equal((await post('email\n"unterminated')).status, 400);
    const big = ['email', ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `u${i}@x.co`)].join('\n');
    assert.equal((await post(big)).status, 400);
    assert.equal(await Contact.countDocuments({ userId: userOne._id }), 0);
  });
});
