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
process.env.CAMPAIGN_SEND_RATE_LIMIT_MAX = '1000';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { describe, it, before, after, beforeEach } from 'node:test';
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

describe('Campaign personalization (dispatch and test email)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `pers-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let user;
  let token;
  let named;
  let unnamed;
  let evil;
  let transport;

  const request = (method, urlPath, body) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Personalization Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    if (isDbConnected) {
      user = await User.create({
        name: 'Owner Person',
        email: `${prefix}-owner@example.com`,
        passwordHash: await hashPassword('StrongPassword123!'),
      });
      token = signAccessToken(user);
      named = await Contact.create({ userId: user._id, name: 'Ada Lovelace', email: `${prefix}-ada@example.com` });
      unnamed = await Contact.create({ userId: user._id, name: 'xx', email: `${prefix}-nameless@example.com` });
      evil = await Contact.create({
        userId: user._id,
        name: '<img src=x onerror=alert(1)>',
        email: `${prefix}-evil@example.com`,
      });
      await Contact.updateOne({ _id: unnamed._id }, { $set: { name: '' } });
    }
  });

  beforeEach(async () => {
    transport = createMockTransport();
    app.locals.emailService = createEmailService({
      transport,
      from: 'MailPulse Test <no-reply@mailpulse.test>',
    });
    if (isDbConnected) {
      await Delivery.deleteMany({ userId: user._id });
      await Campaign.deleteMany({ userId: user._id });
    }
  });

  after(async () => {
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Delivery.deleteMany({ userId: user._id });
      await Campaign.deleteMany({ userId: user._id });
      await Contact.deleteMany({ userId: user._id });
      await User.deleteMany({ _id: user._id });
      await mongoose.disconnect();
    }
  });

  it('personalizes subject, text and html per recipient on dispatch', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const campaign = await Campaign.create({
      userId: user._id,
      name: 'Personalized',
      subject: 'Hello {{firstName | "friend"}}',
      textContent: 'Hi {{name | "Customer"}} ({{email}})',
      htmlContent: '<p>Hi {{name | "Customer"}}</p>',
      recipientIds: [named._id, unnamed._id, evil._id],
    });

    const res = await request('POST', `/api/v1/campaigns/${campaign._id}/send`, { confirm: true });
    assert.equal(res.status, 202);
    await waitForCampaignDispatch(campaign._id);

    const byTo = Object.fromEntries(transport.sentEmails.map((m) => [m.to, m]));
    const ada = byTo[named.email];
    assert.equal(ada.subject, 'Hello Ada');
    assert.equal(ada.text.split('\n')[0], `Hi Ada Lovelace (${named.email})`);
    assert.ok(ada.html.includes('<p>Hi Ada Lovelace</p>'));
    assert.ok(!/\{\{\s*(name|firstName|email)/i.test(ada.html));

    const anon = byTo[unnamed.email];
    assert.equal(anon.subject, 'Hello friend');
    assert.ok(anon.html.includes('<p>Hi Customer</p>'));

    const bad = byTo[evil.email];
    assert.ok(!bad.html.includes('<img src=x'));
    assert.ok(bad.html.includes('&lt;img'));
  });

  it('keeps the unsubscribe tag intact for later injection', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const campaign = await Campaign.create({
      userId: user._id,
      name: 'Unsub Tag',
      subject: 'Hi',
      textContent: 'Bye {{unsubscribeUrl}}',
      htmlContent: '<a href="{{unsubscribeUrl}}">Unsubscribe</a> {{name}}',
      recipientIds: [named._id],
    });
    await request('POST', `/api/v1/campaigns/${campaign._id}/send`, { confirm: true });
    await waitForCampaignDispatch(campaign._id);

    const mail = transport.sentEmails[0];
    assert.ok(!mail.html.includes('{{unsubscribeUrl}}'));
    assert.ok(mail.html.includes('/api/v1/tracking/unsubscribe/'));
  });

  it('renders merge tags in test emails using the account holder details', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const campaign = await Campaign.create({
      userId: user._id,
      name: 'Test Tags',
      subject: 'Hey {{firstName}}',
      textContent: 'Body for {{name}}',
      htmlContent: '<p>{{email}}</p>',
      recipientIds: [],
    });
    const res = await request('POST', `/api/v1/campaigns/${campaign._id}/test-email`, {});
    assert.equal(res.status, 200);
    const mail = transport.sentEmails[0];
    assert.ok(mail.subject.includes('Hey Owner'));
    assert.ok(mail.text.includes('Body for Owner Person'));
    assert.ok(mail.html.includes(user.email));
    assert.equal(transport.count, 1);
  });

  it('renders custom fields per recipient and falls back when missing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Contact.updateOne({ _id: named._id }, { $set: { customFields: { company: 'Acme & Sons' } } });
    const campaign = await Campaign.create({
      userId: user._id,
      name: 'Custom Fields',
      subject: 'News for {{custom.company | "your team"}}',
      textContent: 'Company: {{custom.company | "n/a"}}',
      htmlContent: '<p>{{custom.company | "n/a"}}</p>',
      recipientIds: [named._id, unnamed._id],
    });

    const res = await request('POST', `/api/v1/campaigns/${campaign._id}/send`, { confirm: true });
    assert.equal(res.status, 202);
    await waitForCampaignDispatch(campaign._id);

    const byTo = Object.fromEntries(transport.sentEmails.map((m) => [m.to, m]));
    assert.equal(byTo[named.email].subject, 'News for Acme & Sons');
    assert.ok(byTo[named.email].html.includes('<p>Acme &amp; Sons</p>'));
    assert.equal(byTo[unnamed.email].subject, 'News for your team');
    assert.ok(byTo[unnamed.email].text.startsWith('Company: n/a'));
    await Contact.updateOne({ _id: named._id }, { $unset: { customFields: '' } });
  });
});
