import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  assertFreshTimestamp,
  getWebhookConfig,
  verifySendgrid,
  verifyMailgun,
  verifySns,
  buildSnsStringToSign,
  DEFAULT_WEBHOOK_MAX_AGE_SECONDS,
} from '../src/services/webhookProviders.service.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.status;
  }
  return null;
};

describe('assertFreshTimestamp', () => {
  const config = { maxAgeMs: DAY };

  it('accepts recent, boundary and slightly-future timestamps', () => {
    assert.equal(code(() => assertFreshTimestamp(NOW, config, NOW)), null);
    assert.equal(code(() => assertFreshTimestamp(NOW - DAY, config, NOW)), null); // exactly at the limit
    assert.equal(code(() => assertFreshTimestamp(NOW + 4 * 60 * 1000, config, NOW)), null); // clock skew
  });

  it('rejects stale, far-future and non-numeric timestamps with 401', () => {
    assert.equal(code(() => assertFreshTimestamp(NOW - DAY - 1, config, NOW)), 401);
    assert.equal(code(() => assertFreshTimestamp(NOW + 6 * 60 * 1000, config, NOW)), 401);
    assert.equal(code(() => assertFreshTimestamp(NaN, config, NOW)), 401);
    assert.equal(code(() => assertFreshTimestamp(Number('abc') * 1000, config, NOW)), 401);
  });

  it('is configurable with WEBHOOK_MAX_AGE_SECONDS (minimum 60, default one day)', () => {
    assert.equal(DEFAULT_WEBHOOK_MAX_AGE_SECONDS, 86400);
    assert.equal(getWebhookConfig({}).maxAgeMs, DAY);
    assert.equal(getWebhookConfig({ WEBHOOK_MAX_AGE_SECONDS: '3600' }).maxAgeMs, 3600 * 1000);
    assert.equal(getWebhookConfig({ WEBHOOK_MAX_AGE_SECONDS: '5' }).maxAgeMs, DAY);
    assert.equal(getWebhookConfig({ WEBHOOK_MAX_AGE_SECONDS: 'x' }).maxAgeMs, DAY);
  });
});

describe('Freshness is enforced by every provider', () => {
  it('SendGrid: a valid signature over an old timestamp is rejected', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const config = { maxAgeMs: DAY, sendgridPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
    const body = Buffer.from('[{"event":"bounce"}]');
    const headersAt = (seconds) => ({
      'x-twilio-email-event-webhook-timestamp': String(seconds),
      'x-twilio-email-event-webhook-signature': crypto
        .sign('sha256', Buffer.concat([Buffer.from(String(seconds)), body]), privateKey)
        .toString('base64'),
    });
    const sec = Math.floor(NOW / 1000);
    assert.equal(code(() => verifySendgrid(body, headersAt(sec), config, { now: NOW })), null);
    assert.equal(code(() => verifySendgrid(body, headersAt(sec - 2 * 86400), config, { now: NOW })), 401);
  });

  it('Mailgun: a valid HMAC over an old timestamp is rejected', () => {
    const config = { maxAgeMs: DAY, mailgunSigningKey: 'mg-secret' };
    const payloadAt = (seconds) => ({
      signature: {
        timestamp: String(seconds),
        token: 'tok',
        signature: crypto.createHmac('sha256', 'mg-secret').update(`${seconds}tok`).digest('hex'),
      },
    });
    const sec = Math.floor(NOW / 1000);
    assert.equal(code(() => verifyMailgun(payloadAt(sec), config, { now: NOW })), null);
    assert.equal(code(() => verifyMailgun(payloadAt(1000000000), config, { now: NOW })), 401); // the 2001 replay
  });

  it('SES/SNS: a valid signature over an old Timestamp is rejected', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const TOPIC = 'arn:aws:sns:us-east-1:123456789012:ses-events';
    const config = { maxAgeMs: DAY, sesTopicArns: [TOPIC] };
    const make = (iso) => {
      const message = {
        Type: 'Notification',
        MessageId: 'm1',
        TopicArn: TOPIC,
        Message: '{}',
        Timestamp: iso,
        SignatureVersion: '2',
        SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
      };
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(buildSnsStringToSign(message), 'utf8');
      message.Signature = signer.sign(privateKey, 'base64');
      return message;
    };
    const deps = { getCertificate: async () => pem, now: NOW };
    await verifySns(make(new Date(NOW - 1000).toISOString()), config, deps);
    await assert.rejects(() => verifySns(make('2026-11-01T00:00:00.000Z'), config, deps), { status: 401 });
    await assert.rejects(() => verifySns(make('not a date'), config, deps), { status: 401 });
  });
});
