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
import Contact from '../src/models/Contact.js';
import SignupForm from '../src/models/SignupForm.js';
import Suppression from '../src/models/Suppression.js';
import PendingSubscription from '../src/models/PendingSubscription.js';
import { connectDB } from '../src/config/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { buildConfirmationLink, buildConfirmationEmail } from '../src/services/signupSubscription.service.js';
import { hashResetToken } from '../src/services/passwordReset.service.js';

describe('Subscription email helpers (no DB)', () => {
  it('builds the link and strips markup from the form name', () => {
    assert.equal(buildConfirmationLink('abc', { CLIENT_URL: 'https://a.test/' }), 'https://a.test/confirm-subscription?token=abc');
    const mail = buildConfirmationEmail({ formName: '<script>x</script> News', link: 'https://x/y' });
    assert.ok(!mail.html.includes('<script>'));
    assert.ok(!mail.subject.includes('<'));
    assert.ok(mail.text.includes('https://x/y'));
  });
});

describe('Public signup (double opt-in)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `pub-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let owner;
  let form;
  let disabledForm;
  let transport;
  const em = (n) => `${prefix}-${n}@example.com`;

  const call = (method, urlPath, body) =>
    fetch(`${baseUrl}/api/v1/public${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const subscribe = (email, extra = {}, slug = form.slug) => call('POST', `/forms/${slug}/subscribe`, { email, ...extra });
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
      await PendingSubscription.init();
    } catch (err) {
      console.warn(`[Public Signup Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      owner = await User.create({ name: 'Pub Owner', email: em('owner'), passwordHash: await hashPassword('StrongPassword123!') });
      form = await SignupForm.create({ userId: owner._id, name: 'Weekly News', description: 'Every Friday', tags: ['news', 'web'] });
      disabledForm = await SignupForm.create({ userId: owner._id, name: 'Closed', enabled: false });
    }
  });

  beforeEach(async () => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse <no-reply@mailpulse.test>' });
    if (isDbConnected) {
      await PendingSubscription.deleteMany({ userId: owner._id });
      await Contact.deleteMany({ userId: owner._id });
      await Suppression.deleteMany({ userId: owner._id });
    }
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await PendingSubscription.deleteMany({ userId: owner._id });
      await Contact.deleteMany({ userId: owner._id });
      await Suppression.deleteMany({ userId: owner._id });
      await SignupForm.deleteMany({ userId: owner._id });
      await User.deleteMany({ _id: owner._id });
      await mongoose.disconnect();
    }
  });

  it('exposes only the name and description of enabled forms', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await call('GET', `/forms/${form.slug}`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.form, { name: 'Weekly News', description: 'Every Friday' });
    assert.equal((await call('GET', `/forms/${disabledForm.slug}`)).status, 404);
    assert.equal((await call('GET', `/forms/${'0'.repeat(24)}`)).status, 404);
    assert.equal((await call('GET', '/forms/not-a-slug')).status, 400);
  });

  it('subscribe -> email -> confirm creates a tagged contact for the owner, once', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await subscribe(em('fan').toUpperCase(), { name: 'Fan Person' });
    assert.equal(res.status, 200);
    assert.equal(await Contact.countDocuments({ userId: owner._id }), 0, 'no contact before confirmation');

    const mail = await waitForMail();
    assert.equal(mail.to, em('fan'));
    assert.match(mail.text, /https:\/\/app\.example\.test\/confirm-subscription\?token=[a-f0-9]{64}/);
    const token = tokenFrom(mail);
    const pending = await PendingSubscription.findOne({ userId: owner._id }).lean();
    assert.equal(pending.tokenHash, hashResetToken(token));
    assert.ok(!JSON.stringify(pending).includes(token));

    const confirm = await call('POST', '/subscriptions/confirm', { token });
    assert.equal(confirm.status, 200);
    assert.equal((await confirm.json()).data.formName, 'Weekly News');

    const contact = await Contact.findOne({ userId: owner._id, email: em('fan') }).lean();
    assert.equal(contact.name, 'Fan Person');
    assert.deepEqual(contact.tags, ['news', 'web']);
    assert.equal(contact.isUnsubscribed, false);

    assert.equal((await call('POST', '/subscriptions/confirm', { token })).status, 400);
    assert.equal(await Contact.countDocuments({ userId: owner._id }), 1);
  });

  it('answers identically for invalid-but-wellformed requests and ignores honeypot submissions', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const bot = await subscribe(em('bot'), { website: 'http://spam.example' });
    assert.equal(bot.status, 200);
    const human = await subscribe(em('human'));
    assert.deepEqual(await bot.json(), await human.json());
    await waitForMail();
    assert.equal(transport.count, 1);
    assert.equal(transport.sentEmails[0].to, em('human'));

    assert.equal((await subscribe('not-an-email')).status, 400);
    assert.equal((await call('POST', `/forms/${form.slug}/subscribe`, { email: em('x'), extra: 1 })).status, 400);
    assert.equal((await subscribe(em('x'), {}, disabledForm.slug)).status, 404);
  });

  it('throttles repeat submissions for the same address (cooldown) and stays uniform', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const first = await subscribe(em('twice'));
    await waitForMail();
    const second = await subscribe(em('twice'));
    assert.deepEqual(await first.json(), await second.json());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(transport.count, 1);
    assert.equal(await PendingSubscription.countDocuments({ userId: owner._id }), 1);
  });

  it('rejects expired, malformed and unknown tokens, and tokens for disabled forms', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await subscribe(em('late'));
    const token = tokenFrom(await waitForMail());
    assert.equal((await call('POST', '/subscriptions/confirm', { token: 'short' })).status, 400);
    assert.equal((await call('POST', '/subscriptions/confirm', { token: 'a'.repeat(64) })).status, 400);

    await PendingSubscription.updateOne({ userId: owner._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await call('POST', '/subscriptions/confirm', { token })).status, 400);
    assert.equal(await Contact.countDocuments({ userId: owner._id }), 0);

    await SignupForm.updateOne({ _id: form._id }, { $set: { enabled: false } });
    try {
      await PendingSubscription.updateOne({ userId: owner._id }, { $set: { expiresAt: new Date(Date.now() + 60000) } });
      assert.equal((await call('POST', '/subscriptions/confirm', { token })).status, 400);
      assert.equal(await Contact.countDocuments({ userId: owner._id }), 0);
    } finally {
      await SignupForm.updateOne({ _id: form._id }, { $set: { enabled: true } });
    }
  });

  it('adds tags to an existing contact and lifts the contact’s own earlier unsubscribe', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Contact.create({ userId: owner._id, name: 'Back Again', email: em('back'), tags: ['old'], isUnsubscribed: true, unsubscribeReason: 'too many' });
    await Suppression.create({ userId: owner._id, email: em('back'), source: 'link' });

    await subscribe(em('back'));
    const token = tokenFrom(await waitForMail());
    assert.equal((await call('POST', '/subscriptions/confirm', { token })).status, 200);

    const contact = await Contact.findOne({ userId: owner._id, email: em('back') }).lean();
    assert.deepEqual([...contact.tags].sort(), ['news', 'old', 'web']);
    assert.equal(contact.isUnsubscribed, false);
    assert.equal(await Suppression.countDocuments({ userId: owner._id, email: em('back') }), 0);
  });

  it('never re-subscribes bounced, complained or owner-suppressed addresses (and does not reveal it)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (const source of ['bounce', 'complaint', 'admin']) {
      transport.clear();
      await Suppression.create({ userId: owner._id, email: em(source), source });
      const res = await subscribe(em(source));
      assert.equal(res.status, 200, source);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(transport.count, 0, `${source}: no email sent`);
      assert.equal(await PendingSubscription.countDocuments({ userId: owner._id, email: em(source) }), 0);
    }

    // Suppressed after the request but before confirmation: confirm succeeds silently, nothing created
    await subscribe(em('race'));
    const token = tokenFrom(await waitForMail());
    await Suppression.create({ userId: owner._id, email: em('race'), source: 'complaint' });
    assert.equal((await call('POST', '/subscriptions/confirm', { token })).status, 200);
    assert.equal(await Contact.countDocuments({ userId: owner._id, email: em('race') }), 0);
    assert.equal(await Suppression.countDocuments({ userId: owner._id, email: em('race'), source: 'complaint' }), 1);
  });
});
