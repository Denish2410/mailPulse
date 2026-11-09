import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
delete process.env.SMTP_HOST;

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import { connectDB } from '../src/config/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { getPasswordWeakness } from '../src/utils/passwordPolicy.js';
import { registerSchema, resetPasswordSchema } from '../src/validators/auth.validator.js';

describe('getPasswordWeakness', () => {
  it('rejects repetitive passwords', () => {
    assert.match(getPasswordWeakness('aaaaaaaa'), /repetitive/);
    assert.match(getPasswordWeakness('abababab'), /repetitive/);
    assert.match(getPasswordWeakness('11221122'), /repetitive/);
  });

  it('rejects simple runs in either direction', () => {
    assert.match(getPasswordWeakness('12345678'), /simple/);
    assert.match(getPasswordWeakness('87654321'), /simple/);
    assert.match(getPasswordWeakness('abcdefgh'), /simple/);
    assert.match(getPasswordWeakness('ZYXWVUTS'), /simple/);
  });

  it('rejects common passwords case-insensitively', () => {
    for (const p of ['password', 'PASSWORD', 'Password123', 'qwertyuiop', 'iloveyou', 'MailPulse1']) {
      assert.match(getPasswordWeakness(p), /common/, p);
    }
  });

  it('rejects passwords containing the email name, but only when it is long enough to matter', () => {
    assert.match(getPasswordWeakness('jonathan-2026-x', { email: 'jonathan@example.com' }), /email name/);
    assert.equal(getPasswordWeakness('jo-2026-secure-x', { email: 'jo@example.com' }), null); // 2-char name ignored
  });

  it('accepts reasonable passwords, long ones and passphrases', () => {
    for (const p of ['CorrectHorse-Battery9!', 'tr0ub4dor&3-xyz', 'my dog likes long walks', 'Zq7!mP2#', 'sunrise-over-the-hills']) {
      assert.equal(getPasswordWeakness(p), null, p);
    }
    assert.equal(getPasswordWeakness(undefined), null);
  });
});

describe('schemas apply the policy', () => {
  it('register blocks weak and email-derived passwords with a message on the password field', () => {
    const base = { name: 'Valid Name', email: 'taylor.swift@example.com' };
    const weak = registerSchema.safeParse({ body: { ...base, password: 'aaaaaaaa' } });
    assert.equal(weak.success, false);
    assert.deepEqual(weak.error.issues[0].path, ['body', 'password']);
    assert.equal(registerSchema.safeParse({ body: { ...base, password: 'Taylor.Swift-2026' } }).success, false);
    assert.equal(registerSchema.safeParse({ body: { ...base, password: 'CorrectHorse-Battery9!' } }).success, true);
  });

  it('reset blocks weak passwords too', () => {
    const token = 'a'.repeat(64);
    assert.equal(resetPasswordSchema.safeParse({ body: { token, password: '12345678' } }).success, false);
    assert.equal(resetPasswordSchema.safeParse({ body: { token, password: 'CorrectHorse-Battery9!' } }).success, true);
  });
});

describe('policy over HTTP', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `pw-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const emails = [];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Password Policy Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await User.deleteMany({ email: { $in: emails } });
      await mongoose.disconnect();
    }
  });

  const post = (urlPath, body) =>
    fetch(`${baseUrl}/api/v1${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('register refuses a weak password with 400 and creates nothing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const email = `${prefix}-weak@example.com`;
    emails.push(email);
    const res = await post('/auth/register', { name: 'Weak Pw', email, password: 'aaaaaaaa' });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /repetitive/);
    assert.equal(await User.countDocuments({ email }), 0);
  });

  it('an existing account with a weak password can still log in', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const email = `${prefix}-legacy@example.com`;
    emails.push(email);
    await User.create({ name: 'Legacy User', email, passwordHash: await hashPassword('password123') });
    const res = await post('/auth/login', { email, password: 'password123' });
    assert.equal(res.status, 200);
  });
});
