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

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import { connectDB } from '../src/config/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';

describe('forgot-password does identical database work for every address', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `fp-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let active;
  let suspended;
  let transport;

  const forgot = (email) =>
    fetch(`${baseUrl}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  /** Runs one request and reports how many User.updateOne calls it made and what they matched. */
  const observe = async (email) => {
    const calls = [];
    const original = User.updateOne.bind(User);
    const spy = mock.method(User, 'updateOne', (filter, update) => {
      calls.push({ filter, update });
      return original(filter, update);
    });
    try {
      const res = await forgot(email);
      return { res, calls };
    } finally {
      spy.mock.restore();
    }
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Forgot Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('SomePassword-123!');
      active = await User.create({ name: 'Active User', email: `${prefix}-active@example.com`, passwordHash });
      suspended = await User.create({ name: 'Suspended User', email: `${prefix}-sus@example.com`, passwordHash, status: 'suspended' });
    }
    transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await User.deleteMany({ _id: { $in: [active._id, suspended._id] } });
      await mongoose.disconnect();
    }
  });

  it('answers identically and runs exactly one update for known, unknown and suspended addresses', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const known = await observe(active.email);
    const unknown = await observe(`${prefix}-nobody@example.com`);
    const blocked = await observe(suspended.email);

    for (const r of [known, unknown, blocked]) {
      assert.equal(r.res.status, 200);
      assert.equal(r.calls.length, 1, 'one update regardless of the address');
      assert.ok(r.calls[0].update.$set.passwordResetTokenHash, 'a token is generated in every case');
    }
    assert.deepEqual(known.res.body, unknown.res.body);
    assert.deepEqual(known.res.body, blocked.res.body);
  });

  it('only the real, active account actually receives a token', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await forgot(active.email);
    await forgot(suspended.email);
    const a = await User.findById(active._id).select('+passwordResetTokenHash').lean();
    const s = await User.findById(suspended._id).select('+passwordResetTokenHash').lean();
    assert.ok(a.passwordResetTokenHash);
    assert.ok(!s.passwordResetTokenHash, 'a suspended account gets no token');
  });
});
