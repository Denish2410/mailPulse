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
for (const key of ['SENDGRID_WEBHOOK_PUBLIC_KEY', 'MAILGUN_WEBHOOK_SIGNING_KEY', 'SES_SNS_TOPIC_ARNS']) {
  delete process.env[key];
}

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import Suppression from '../src/models/Suppression.js';
import BounceEvent from '../src/models/BounceEvent.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import { waitForCampaignDispatch } from '../src/services/campaignDispatch.service.js';
import { buildSnsStringToSign, DELIVERY_TAG } from '../src/services/webhookProviders.service.js';

describe('ESP webhook endpoints', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `whk-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let owner;
  let token;
  let alice;
  let delivery;

  const sg = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sns = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const TOPIC = 'arn:aws:sns:us-east-1:123456789012:ses-events';
  const CERT_URL = 'https://sns.us-east-1.amazonaws.com/cert.pem';

  const post = (urlPath, body, headers = {}) =>
    fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const sendgridRequest = (events, { tamper = false } = {}) => {
    const body = JSON.stringify(events);
    const ts = '1700000000';
    const sig = crypto.sign('sha256', Buffer.from(ts + body), sg.privateKey).toString('base64');
    return post('/api/v1/webhooks/sendgrid', tamper ? body.replace('bounce', 'bounse') : body, {
      'X-Twilio-Email-Event-Webhook-Timestamp': ts,
      'X-Twilio-Email-Event-Webhook-Signature': sig,
    });
  };

  const mailgunBody = (data, secret = 'mg-secret') => ({
    signature: {
      timestamp: '1700000000',
      token: 'tok',
      signature: crypto.createHmac('sha256', secret).update('1700000000tok').digest('hex'),
    },
    'event-data': { id: `mg-${prefix}-${Math.random()}`, timestamp: 1700000000, recipient: alice.email, ...data },
  });

  const snsMessage = (type, extra = {}) => {
    const message = {
      Type: type,
      MessageId: `sns-${Math.random()}`,
      TopicArn: TOPIC,
      Timestamp: '2026-11-06T10:00:00.000Z',
      SignatureVersion: '2',
      SigningCertURL: CERT_URL,
      Message: '{}',
      ...extra,
    };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(buildSnsStringToSign(message), 'utf8');
    message.Signature = signer.sign(sns.privateKey, 'base64');
    return message;
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Webhook API Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      await BounceEvent.init();
      owner = await User.create({
        name: 'Hook Owner',
        email: `${prefix}-o@example.com`,
        passwordHash: await hashPassword('StrongPassword123!'),
      });
      token = signAccessToken(owner);
      alice = await Contact.create({ userId: owner._id, name: 'Alice', email: `${prefix}-alice@example.com` });
    }
  });

  beforeEach(async () => {
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = sg.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = 'mg-secret';
    process.env.SES_SNS_TOPIC_ARNS = TOPIC;
    app.locals.webhookDeps = {
      getCertificate: async () => sns.publicKey.export({ type: 'spki', format: 'pem' }),
      fetchUrl: async () => ({ ok: true }),
    };
    if (isDbConnected) {
      await BounceEvent.deleteMany({ userId: owner._id });
      await Suppression.deleteMany({ userId: owner._id });
      await Delivery.deleteMany({ userId: owner._id });
      await Campaign.deleteMany({ userId: owner._id });
      const campaign = await Campaign.create({ userId: owner._id, name: 'Hook Campaign', subject: 'S', status: 'sent' });
      delivery = await Delivery.create({
        campaignId: campaign._id,
        userId: owner._id,
        contactId: alice._id,
        email: alice.email,
        status: 'sent',
      });
    }
  });

  after(async () => {
    for (const key of ['SENDGRID_WEBHOOK_PUBLIC_KEY', 'MAILGUN_WEBHOOK_SIGNING_KEY', 'SES_SNS_TOPIC_ARNS']) {
      delete process.env[key];
    }
    delete app.locals.webhookDeps;
    delete app.locals.emailService;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await BounceEvent.deleteMany({ userId: owner._id });
      await Suppression.deleteMany({ userId: owner._id });
      await Delivery.deleteMany({ userId: owner._id });
      await Campaign.deleteMany({ userId: owner._id });
      await Contact.deleteMany({ userId: owner._id });
      await User.deleteMany({ _id: owner._id });
      await mongoose.disconnect();
    }
  });

  it('fails closed (404) for providers that are not configured', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (const key of ['SENDGRID_WEBHOOK_PUBLIC_KEY', 'MAILGUN_WEBHOOK_SIGNING_KEY', 'SES_SNS_TOPIC_ARNS']) {
      delete process.env[key];
    }
    assert.equal((await sendgridRequest([])).status, 404);
    assert.equal((await post('/api/v1/webhooks/mailgun', mailgunBody({}))).status, 404);
    assert.equal((await post('/api/v1/webhooks/ses', snsMessage('Notification'))).status, 404);
  });

  it('SendGrid: rejects bad signatures and applies a signed hard bounce', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const events = [{ email: alice.email, event: 'bounce', status: '5.1.1', reason: 'no such user', sg_event_id: `sg-${prefix}`, [DELIVERY_TAG]: String(delivery._id) }];

    assert.equal((await sendgridRequest(events, { tamper: true })).status, 401);
    assert.equal((await post('/api/v1/webhooks/sendgrid', JSON.stringify(events))).status, 401);
    assert.equal(await Suppression.countDocuments({ userId: owner._id }), 0);

    const res = await sendgridRequest(events);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.suppressed, 1);
    const sup = await Suppression.findOne({ userId: owner._id }).lean();
    assert.equal(sup.email, alice.email);
    assert.equal(sup.source, 'bounce');

    // Retry is idempotent
    const retry = await (await sendgridRequest(events)).json();
    assert.equal(retry.data.duplicates, 1);
  });

  it('Mailgun: verifies the HMAC and records a complaint', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const data = { event: 'complained', 'user-variables': { [DELIVERY_TAG]: String(delivery._id) } };
    assert.equal((await post('/api/v1/webhooks/mailgun', mailgunBody(data, 'wrong-secret'))).status, 401);
    assert.equal((await post('/api/v1/webhooks/mailgun', 'not json')).status, 400);

    const res = await post('/api/v1/webhooks/mailgun', mailgunBody(data));
    assert.equal(res.status, 200);
    assert.equal((await Suppression.findOne({ userId: owner._id }).lean()).source, 'complaint');
    assert.equal((await Contact.findById(alice._id).lean()).isUnsubscribed, true);
    await Contact.updateOne({ _id: alice._id }, { $set: { isUnsubscribed: false } });
  });

  it('SES: verifies SNS, confirms subscriptions and processes notifications', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const sub = snsMessage('SubscriptionConfirmation', {
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'tok',
    });
    const subRes = await post('/api/v1/webhooks/ses', sub);
    assert.equal(subRes.status, 200);
    assert.equal((await subRes.json()).data.subscription, 'confirmed');

    const notification = snsMessage('Notification', {
      Message: JSON.stringify({
        notificationType: 'Bounce',
        mail: { messageId: 'ses-1', tags: { [DELIVERY_TAG]: [String(delivery._id)] } },
        bounce: { bounceType: 'Permanent', feedbackId: `fb-${prefix}`, bouncedRecipients: [{ emailAddress: alice.email }] },
      }),
    });
    assert.equal((await post('/api/v1/webhooks/ses', { ...notification, Message: '{}' })).status, 401);
    assert.equal((await post('/api/v1/webhooks/ses', snsMessage('Notification', { TopicArn: 'arn:other' }))).status, 403);

    const res = await post('/api/v1/webhooks/ses', notification);
    assert.equal(res.status, 200);
    assert.equal((await Suppression.findOne({ userId: owner._id }).lean()).source, 'bounce');
  });

  it('rejects empty bodies and does not leak payload details', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await fetch(`${baseUrl}/api/v1/webhooks/sendgrid`, { method: 'POST' });
    assert.equal(res.status, 400);
    const bad = await post('/api/v1/webhooks/mailgun', mailgunBody({ event: 'failed', severity: 'permanent' }, 'wrong'));
    const text = JSON.stringify(await bad.json());
    assert.ok(!text.includes(alice.email));
  });

  it('tags outgoing mail with the delivery id for configured providers', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const transport = createMockTransport();
    app.locals.emailService = createEmailService({ transport, from: 'MailPulse Test <no-reply@mailpulse.test>' });
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Tagged',
      subject: 'S',
      textContent: 'Body',
      recipientIds: [alice._id],
    });
    const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(res.status, 202);
    await waitForCampaignDispatch(campaign._id);

    const sent = await Delivery.findOne({ campaignId: campaign._id }).lean();
    const headers = transport.sentEmails[0].headers;
    assert.deepEqual(JSON.parse(headers['X-SMTPAPI']), { unique_args: { [DELIVERY_TAG]: String(sent._id) } });
    assert.equal(headers['X-SES-MESSAGE-TAGS'], `${DELIVERY_TAG}=${sent._id}`);
    assert.equal(JSON.parse(headers['X-Mailgun-Variables'])[DELIVERY_TAG], String(sent._id));
    assert.ok(headers['List-Unsubscribe']);

    delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
    delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    delete process.env.SES_SNS_TOPIC_ARNS;
    await Delivery.deleteMany({ campaignId: campaign._id });
    await Contact.updateOne({ _id: alice._id }, { $set: { isUnsubscribed: false } });
    await Suppression.deleteMany({ userId: owner._id });
    const campaign2 = await Campaign.create({ userId: owner._id, name: 'Untagged', subject: 'S', textContent: 'Body', recipientIds: [alice._id] });
    transport.clear();
    await fetch(`${baseUrl}/api/v1/campaigns/${campaign2._id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirm: true }),
    });
    await waitForCampaignDispatch(campaign2._id);
    const untagged = transport.sentEmails[0].headers;
    assert.equal(untagged['X-SMTPAPI'], undefined);
    assert.equal(untagged['X-SES-MESSAGE-TAGS'], undefined);
  });
});
