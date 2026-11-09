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
delete process.env.SMTP_HOST;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import { connectDB } from '../src/config/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { signAccessToken } from '../src/utils/token.js';
import { createResetToken } from '../src/services/passwordReset.service.js';

const PASSWORD = 'CorrectHorse-Battery9!';

describe('signAccessToken revocation claim (no DB)', () => {
  const decode = (t) => jwt.decode(t);
  it('adds tv only when the version is above zero', () => {
    assert.equal(decode(signAccessToken({ _id: 'abc', tokenVersion: 0 })).tv, undefined);
    assert.equal(decode(signAccessToken('abc')).tv, undefined);
    assert.equal(decode(signAccessToken({ _id: 'abc', tokenVersion: 3 })).tv, 3);
    assert.equal(decode(signAccessToken({ _id: 'abc', tokenVersion: -1 })).tv, undefined);
    assert.equal(decode(signAccessToken({ _id: 'abc', tokenVersion: 'x' })).tv, undefined);
  });
});

describe('Token revocation and live-session checks', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `rev-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const created = [];
  let user;

  const call = (method, urlPath, token, body) =>
    fetch(`${baseUrl}/api/v1${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const login = async (email = user.email, password = PASSWORD) => (await (await call('POST', '/auth/login', null, { email, password })).json()).data?.token;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Revocation Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    if (!isDbConnected) return;
    await Contact.deleteMany({ userId: { $in: created } });
    await User.deleteMany({ _id: { $in: created } });
    created.length = 0;
    user = await User.create({ name: 'Rev User', email: `${prefix}@example.com`, passwordHash: await hashPassword(PASSWORD) });
    created.push(user._id);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Contact.deleteMany({ userId: { $in: created } });
      await User.deleteMany({ _id: { $in: created } });
      await mongoose.disconnect();
    }
  });

  it('keeps working for tokens issued before the feature existed (no tv claim)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const legacy = signAccessToken(String(user._id));
    assert.equal(jwt.decode(legacy).tv, undefined);
    assert.equal((await call('GET', '/auth/me', legacy)).status, 200);
  });

  it('"sign out everywhere" invalidates every older token but not a new login', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const a = await login();
    const b = await login();
    assert.equal((await call('GET', '/auth/me', a)).status, 200);

    assert.equal((await call('POST', '/auth/logout-all', a)).status, 200);
    for (const old of [a, b]) {
      assert.equal((await call('GET', '/auth/me', old)).status, 401);
      assert.equal((await call('GET', '/contacts', old)).status, 401);
    }
    const fresh = await login();
    assert.equal(jwt.decode(fresh).tv, 1);
    assert.equal((await call('GET', '/auth/me', fresh)).status, 200);
  });

  it('a password reset revokes sessions signed in with the old password', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const stolen = await login();
    const { token, tokenHash, expiresAt } = createResetToken();
    await User.updateOne({ _id: user._id }, { $set: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt } });
    assert.equal((await call('POST', '/auth/reset-password', null, { token, password: 'BrandNewPassword-77!' })).status, 200);

    assert.equal((await call('GET', '/auth/me', stolen)).status, 401);
    const fresh = await login(user.email, 'BrandNewPassword-77!');
    assert.equal((await call('GET', '/auth/me', fresh)).status, 200);
  });

  it('rejects forged or mismatched version claims', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    // account is at version 0; a token claiming version 5 must not be accepted
    const claimsFuture = jwt.sign({ userId: String(user._id), tv: 5 }, process.env.JWT_SECRET, {
      algorithm: 'HS256', expiresIn: '15m', issuer: 'mailpulse-api', audience: 'mailpulse-client', subject: String(user._id),
    });
    assert.equal((await call('GET', '/auth/me', claimsFuture)).status, 401);

    await User.updateOne({ _id: user._id }, { $set: { tokenVersion: 2 } });
    const stale = signAccessToken({ _id: user._id, tokenVersion: 1 });
    assert.equal((await call('GET', '/auth/me', stale)).status, 401);
    assert.equal((await call('GET', '/auth/me', signAccessToken({ _id: user._id, tokenVersion: 2 }))).status, 200);
  });

  it('a deleted account\'s token cannot create orphan data', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const token = await login();
    assert.equal((await call('DELETE', '/auth/me', token, { password: PASSWORD })).status, 200);
    const res = await call('POST', '/contacts', token, { name: 'Orphan Contact', email: `${prefix}-orphan@example.com` });
    assert.equal(res.status, 401);
    assert.equal(await Contact.countDocuments({ email: `${prefix}-orphan@example.com` }), 0);
  });

  it('rejects a token whose user id is not a valid ObjectId', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await call('GET', '/contacts', signAccessToken('not-an-object-id'))).status, 401);
  });

  it('public endpoints do not need a session', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await fetch(`${baseUrl}/api/v1/health`)).status, 200);
    assert.equal((await call('POST', '/auth/login', null, { email: user.email, password: PASSWORD })).status, 200);
  });
});
