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
import Template from '../src/models/Template.js';
import Segment from '../src/models/Segment.js';
import Suppression from '../src/models/Suppression.js';
import SignupForm from '../src/models/SignupForm.js';
import TrackingEvent from '../src/models/TrackingEvent.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { waitForCampaignDispatch } from '../src/services/campaignDispatch.service.js';
import { appendMailingAddress } from '../src/services/tracking.service.js';
import { isMailingAddressRequired, assertAccountMaySend } from '../src/utils/sendingPolicy.js';
import { updateProfileSchema, deleteAccountSchema } from '../src/validators/auth.validator.js';

const PASSWORD = 'StrongPassword123!';

describe('Mailing address footer (no DB)', () => {
  it('adds an escaped block before </body> and a trailing text line', () => {
    const { html, text } = appendMailingAddress(
      '<html><body><p>Hi</p></body></html>',
      'Hi',
      '1 Main St <script>alert(1)</script>\nSpringfield'
    );
    assert.match(html, /1 Main St &lt;script&gt;alert\(1\)&lt;\/script&gt;<br>Springfield<\/div>\n<\/body>/);
    assert.ok(!html.includes('<script>'));
    assert.equal(text, 'Hi\n\n1 Main St <script>alert(1)</script>\nSpringfield');
  });

  it('leaves content untouched when the address is empty and skips empty bodies', () => {
    assert.deepEqual(appendMailingAddress('<p>x</p>', 'x', '   '), { html: '<p>x</p>', text: 'x' });
    const onlyText = appendMailingAddress('', 'Plain', '1 Main St');
    assert.equal(onlyText.html, '');
    assert.match(onlyText.text, /1 Main St$/);
  });

  it('is not fooled by "$&" style patterns in the address', () => {
    const { html } = appendMailingAddress('<body>x</body>', '', 'Box $& 5');
    assert.match(html, /Box \$&amp; 5/);
  });
});

describe('Mailing address policy and validators (no DB)', () => {
  it('is required in production by default and overridable', () => {
    assert.equal(isMailingAddressRequired({ NODE_ENV: 'production' }), true);
    assert.equal(isMailingAddressRequired({ NODE_ENV: 'test' }), false);
    assert.equal(isMailingAddressRequired({ NODE_ENV: 'production', REQUIRE_MAILING_ADDRESS: 'false' }), false);
    const env = { REQUIRE_MAILING_ADDRESS: 'true' };
    assert.throws(() => assertAccountMaySend({ status: 'active' }, 'send', env), { statusCode: 403 });
    assert.throws(() => assertAccountMaySend({ status: 'active', mailingAddress: '  ' }, 'send', env), { statusCode: 403 });
    assert.doesNotThrow(() => assertAccountMaySend({ status: 'active', mailingAddress: '1 Main St' }, 'send', env));
  });

  it('validates profile updates and account deletion bodies', () => {
    const parse = (body) => updateProfileSchema.safeParse({ body });
    assert.equal(parse({ mailingAddress: '1 Main St' }).success, true);
    assert.equal(parse({}).success, false);
    assert.equal(parse({ mailingAddress: 'x'.repeat(301) }).success, false);
    assert.equal(parse({ role: 'admin' }).success, false);
    assert.equal(deleteAccountSchema.safeParse({ body: { password: 'x' } }).success, true);
    assert.equal(deleteAccountSchema.safeParse({ body: {} }).success, false);
  });
});

