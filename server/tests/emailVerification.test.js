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
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  createVerificationToken,
  buildVerificationLink,
  buildVerificationEmail,
  hashResetToken,
  VERIFICATION_TOKEN_TTL_MS,
} from '../src/services/passwordReset.service.js';

describe('Verification helpers (no DB)', () => {
  it('creates 24 hour hashed tokens and builds the link', () => {
    const t = createVerificationToken(new Date(0));
    assert.match(t.token, /^[a-f0-9]{64}$/);
    assert.equal(t.tokenHash, hashResetToken(t.token));
    assert.equal(t.expiresAt.getTime(), VERIFICATION_TOKEN_TTL_MS);
    assert.equal(buildVerificationLink('abc', { CLIENT_URL: 'https://x.test/' }), 'https://x.test/verify-email?token=abc');
    const mail = buildVerificationEmail({ name: '<b>Bob</b>', link: 'https://x/y' });
    assert.ok(!mail.html.includes('<b>'));
    assert.ok(mail.text.includes('https://x/y'));
  });
});

describe('Email verification API', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `ver-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const email = `${prefix}@example.com`;
  let transport;

  const post = (urlPath, body, token) =>
    fetch(`${baseUrl}/api/v1/auth${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body ?? {}),
    });
  const waitForMail = async (count = 1) => {
    for (let i = 0; i < 80 && transport.sentEmails.length < count; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return transport.sentEmails[count - 1];
  };
  const tokenFrom = (mail) => mail.text.match(/token=([a-f0-9]{64})/)[1];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Email Verification Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse <no-reply@mailpulse.test>' });
    if (isDbConnected) await User.deleteMany({ email });
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await User.deleteMany({ email });
      await mongoose.disconnect();
    }
  });

  const register = async () => {
    const res = await post('/register', { name: 'Verify Me', email, password: 'StrongPassword123!' });
    return res.json();
  };

  it('registers unverified, emails a link, and verifies exactly once', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const body = await register();
    assert.equal(body.data.user.emailVerified, false);

    const mail = await waitForMail();
    assert.equal(mail.to, email);
    const token = tokenFrom(mail);
    const stored = await User.findOne({ email }).select('+emailVerificationTokenHash').lean();
    assert.equal(stored.emailVerificationTokenHash, hashResetToken(token));
    assert.ok(!JSON.stringify(stored).includes(token));

    assert.equal((await post('/verify-email', { token })).status, 200);
    const verified = await User.findOne({ email }).select('+emailVerificationTokenHash').lean();
    assert.ok(verified.emailVerifiedAt);
    assert.equal(verified.emailVerificationTokenHash, undefined);

    assert.equal((await post('/verify-email', { token })).status, 400);
    const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${body.data.token}` } });
    assert.equal((await me.json()).data.user.emailVerified, true);
  });

  it('still registers when the verification email cannot be sent', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    app.locals.emailService = { sendEmail: async () => { throw new Error('SMTP down'); } };
    const res = await post('/register', { name: 'Verify Me', email, password: 'StrongPassword123!' });
    assert.equal(res.status, 201);
  });

  it('rejects malformed, unknown and expired tokens', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await register();
    const token = tokenFrom(await waitForMail());
    assert.equal((await post('/verify-email', { token: 'short' })).status, 400);
    assert.equal((await post('/verify-email', { token: 'a'.repeat(64) })).status, 400);
    assert.equal((await post('/verify-email', {})).status, 400);

    await User.updateOne({ email }, { $set: { emailVerificationExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await post('/verify-email', { token })).status, 400);
    assert.equal((await User.findOne({ email }).lean()).emailVerifiedAt, null);
  });

  it('resends for unverified users only and requires authentication', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const body = await register();
    await waitForMail();
    assert.equal((await post('/resend-verification', {})).status, 401);

    const res = await post('/resend-verification', {}, body.data.token);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.emailVerified, false);
    const second = await waitForMail(2);
    const token = tokenFrom(second);
    assert.equal((await post('/verify-email', { token })).status, 200);

    const again = await post('/resend-verification', {}, body.data.token);
    assert.equal((await again.json()).data.emailVerified, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(transport.count, 2);
  });
});
