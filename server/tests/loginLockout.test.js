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
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import { connectDB } from '../src/config/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { createResetToken } from '../src/services/passwordReset.service.js';
import {
  getLoginThrottleConfig,
  isLoginLocked,
  DEFAULT_MAX_FAILURES,
} from '../src/services/loginThrottle.service.js';

const GOOD = 'CorrectHorse-Battery9!';
const BAD = 'WrongPassword-123!';

describe('Login throttle config (no DB)', () => {
  it('defaults to 5 failures / 15 minutes and accepts overrides', () => {
    const d = getLoginThrottleConfig({});
    assert.equal(d.maxFailures, DEFAULT_MAX_FAILURES);
    assert.equal(d.lockMs, 15 * 60 * 1000);
    const o = getLoginThrottleConfig({ LOGIN_MAX_FAILURES: '3', LOGIN_LOCK_MINUTES: '30' });
    assert.equal(o.maxFailures, 3);
    assert.equal(o.lockMs, 30 * 60 * 1000);
    assert.equal(getLoginThrottleConfig({ LOGIN_MAX_FAILURES: '-1', LOGIN_LOCK_MINUTES: 'x' }).maxFailures, 5);
  });

  it('isLoginLocked compares against the clock', () => {
    assert.equal(isLoginLocked(null), false);
    assert.equal(isLoginLocked({}), false);
    assert.equal(isLoginLocked({ lockedUntil: new Date(Date.now() + 1000) }), true);
    assert.equal(isLoginLocked({ lockedUntil: new Date(Date.now() - 1000) }), false);
  });
});

describe('Per-account login lockout', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `lock-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const created = [];
  let user;
  let other;

  const login = (email, password) =>
    fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const state = () => User.findById(user._id).select('+lockedUntil +loginFailureCount').lean();
  const makeUser = async (label) => {
    const u = await User.create({
      name: `Lock ${label}`,
      email: `${prefix}-${label}@example.com`,
      passwordHash: await hashPassword(GOOD),
    });
    created.push(u._id);
    return u;
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Lockout Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    if (!isDbConnected) return;
    await User.deleteMany({ _id: { $in: created } });
    created.length = 0;
    user = await makeUser('target');
    other = await makeUser('bystander');
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await User.deleteMany({ _id: { $in: created } });
      await mongoose.disconnect();
    }
  });

  it('locks after 5 wrong passwords, even for the correct password, with an identical answer', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 0; i < 5; i += 1) {
      const r = await login(user.email, BAD);
      assert.equal(r.status, 401);
    }
    const locked = await login(user.email, GOOD);
    assert.equal(locked.status, 401);
    const unknown = await login(`${prefix}-nobody@example.com`, GOOD);
    assert.equal(locked.body.message, unknown.body.message, 'locked must look like any failed login');
    assert.equal(locked.status, unknown.status);
    assert.ok(isLoginLocked(await state()));
  });

  it('does not lock before the limit, and a success clears the counter', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 0; i < 4; i += 1) await login(user.email, BAD);
    assert.equal((await state()).loginFailureCount, 4);
    assert.equal((await login(user.email, GOOD)).status, 200);
    const cleared = await state();
    assert.equal(cleared.loginFailureCount, undefined);
    for (let i = 0; i < 4; i += 1) await login(user.email, BAD); // 4 more: still under the limit
    assert.equal((await login(user.email, GOOD)).status, 200);
  });

  it('allows login again once the lock expires', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 0; i < 5; i += 1) await login(user.email, BAD);
    assert.equal((await login(user.email, GOOD)).status, 401);
    await User.collection.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() - 1000), loginFailureAt: new Date(Date.now() - 20 * 60 * 1000) } });
    assert.equal((await login(user.email, GOOD)).status, 200);
    assert.equal((await state()).lockedUntil, undefined);
  });

  it('failures older than the window do not accumulate', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 0; i < 4; i += 1) await login(user.email, BAD);
    await User.collection.updateOne({ _id: user._id }, { $set: { loginFailureAt: new Date(Date.now() - 20 * 60 * 1000) } });
    await login(user.email, BAD); // would be #5, but the old failures expired
    assert.equal((await state()).loginFailureCount, 1);
    assert.equal(isLoginLocked(await state()), false);
  });

  it('cannot be bypassed by firing guesses in parallel', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Promise.all(Array.from({ length: 20 }, () => login(user.email, BAD)));
    assert.ok(isLoginLocked(await state()), 'locked after the parallel burst');
    assert.equal((await login(user.email, GOOD)).status, 401);
  });

  it('only locks the targeted account', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 0; i < 6; i += 1) await login(user.email, BAD);
    assert.equal((await login(other.email, GOOD)).status, 200);
  });

  it('a password reset lifts the lock', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 0; i < 5; i += 1) await login(user.email, BAD);
    assert.equal((await login(user.email, GOOD)).status, 401);

    const { token, tokenHash, expiresAt } = createResetToken();
    await User.updateOne({ _id: user._id }, { $set: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt } });
    const reset = await fetch(`${baseUrl}/api/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'BrandNewPassword-77!' }),
    });
    assert.equal(reset.status, 200);
    assert.equal((await login(user.email, 'BrandNewPassword-77!')).status, 200);
  });
});