describe('Account settings, export and deletion', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `priv-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let owner;
  let other;
  let transport;
  const created = [];

  const req = (method, urlPath, user, body) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signAccessToken(user)}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const makeUser = async (label) => {
    const user = await User.create({
      name: `Priv ${label}`,
      email: `${prefix}-${label}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    created.push(user._id);
    return user;
  };
  const seed = async (user, label) => {
    const contact = await Contact.create({ userId: user._id, name: `C ${label}`, email: `${prefix}-c-${label}@example.com` });
    const campaign = await Campaign.create({
      userId: user._id,
      name: `Camp ${label}`,
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'sent',
      recipientIds: [contact._id],
      dispatchLeaseOwner: 'internal-instance-id',
    });
    await Delivery.create({ campaignId: campaign._id, userId: user._id, contactId: contact._id, email: contact.email, status: 'sent' });
    await Template.create({ userId: user._id, name: `T ${label}`, subject: 'S', textContent: 'x' });
    await Segment.create({ userId: user._id, name: `S ${label}`, criteria: { tagsAny: ['a'] } });
    await Suppression.create({ userId: user._id, email: `${prefix}-s-${label}@example.com`, source: 'admin', reason: 'test' });
    await SignupForm.create({ userId: user._id, name: `F ${label}`, slug: `${prefix}-${label}`.slice(0, 40) });
    await TrackingEvent.create({
      campaignId: campaign._id,
      recipientId: contact._id,
      recipientEmail: contact.email,
      eventType: 'open',
      ip: 'secret-ip-value',
    });
    return { contact, campaign };
  };
  const countsFor = async (user) => ({
    contacts: await Contact.countDocuments({ userId: user._id }),
    campaigns: await Campaign.countDocuments({ userId: user._id }),
    deliveries: await Delivery.countDocuments({ userId: user._id }),
    templates: await Template.countDocuments({ userId: user._id }),
    segments: await Segment.countDocuments({ userId: user._id }),
    suppressions: await Suppression.countDocuments({ userId: user._id }),
    forms: await SignupForm.countDocuments({ userId: user._id }),
    events: await TrackingEvent.countDocuments({ campaignId: { $in: await Campaign.distinct('_id', { userId: user._id }) } }),
  });
  const wipe = async () => {
    const campaignIds = await Campaign.distinct('_id', { userId: { $in: created } });
    await TrackingEvent.deleteMany({ campaignId: { $in: campaignIds } });
    for (const model of [Contact, Campaign, Delivery, Template, Segment, Suppression, SignupForm]) {
      await model.deleteMany({ userId: { $in: created } });
    }
    await User.deleteMany({ _id: { $in: created } });
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Privacy Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    if (!isDbConnected) return;
    await wipe();
    created.length = 0;
    owner = await makeUser('owner');
    other = await makeUser('other');
    transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
  });

  afterEach(() => {
    delete process.env.REQUIRE_MAILING_ADDRESS;
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await wipe();
      await mongoose.disconnect();
    }
  });

  it('updates the mailing address and name, and returns them on /me', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await req('PATCH', '/api/v1/auth/me', owner, { mailingAddress: '1 Main St, Springfield', name: 'New Name' });
    assert.equal(res.status, 200);
    const user = (await res.json()).data.user;
    assert.equal(user.mailingAddress, '1 Main St, Springfield');
    assert.equal(user.name, 'New Name');
    const me = await (await req('GET', '/api/v1/auth/me', owner)).json();
    assert.equal(me.data.user.mailingAddress, '1 Main St, Springfield');
    assert.equal((await req('PATCH', '/api/v1/auth/me', owner, { email: 'x@y.co' })).status, 400);
  });

  it('exports only the caller\'s data, without secrets', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await seed(owner, 'owner');
    await seed(other, 'other');
    const res = await req('GET', '/api/v1/auth/me/export', owner);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    const raw = await res.text();
    const data = JSON.parse(raw);

    assert.equal(data.account.email, owner.email);
    assert.equal(data.contacts.length, 1);
    assert.equal(data.campaigns.length, 1);
    assert.equal(data.deliveries.length, 1);
    assert.equal(data.templates.length, 1);
    assert.equal(data.segments.length, 1);
    assert.equal(data.suppressions.length, 1);
    assert.equal(data.signupForms.length, 1);
    assert.equal(data.trackingEvents.length, 1);
    assert.ok(!raw.includes(`${prefix}-c-other`), 'must not leak another tenant');
    assert.ok(!raw.includes('passwordHash'));
    assert.ok(!raw.includes('secret-ip-value'));
    assert.ok(!raw.includes('internal-instance-id'));
  });

  it('requires authentication for export and deletion', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/me/export`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/v1/auth/me`, { method: 'DELETE' })).status, 401);
  });

  it('refuses deletion with a wrong password and keeps everything', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await seed(owner, 'owner');
    const res = await req('DELETE', '/api/v1/auth/me', owner, { password: 'WrongPassword999!' });
    assert.equal(res.status, 403);
    assert.ok(await User.exists({ _id: owner._id }));
    assert.equal((await countsFor(owner)).contacts, 1);
  });

  it('refuses deletion while a campaign is sending or scheduled', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { campaign } = await seed(owner, 'owner');
    await Campaign.updateOne({ _id: campaign._id }, { $set: { status: 'sending' } });
    assert.equal((await req('DELETE', '/api/v1/auth/me', owner, { password: PASSWORD })).status, 409);
    await Campaign.updateOne({ _id: campaign._id }, { $set: { status: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000) } });
    assert.equal((await req('DELETE', '/api/v1/auth/me', owner, { password: PASSWORD })).status, 409);
    assert.ok(await User.exists({ _id: owner._id }));
  });

  it('deletes the account and all its data, and nobody else\'s', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await seed(owner, 'owner');
    await seed(other, 'other');
    const res = await req('DELETE', '/api/v1/auth/me', owner, { password: PASSWORD });
    assert.equal(res.status, 200);

    assert.equal(await User.exists({ _id: owner._id }), null);
    assert.deepEqual(Object.values(await countsFor(owner)), [0, 0, 0, 0, 0, 0, 0, 0]);
    const kept = await countsFor(other);
    assert.deepEqual(Object.values(kept), [1, 1, 1, 1, 1, 1, 1, 1]);
    assert.ok(await User.exists({ _id: other._id }));

    // The old token no longer maps to an account
    assert.equal((await req('GET', '/api/v1/auth/me', owner)).status, 401);
  });

  it('prints the owner\'s address in sent emails, and nothing when unset', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const sendTo = async (user, label) => {
      const contact = await Contact.create({ userId: user._id, name: 'Recipient', email: `${prefix}-r-${label}@example.com` });
      const campaign = await Campaign.create({
        userId: user._id,
        name: `Footer ${label}`,
        subject: 'Hello',
        textContent: 'Body text',
        htmlContent: '<p>Body</p>',
        status: 'draft',
        recipientIds: [contact._id],
      });
      const res = await req('POST', `/api/v1/campaigns/${campaign._id}/send`, user, { confirm: true });
      assert.equal(res.status, 202);
      await waitForCampaignDispatch(campaign._id);
    };

    await User.updateOne({ _id: owner._id }, { $set: { mailingAddress: '42 Footer Lane\nSpringfield' } });
    await sendTo(owner, 'with');
    const withAddress = transport.lastSentEmail;
    assert.match(withAddress.html, /42 Footer Lane<br>Springfield/);
    assert.match(withAddress.text, /42 Footer Lane\nSpringfield/);

    transport.clear();
    await sendTo(other, 'without');
    assert.ok(!transport.lastSentEmail.html.includes('mailpulse-address-footer'));
  });

  it('blocks sending without an address when the policy requires one', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    process.env.REQUIRE_MAILING_ADDRESS = 'true';
    const contact = await Contact.create({ userId: owner._id, name: 'Recipient', email: `${prefix}-r-gate@example.com` });
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Gate',
      subject: 'Hello',
      textContent: 'Body',
      status: 'draft',
      recipientIds: [contact._id],
    });
    const blocked = await req('POST', `/api/v1/campaigns/${campaign._id}/send`, owner, { confirm: true });
    assert.equal(blocked.status, 403);
    assert.match((await blocked.json()).message, /mailing address/i);

    await User.updateOne({ _id: owner._id }, { $set: { mailingAddress: '1 Main St' } });
    const ok = await req('POST', `/api/v1/campaigns/${campaign._id}/send`, owner, { confirm: true });
    assert.equal(ok.status, 202);
    await waitForCampaignDispatch(campaign._id);
  });
});
