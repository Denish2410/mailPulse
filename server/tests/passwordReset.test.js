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
process.env.CLIENT_URL = 'https://app.example.test';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import { connectDB } from '../src/config/db.js';
import { hashPassword, verifyPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  createResetToken,
  hashResetToken,
  isWellFormedResetToken,
  buildResetLink,
  buildResetEmail,
  RESET_TOKEN_TTL_MS,
} from '../src/services/passwordReset.service.js';

describe('Password reset helpers (no DB)', () => {
  it('creates random single-use tokens and stores only their hash', () => {
    const a = createResetToken(new Date(0));
    const b = createResetToken(new Date(0));
    assert.match(a.token, /^[a-f0-9]{64}$/);
    assert.notEqual(a.token, b.token);
    assert.equal(a.tokenHash, hashResetToken(a.token));
    assert.notEqual(a.tokenHash, a.token);
    assert.equal(a.expiresAt.getTime(), RESET_TOKEN_TTL_MS);
    assert.equal(isWellFormedResetToken(a.token), true);
    for (const bad of ['', 'abc', 'g'.repeat(64), 42, null]) assert.equal(isWellFormedResetToken(bad), false);
  });

  it('builds the link on the first client origin and escapes the name', () => {
    assert.equal(
      buildResetLink('t0k', { CLIENT_URL: 'https://a.example.com/, https://b.example.com' }),
      'https://a.example.com/reset-password?token=t0k'
    );
    assert.equal(buildResetLink('t0k', {}), 'http://localhost:5173/reset-password?token=t0k');
    const mail = buildResetEmail({ name: '<script>x</script>', link: 'https://x/y' });
    assert.ok(!mail.html.includes('<script>'));
    assert.ok(mail.text.includes('https://x/y'));
  });
});

describe('Password reset API', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `pwr-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const email = `${prefix}@example.com`;
  let user;
  let transport;

  const post = (urlPath, body) =>
    fetch(`${baseUrl}/api/v1/auth${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const waitForMail = async () => {
    for (let i = 0; i < 50 && transport.sentEmails.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return transport.sentEmails[0];
  };
  const tokenFrom = (mail) => mail.text.match(/token=([a-f0-9]{64})/)[1];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Password Reset Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      user = await User.create({ name: 'Reset User', email, passwordHash: await hashPassword('OldPassword123!') });
    }
  });

  beforeEach(async () => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse <no-reply@mailpulse.test>' });
    if (isDbConnected) {
      await User.updateOne(
        { _id: user._id },
        { $set: { passwordHash: await hashPassword('OldPassword123!'), status: 'active' }, $unset: { passwordResetTokenHash: '', passwordResetExpiresAt: '' } }
      );
    }
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await User.deleteMany({ _id: user._id });
      await mongoose.disconnect();
    }
  });

  it('answers identically for known and unknown emails, emailing only the real account', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const unknown = await post('/forgot-password', { email: `nobody-${prefix}@example.com` });
    const known = await post('/forgot-password', { email });
    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.deepEqual(await unknown.json(), await known.json());

    const mail = await waitForMail();
    assert.equal(mail.to, email);
    assert.equal(transport.count, 1);
    assert.match(mail.text, /https:\/\/app\.example\.test\/reset-password\?token=[a-f0-9]{64}/);

    const stored = await User.findById(user._id).select('+passwordResetTokenHash +passwordResetExpiresAt').lean();
    assert.equal(stored.passwordResetTokenHash, hashResetToken(tokenFrom(mail)));
    assert.ok(!JSON.stringify(stored).includes(tokenFrom(mail)));
    assert.ok(stored.passwordResetExpiresAt > new Date());
  });

  it('validates input and does not email suspended accounts', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await post('/forgot-password', { email: 'nope' })).status, 400);
    assert.equal((await post('/forgot-password', { email, extra: 1 })).status, 400);
    await User.updateOne({ _id: user._id }, { $set: { status: 'suspended' } });
    assert.equal((await post('/forgot-password', { email })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(transport.count, 0);
  });

  it('resets the password once, then the link is dead', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await post('/forgot-password', { email });
    const token = tokenFrom(await waitForMail());

    const res = await post('/reset-password', { token, password: 'BrandNewPassword456!' });
    assert.equal(res.status, 200);

    const fresh = await User.findById(user._id).select('+passwordHash +passwordResetTokenHash').lean();
    assert.equal(await verifyPassword('BrandNewPassword456!', fresh.passwordHash), true);
    assert.equal(await verifyPassword('OldPassword123!', fresh.passwordHash), false);
    assert.equal(fresh.passwordResetTokenHash, undefined);

    assert.equal((await post('/reset-password', { token, password: 'AnotherPassword789!' })).status, 400);

    const login = await post('/login', { email, password: 'BrandNewPassword456!' });
    assert.equal(login.status, 200);
    assert.equal((await post('/login', { email, password: 'OldPassword123!' })).status, 401);
  });

  it('rejects expired, malformed and unknown tokens and weak passwords', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { token, tokenHash } = createResetToken();
    await User.updateOne({ _id: user._id }, { $set: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await post('/reset-password', { token, password: 'BrandNewPassword456!' })).status, 400);
    assert.equal((await post('/reset-password', { token: 'short', password: 'BrandNewPassword456!' })).status, 400);
    assert.equal((await post('/reset-password', { token: 'a'.repeat(64), password: 'BrandNewPassword456!' })).status, 400);

    await User.updateOne({ _id: user._id }, { $set: { passwordResetExpiresAt: new Date(Date.now() + 60000) } });
    assert.equal((await post('/reset-password', { token, password: 'short' })).status, 400);
    const stillValid = await User.findById(user._id).select('+passwordResetTokenHash').lean();
    assert.equal(stillValid.passwordResetTokenHash, tokenHash);
  });

  it('does not reset suspended accounts', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { token, tokenHash, expiresAt } = createResetToken();
    await User.updateOne({ _id: user._id }, { $set: { status: 'suspended', passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt } });
    assert.equal((await post('/reset-password', { token, password: 'BrandNewPassword456!' })).status, 400);
  });
});
