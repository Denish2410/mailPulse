import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  WebhookError,
  DELIVERY_TAG,
  getWebhookConfig,
  isProviderEnabled,
  getDeliveryTagHeaders,
  verifySendgrid,
  parseSendgrid,
  verifyMailgun,
  parseMailgun,
  isTrustedSnsUrl,
  buildSnsStringToSign,
  verifySns,
  parseSes,
  confirmSnsSubscription,
} from '../src/services/webhookProviders.service.js';

const DELIVERY_ID = 'a'.repeat(24);

const rejects = async (fn, status) => {
  await assert.rejects(
    async () => fn(),
    (err) => err instanceof WebhookError && err.status === status
  );
};

describe('Webhook config and tagging', () => {
  it('reads config and enables only configured providers', () => {
    const config = getWebhookConfig({
      SENDGRID_WEBHOOK_PUBLIC_KEY: ' key ',
      SES_SNS_TOPIC_ARNS: 'arn:a, arn:b ,',
    });
    assert.deepEqual(config, { sendgridPublicKey: 'key', mailgunSigningKey: null, sesTopicArns: ['arn:a', 'arn:b'] });
    assert.equal(isProviderEnabled('sendgrid', config), true);
    assert.equal(isProviderEnabled('mailgun', config), false);
    assert.equal(isProviderEnabled('ses', config), true);
    assert.equal(isProviderEnabled('other', config), false);
  });

  it('only tags outgoing mail for configured providers', () => {
    assert.deepEqual(getDeliveryTagHeaders(DELIVERY_ID, getWebhookConfig({})), {});
    const headers = getDeliveryTagHeaders(
      DELIVERY_ID,
      getWebhookConfig({ SENDGRID_WEBHOOK_PUBLIC_KEY: 'k', MAILGUN_WEBHOOK_SIGNING_KEY: 'm', SES_SNS_TOPIC_ARNS: 'arn' })
    );
    assert.deepEqual(JSON.parse(headers['X-SMTPAPI']), { unique_args: { [DELIVERY_TAG]: DELIVERY_ID } });
    assert.deepEqual(JSON.parse(headers['X-Mailgun-Variables']), { [DELIVERY_TAG]: DELIVERY_ID });
    assert.equal(headers['X-SES-MESSAGE-TAGS'], `${DELIVERY_TAG}=${DELIVERY_ID}`);
  });
});

describe('SendGrid', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { sendgridPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), mailgunSigningKey: null, sesTopicArns: [] };
  const sign = (timestamp, body) =>
    crypto.sign('sha256', Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('base64');

  it('accepts a valid signature and rejects tampering, missing headers and disabled provider', async () => {
    const body = Buffer.from(JSON.stringify([{ email: 'a@b.co', event: 'bounce' }]));
    const headers = {
      'x-twilio-email-event-webhook-timestamp': '1700000000',
      'x-twilio-email-event-webhook-signature': sign('1700000000', body),
    };
    assert.doesNotThrow(() => verifySendgrid(body, headers, config));
    await rejects(() => verifySendgrid(Buffer.from('[]'), headers, config), 401);
    await rejects(() => verifySendgrid(body, { ...headers, 'x-twilio-email-event-webhook-timestamp': '1' }, config), 401);
    await rejects(() => verifySendgrid(body, {}, config), 401);
    await rejects(() => verifySendgrid(body, headers, { ...config, sendgridPublicKey: null }), 404);
    await rejects(() => verifySendgrid(body, headers, { ...config, sendgridPublicKey: 'not-a-key' }), 503);
  });

  it('maps events and extracts our delivery tag', () => {
    const events = parseSendgrid(
      Buffer.from(
        JSON.stringify([
          { email: 'Hard@Example.com', event: 'bounce', status: '5.1.1', reason: '550 no such user', sg_event_id: 'e1', sg_message_id: 'abc.filter0', timestamp: 1700000000, [DELIVERY_TAG]: DELIVERY_ID },
          { email: 'soft@example.com', event: 'bounce', status: '4.2.2', sg_event_id: 'e2' },
          { email: 'blocked@example.com', event: 'blocked', sg_event_id: 'e3' },
          { email: 'spam@example.com', event: 'spamreport', sg_event_id: 'e4' },
          { email: 'ok@example.com', event: 'delivered', sg_event_id: 'e5' },
          { event: 'bounce' },
          'junk',
        ])
      )
    );
    assert.deepEqual(events.map((e) => e.eventType), ['hard_bounce', 'soft_bounce', 'soft_bounce', 'complaint']);
    assert.equal(events[0].email, 'hard@example.com');
    assert.equal(events[0].deliveryId, DELIVERY_ID);
    assert.equal(events[0].messageId, 'abc');
    assert.equal(events[0].providerEventId, 'e1');
    assert.equal(events[0].reason, '550 no such user');
    assert.equal(events[0].occurredAt.toISOString(), '2023-11-14T22:13:20.000Z');
  });

  it('rejects malformed payloads', async () => {
    await rejects(() => parseSendgrid(Buffer.from('not json')), 400);
    await rejects(() => parseSendgrid(Buffer.from('{}')), 400);
  });
});

