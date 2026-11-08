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
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { waitForCampaignDispatch } from '../src/services/campaignDispatch.service.js';
import { isVerifiedEmailRequired, assertAccountMaySend } from '../src/utils/sendingPolicy.js';

describe('Verified-email sending policy (no DB)', () => {
  it('defaults on only in production and honours an explicit flag', () => {
    assert.equal(isVerifiedEmailRequired({ NODE_ENV: 'production' }), true);
    assert.equal(isVerifiedEmailRequired({ NODE_ENV: 'development' }), false);
    assert.equal(isVerifiedEmailRequired({ NODE_ENV: 'test' }), false);
    assert.equal(isVerifiedEmailRequired({ NODE_ENV: 'production', REQUIRE_VERIFIED_EMAIL: 'false' }), false);
    assert.equal(isVerifiedEmailRequired({ NODE_ENV: 'development', REQUIRE_VERIFIED_EMAIL: 'TRUE' }), true);
  });

  it('blocks unverified and suspended accounts, allows verified ones', () => {
    const on = { REQUIRE_VERIFIED_EMAIL: 'true' };
    assert.throws(() => assertAccountMaySend({ status: 'active' }, 'send', on), { statusCode: 403 });
    assert.throws(() => assertAccountMaySend({ status: 'suspended', emailVerifiedAt: new Date() }, 'send', on), {
      statusCode: 403,
    });
    assert.doesNotThrow(() => assertAccountMaySend({ status: 'active', emailVerifiedAt: new Date() }, 'send', on));
    assert.doesNotThrow(() => assertAccountMaySend({ status: 'active' }, 'send', { REQUIRE_VERIFIED_EMAIL: 'false' }));
  });
});

describe('Verified-email sending policy (API)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `vs-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let unverified;
  let verified;
  let contact;
  let transport;

  const tokenFor = (u) => signAccessToken(u);
  const post = (urlPath, user, body) =>
    fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(user)}` },
      body: JSON.stringify(body),
    });
  const makeCampaign = (owner) =>
    Campaign.create({
      userId: owner._id,
      name: 'Verify gate',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'draft',
      recipientIds: [contact._id],
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Verified Sending Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      unverified = await User.create({ name: 'Unverified', email: `${prefix}-u@example.com`, passwordHash });
      verified = await User.create({
        name: 'Verified',
        email: `${prefix}-v@example.com`,
        passwordHash,
        emailVerifiedAt: new Date(),
      });
      contact = await Contact.create({ userId: unverified._id, name: 'Recipient', email: `${prefix}-r@example.com` });
    }
  });

  beforeEach(() => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
  });

  afterEach(() => {
    delete process.env.REQUIRE_VERIFIED_EMAIL;
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      const ids = [unverified._id, verified._id];
      await Delivery.deleteMany({ userId: { $in: ids } });
      await Campaign.deleteMany({ userId: { $in: ids } });
      await Contact.deleteMany({ userId: { $in: ids } });
      await User.deleteMany({ _id: { $in: ids } });
      await mongoose.disconnect();
    }
  });

  it('rejects send and schedule for an unverified account when required', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    process.env.REQUIRE_VERIFIED_EMAIL = 'true';
    const c = await makeCampaign(unverified);

    const send = await post(`/api/v1/campaigns/${c._id}/send`, unverified, { confirm: true });
    assert.equal(send.status, 403);
    assert.match((await send.json()).message, /Verify your email/);

    const schedule = await post(`/api/v1/campaigns/${c._id}/schedule`, unverified, {
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal(schedule.status, 403);

    const fresh = await Campaign.findById(c._id);
    assert.equal(fresh.status, 'draft');
    assert.equal(transport.count, 0);
  });

  it('lets a verified account send when required', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    process.env.REQUIRE_VERIFIED_EMAIL = 'true';
    const own = await Contact.create({ userId: verified._id, name: 'Recipient', email: `${prefix}-r2@example.com` });
    const c = await Campaign.create({
      userId: verified._id,
      name: 'Verified send',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'draft',
      recipientIds: [own._id],
    });
    const res = await post(`/api/v1/campaigns/${c._id}/send`, verified, { confirm: true });
    assert.equal(res.status, 202);
    await waitForCampaignDispatch(c._id);
    assert.equal(transport.count, 1);
  });

  it('does not gate an unverified account when the policy is off', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    process.env.REQUIRE_VERIFIED_EMAIL = 'false';
    const c = await makeCampaign(unverified);
    const res = await post(`/api/v1/campaigns/${c._id}/send`, unverified, { confirm: true });
    assert.equal(res.status, 202);
    await waitForCampaignDispatch(c._id);
  });
});
