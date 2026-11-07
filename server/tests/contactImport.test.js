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
import { parseCsv } from '../src/utils/csv.js';
import { MAX_IMPORT_ROWS, headerToCustomKey } from '../src/services/contactImport.service.js';

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

  describe('export', () => {
    const get = (qs = '', token = tokenOne) =>
      fetch(`${baseUrl}/api/v1/contacts/export${qs}`, { headers: { ...(token && { Authorization: `Bearer ${token}` }) } });

    it('requires authentication', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      assert.equal((await get('', null)).status, 401);
    });

    it('downloads only the owner contacts as an attachment, optionally filtered by tag', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      await Contact.create({ userId: userOne._id, name: 'Zed, Zed', email: em('a'), tags: ['vip', 'lead'] });
      await Contact.create({ userId: userOne._id, name: 'Plain', email: em('b'), isUnsubscribed: true });
      await Contact.create({ userId: userTwo._id, name: 'Other Tenant', email: em('c') });

      const res = await get();
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/csv/);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="contacts.csv"/);
      const rows = parseCsv(await res.text());
      assert.deepEqual(rows[0], ['name', 'email', 'tags', 'status', 'created']);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows[1].slice(0, 4), ['Zed, Zed', em('a'), 'vip;lead', 'subscribed']);
      assert.equal(rows[2][3], 'unsubscribed');
      assert.ok(!rows.some((r) => r[1] === em('c')));

      const filtered = parseCsv(await (await get('?tag=VIP')).text());
      assert.equal(filtered.length, 2);
      assert.equal((await get('?tag=bad!')).status, 400);
    });

    it('neutralizes formula injection and round-trips through import', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      await Contact.create({ userId: userOne._id, name: '=cmd|calc', email: em('evil'), tags: ['x'] });
      const text = await (await get()).text();
      assert.ok(text.includes("'=cmd|calc"));

      await Contact.deleteMany({ userId: userOne._id });
      await Contact.create({ userId: userOne._id, name: 'Round Trip', email: em('rt'), tags: ['a', 'b'] });
      const csv = await (await get()).text();
      await Contact.deleteMany({ userId: userOne._id });
      const imported = (await (await post(csv)).json()).data;
      assert.equal(imported.created, 1);
      const back = await Contact.findOne({ userId: userOne._id, email: em('rt') }).lean();
      assert.deepEqual(back.tags, ['a', 'b']);
    });
  });

  describe('custom field columns', () => {
    it('maps headers to custom keys', () => {
      assert.equal(headerToCustomKey('Company'), 'company');
      assert.equal(headerToCustomKey('Phone Number'), 'phone_number');
      assert.equal(headerToCustomKey(' Plan-Tier '), 'plan_tier');
      assert.equal(headerToCustomKey('custom:Status'), 'status');
      for (const ignored of ['', 'status', 'created', 'tags', '123', '!!!', 'custom:', 'custom:9x']) {
        assert.equal(headerToCustomKey(ignored), null, ignored);
      }
    });

    it('imports extra columns as custom fields and reports ignored ones', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const csv = `name,email,Company,Phone Number,status,@@@\nAda Lovelace,${em('cf1')},Acme,555-1234,subscribed,x\nNo Fields,${em('cf2')},,,,\n`;
      const res = await post(csv);
      const data = (await res.json()).data;
      assert.equal(data.created, 2);
      assert.deepEqual(data.ignoredColumns, ['@@@']);

      const ada = await Contact.findOne({ userId: userOne._id, email: em('cf1') }).lean();
      assert.deepEqual(ada.customFields, { company: 'Acme', phone_number: '555-1234' });
      const none = await Contact.findOne({ userId: userOne._id, email: em('cf2') }).lean();
      assert.equal(none.customFields, undefined);
    });

    it('rejects rows whose custom values are too long or too numerous', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      const headers = Array.from({ length: 11 }, (_, i) => `f${i}`);
      const tooMany = `email,${headers.join(',')}\n${em('many')},${headers.map(() => 'v').join(',')}\n`;
      const tooLong = `email,note\n${em('long')},${'x'.repeat(201)}\n`;
      const a = (await (await post(tooMany)).json()).data;
      const b = (await (await post(tooLong)).json()).data;
      assert.equal(a.invalid, 1);
      assert.match(a.errors[0].message, /at most 10/);
      assert.equal(b.invalid, 1);
      assert.match(b.errors[0].message, /200 characters/);
      assert.equal(await Contact.countDocuments({ userId: userOne._id }), 0);
    });

    it('exports custom fields and round-trips them, including keys that clash with standard columns', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');
      await Contact.create({ userId: userOne._id, name: 'Round Trip', email: em('rt2'), customFields: { company: 'Acme', status: 'vip' } });
      const res = await fetch(`${baseUrl}/api/v1/contacts/export`, { headers: { Authorization: `Bearer ${tokenOne}` } });
      const csv = await res.text();
      const rows = parseCsv(csv);
      assert.deepEqual(rows[0], ['name', 'email', 'tags', 'status', 'created', 'company', 'custom:status']);
      assert.deepEqual(rows[1].slice(5), ['Acme', 'vip']);

      await Contact.deleteMany({ userId: userOne._id });
      assert.equal((await (await post(csv)).json()).data.created, 1);
      const back = await Contact.findOne({ userId: userOne._id, email: em('rt2') }).lean();
      assert.deepEqual(back.customFields, { company: 'Acme', status: 'vip' });
    });
  });
});