describe('Mailgun', () => {
  const config = { sendgridPublicKey: null, mailgunSigningKey: 'mg-secret', sesTopicArns: [] };
  const signed = (extra = {}) => {
    const timestamp = '1700000000';
    const token = 'tok123';
    return {
      signature: {
        timestamp,
        token,
        signature: crypto.createHmac('sha256', 'mg-secret').update(`${timestamp}${token}`).digest('hex'),
      },
      ...extra,
    };
  };

  it('verifies the HMAC signature', async () => {
    assert.doesNotThrow(() => verifyMailgun(signed(), config));
    const bad = signed();
    bad.signature.signature = bad.signature.signature.replace(/.$/, bad.signature.signature.endsWith('0') ? '1' : '0');
    await rejects(() => verifyMailgun(bad, config), 401);
    await rejects(() => verifyMailgun({}, config), 401);
    await rejects(() => verifyMailgun(signed(), { ...config, mailgunSigningKey: null }), 404);
    await rejects(() => verifyMailgun(signed(), { ...config, mailgunSigningKey: 'other' }), 401);
  });

  it('maps failed/complained events', () => {
    const base = (data) => ({ 'event-data': { id: 'm1', timestamp: 1700000000.5, recipient: 'User@Example.com', ...data } });
    const hard = parseMailgun(
      base({
        event: 'failed',
        severity: 'permanent',
        'delivery-status': { description: 'Mailbox does not exist' },
        'user-variables': { [DELIVERY_TAG]: DELIVERY_ID },
        message: { headers: { 'message-id': '<abc@mg.example.com>' } },
      })
    )[0];
    assert.equal(hard.eventType, 'hard_bounce');
    assert.equal(hard.email, 'user@example.com');
    assert.equal(hard.deliveryId, DELIVERY_ID);
    assert.equal(hard.messageId, 'abc@mg.example.com');
    assert.equal(hard.reason, 'Mailbox does not exist');

    assert.equal(parseMailgun(base({ event: 'failed', severity: 'temporary' }))[0].eventType, 'soft_bounce');
    assert.equal(parseMailgun(base({ event: 'complained' }))[0].eventType, 'complaint');
    assert.deepEqual(parseMailgun(base({ event: 'delivered' })), []);
    assert.deepEqual(parseMailgun({}), []);
  });
});

