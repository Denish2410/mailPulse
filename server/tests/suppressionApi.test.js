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
import Suppression from '../src/models/Suppression.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { REMOVABLE_SOURCES } from '../src/controllers/suppression.controller.js';

describe('Suppression list API', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `sup-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userOne;
  let userTwo;
  let tokenOne;
  let tokenTwo;
  const em = (n) => `${prefix}-${n}@example.com`;

  const request = (method, urlPath, { token = tokenOne, body } = {}) =>
    fetch(`${baseUrl}/api/v1/suppressions${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const ids = () => [userOne._id, userTwo._id];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Suppression API Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      userOne = await User.create({ name: 'Sup One', email: em('u1'), passwordHash });
      userTwo = await User.create({ name: 'Sup Two', email: em('u2'), passwordHash });
      tokenOne = signAccessToken(userOne);
      tokenTwo = signAccessToken(userTwo);
    }
  });

  beforeEach(async () => {
    if (isDbConnected) {
      await Suppression.deleteMany({ userId: { $in: ids() } });
      await Contact.deleteMany({ userId: { $in: ids() } });
    }
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Suppression.deleteMany({ userId: { $in: ids() } });
      await Contact.deleteMany({ userId: { $in: ids() } });
      await User.deleteMany({ _id: { $in: ids() } });
      await mongoose.disconnect();
    }
  });

  it('requires authentication and validates input', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await request('GET', '', { token: null })).status, 401);
    assert.equal((await request('POST', '', { body: { email: 'nope' } })).status, 400);
    assert.equal((await request('POST', '', { body: { email: em('x'), source: 'link' } })).status, 400);
    assert.equal((await request('GET', '?source=weird')).status, 400);
    assert.equal((await request('DELETE', '/not-an-id')).status, 400);
  });

  it('adds a manual suppression, flags the contact, and rejects duplicates', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Contact.create({ userId: userOne._id, name: 'Target', email: em('target') });
    const res = await request('POST', '', { body: { email: em('target').toUpperCase(), reason: 'Asked by phone' } });
    assert.equal(res.status, 201);
    const sup = (await res.json()).data.suppression;
    assert.equal(sup.source, 'admin');
    assert.equal(sup.removable, true);
    assert.equal(sup.reason, 'Asked by phone');
    assert.equal(sup.userId, undefined);

    const contact = await Contact.findOne({ userId: userOne._id, email: em('target') }).lean();
    assert.equal(contact.isUnsubscribed, true);

    assert.equal((await request('POST', '', { body: { email: em('target') } })).status, 409);
    // another tenant may suppress the same address independently
    assert.equal((await request('POST', '', { token: tokenTwo, body: { email: em('target') } })).status, 201);
  });

  it('lists with search, source filter and tenant isolation', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Suppression.create({ userId: userOne._id, email: em('a'), source: 'link' });
    await Suppression.create({ userId: userOne._id, email: em('b'), source: 'bounce' });
    await Suppression.create({ userId: userTwo._id, email: em('c'), source: 'bounce' });

    let data = (await (await request('GET', '')).json()).data;
    assert.equal(data.pagination.total, 2);
    assert.deepEqual(data.suppressions.map((s) => s.removable).sort(), [false, true]);

    data = (await (await request('GET', '?source=bounce')).json()).data;
    assert.equal(data.count, 1);
    assert.equal(data.suppressions[0].email, em('b'));

    data = (await (await request('GET', `?search=${encodeURIComponent(em('a'))}`)).json()).data;
    assert.equal(data.count, 1);
  });

  it('removes admin and bounce suppressions but never recipient opt-outs or complaints', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.deepEqual(REMOVABLE_SOURCES, ['admin', 'import', 'bounce']);
    const bounce = await Suppression.create({ userId: userOne._id, email: em('bounce'), source: 'bounce' });
    assert.equal((await request('DELETE', `/${bounce._id}`)).status, 200);
    assert.equal(await Suppression.countDocuments({ _id: bounce._id }), 0);

    for (const source of ['link', 'one-click-header', 'complaint']) {
      const locked = await Suppression.create({ userId: userOne._id, email: em(source), source });
      const res = await request('DELETE', `/${locked._id}`);
      assert.equal(res.status, 409, source);
      assert.equal(await Suppression.countDocuments({ _id: locked._id }), 1);
    }
  });

  it('reverses only the manual unsubscribe flag when removing an admin suppression', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Contact.create({ userId: userOne._id, name: 'Manual', email: em('manual') });
    await Contact.create({
      userId: userOne._id,
      name: 'Opted Out',
      email: em('optout'),
      isUnsubscribed: true,
      unsubscribeReason: 'too many emails',
    });
    const manual = (await (await request('POST', '', { body: { email: em('manual') } })).json()).data.suppression;
    assert.equal((await request('DELETE', `/${manual.id}`)).status, 200);
    assert.equal((await Contact.findOne({ email: em('manual') }).lean()).isUnsubscribed, false);

    const optOutSup = await Suppression.create({ userId: userOne._id, email: em('optout'), source: 'admin' });
    await request('DELETE', `/${optOutSup._id}`);
    assert.equal((await Contact.findOne({ email: em('optout') }).lean()).isUnsubscribed, true);
  });

  it('cannot read or remove another tenant suppression', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const foreign = await Suppression.create({ userId: userTwo._id, email: em('f'), source: 'admin' });
    assert.equal((await request('DELETE', `/${foreign._id}`)).status, 404);
    assert.equal(await Suppression.countDocuments({ _id: foreign._id }), 1);
  });
});