describe('Amazon SES via SNS', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const TOPIC = 'arn:aws:sns:us-east-1:123456789012:ses-events';
  const config = { sendgridPublicKey: null, mailgunSigningKey: null, sesTopicArns: [TOPIC] };
  const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem';

  const makeMessage = (overrides = {}, algorithm = 'RSA-SHA256', version = '2') => {
    const message = {
      Type: 'Notification',
      MessageId: 'sns-1',
      TopicArn: TOPIC,
      Message: JSON.stringify({ notificationType: 'Bounce' }),
      Timestamp: '2026-11-06T10:00:00.000Z',
      SignatureVersion: version,
      SigningCertURL: CERT_URL,
      ...overrides,
    };
    const signer = crypto.createSign(algorithm);
    signer.update(buildSnsStringToSign(message), 'utf8');
    message.Signature = signer.sign(privateKey, 'base64');
    return message;
  };
  const deps = { getCertificate: async () => pem };

  it('validates SNS certificate URLs', () => {
    assert.equal(isTrustedSnsUrl(CERT_URL), true);
    for (const bad of [
      'http://sns.us-east-1.amazonaws.com/x.pem',
      'https://sns.us-east-1.amazonaws.com.evil.com/x.pem',
      'https://evil.com/sns.us-east-1.amazonaws.com/x.pem',
      'https://user:pw@sns.us-east-1.amazonaws.com/x.pem',
      'https://amazonaws.com/x.pem',
      'not a url',
      undefined,
    ]) {
      assert.equal(isTrustedSnsUrl(bad), false, String(bad));
    }
  });

  it('verifies v2 (SHA256) and v1 (SHA1) signatures', async () => {
    await verifySns(makeMessage(), config, deps);
    await verifySns(makeMessage({}, 'RSA-SHA1', '1'), config, deps);
  });

  it('rejects tampering, bad topics, bad cert URLs and disabled provider', async () => {
    const good = makeMessage();
    await rejects(() => verifySns({ ...good, Message: '{"x":1}' }, config, deps), 401);
    await rejects(() => verifySns(makeMessage({ TopicArn: 'arn:other' }), config, deps), 403);
    await rejects(() => verifySns(makeMessage({ SigningCertURL: 'https://evil.com/c.pem' }), config, deps), 401);
    await rejects(() => verifySns(makeMessage({ SigningCertURL: 'https://sns.us-east-1.amazonaws.com/c.txt' }), config, deps), 401);
    await rejects(() => verifySns(makeMessage({}, 'RSA-SHA256', '3'), config, deps), 401);
    await rejects(() => verifySns({ ...good, Signature: undefined }, config, deps), 401);
    await rejects(() => verifySns(good, { ...config, sesTopicArns: [] }, deps), 404);
    await rejects(() => verifySns(good, config, { getCertificate: async () => { throw new Error('network'); } }), 401);

    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await rejects(
      () => verifySns(good, config, { getCertificate: async () => other.publicKey.export({ type: 'spki', format: 'pem' }) }),
      401
    );
  });

  it('includes Subject in the signed string only when present', () => {
    assert.ok(buildSnsStringToSign({ Type: 'Notification', Message: 'm', MessageId: 'i', Subject: 's', Timestamp: 't', TopicArn: 'a' }).includes('Subject\ns\n'));
    assert.ok(!buildSnsStringToSign({ Type: 'Notification', Message: 'm', MessageId: 'i', Timestamp: 't', TopicArn: 'a' }).includes('Subject'));
    assert.throws(() => buildSnsStringToSign({ Type: 'Weird' }), WebhookError);
  });

  it('parses bounce and complaint notifications with our tag', () => {
    const tags = { [DELIVERY_TAG]: [DELIVERY_ID] };
    const bounce = parseSes({
      Message: JSON.stringify({
        notificationType: 'Bounce',
        mail: { messageId: 'ses-1', tags },
        bounce: {
          bounceType: 'Permanent',
          feedbackId: 'fb1',
          timestamp: '2026-11-06T10:00:00.000Z',
          bouncedRecipients: [{ emailAddress: 'Gone@Example.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }],
        },
      }),
    });
    assert.equal(bounce.length, 1);
    assert.equal(bounce[0].eventType, 'hard_bounce');
    assert.equal(bounce[0].email, 'gone@example.com');
    assert.equal(bounce[0].deliveryId, DELIVERY_ID);
    assert.equal(bounce[0].messageId, 'ses-1');
    assert.equal(bounce[0].providerEventId, 'fb1:gone@example.com');

    const transient = parseSes({
      Message: JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId: 'ses-2' },
        bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@example.com' }] },
      }),
    });
    assert.equal(transient[0].eventType, 'soft_bounce');

    const complaint = parseSes({
      Message: JSON.stringify({
        notificationType: 'Complaint',
        mail: { messageId: 'ses-3' },
        complaint: { feedbackId: 'fb3', complainedRecipients: [{ emailAddress: 'a@b.co' }, { emailAddress: 'c@d.co' }] },
      }),
    });
    assert.deepEqual(complaint.map((e) => e.eventType), ['complaint', 'complaint']);
    assert.deepEqual(parseSes({ Message: 'not json' }), []);
    assert.deepEqual(parseSes({ Message: JSON.stringify({ notificationType: 'Delivery' }) }), []);
  });

  it('confirms subscriptions only on trusted URLs', async () => {
    const calls = [];
    const fetchUrl = async (url) => {
      calls.push(url);
      return { ok: true };
    };
    await confirmSnsSubscription({ SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription' }, { fetchUrl });
    assert.equal(calls.length, 1);
    await rejects(() => confirmSnsSubscription({ SubscribeURL: 'https://evil.com/?x' }, { fetchUrl }), 400);
    await rejects(
      () => confirmSnsSubscription({ SubscribeURL: 'https://sns.us-east-1.amazonaws.com/x' }, { fetchUrl: async () => ({ ok: false }) }),
      502
    );
    assert.equal(calls.length, 1);
  });
});
