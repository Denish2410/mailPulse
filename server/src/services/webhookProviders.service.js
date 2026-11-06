import crypto from 'node:crypto';

/**
 * MailPulse ESP Webhook Providers (Phase 12)
 *
 * Authenticates and parses inbound bounce / complaint webhooks from SendGrid, Mailgun and
 * Amazon SES (via SNS) into one normalized event shape:
 *
 *   { providerEventId, deliveryId, messageId, email, eventType, reason, occurredAt }
 *
 * where `eventType` is 'hard_bounce' | 'soft_bounce' | 'complaint'.
 *
 * Security (these endpoints are public, so every request is authenticated before parsing):
 * - SendGrid: ECDSA P-256 signature over `timestamp + rawBody` with the configured public key.
 * - Mailgun: HMAC-SHA256 of `timestamp + token` with the configured signing key.
 * - SES/SNS: RSA signature over the canonical SNS string-to-sign. The signing certificate URL must
 *   be https on an `sns.<region>.amazonaws.com` host, and the TopicArn must be allow-listed.
 * - A provider with no configured secret is disabled and rejects everything (fail closed).
 * - Comparisons use constant-time functions. Raw payloads are never stored or logged.
 *
 * Correlation: outgoing mail is tagged with our Delivery ID (see `getDeliveryTagHeaders`) using
 * each provider's custom-arguments header, which providers echo back in their webhooks.
 */

export const DELIVERY_TAG = 'mailpulse_delivery_id';

export class WebhookError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WebhookError';
    this.status = status;
  }
}

/**
 * Reads webhook configuration from the environment.
 *
 * @param {object} [env=process.env]
 * @returns {{ sendgridPublicKey: string|null, mailgunSigningKey: string|null, sesTopicArns: string[] }}
 */
export const getWebhookConfig = (env = process.env) => ({
  sendgridPublicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY?.trim() || null,
  mailgunSigningKey: env.MAILGUN_WEBHOOK_SIGNING_KEY?.trim() || null,
  sesTopicArns: (env.SES_SNS_TOPIC_ARNS || '')
    .split(',')
    .map((arn) => arn.trim())
    .filter(Boolean),
});

export const isProviderEnabled = (provider, config) => {
  if (provider === 'sendgrid') return Boolean(config.sendgridPublicKey);
  if (provider === 'mailgun') return Boolean(config.mailgunSigningKey);
  if (provider === 'ses') return config.sesTopicArns.length > 0;
  return false;
};

/**
 * Headers that make each configured provider echo our Delivery ID back in its webhooks.
 *
 * @param {string|import('mongoose').Types.ObjectId} deliveryId
 * @param {object} [config]
 * @returns {Record<string, string>}
 */
export const getDeliveryTagHeaders = (deliveryId, config = getWebhookConfig()) => {
  const id = String(deliveryId);
  const headers = {};
  if (config.sendgridPublicKey) {
    headers['X-SMTPAPI'] = JSON.stringify({ unique_args: { [DELIVERY_TAG]: id } });
  }
  if (config.mailgunSigningKey) {
    headers['X-Mailgun-Variables'] = JSON.stringify({ [DELIVERY_TAG]: id });
  }
  if (config.sesTopicArns.length > 0) {
    headers['X-SES-MESSAGE-TAGS'] = `${DELIVERY_TAG}=${id}`;
  }
  return headers;
};

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const cleanReason = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
  return text || null;
};

const toDate = (value) => {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const parseJson = (rawBody) => {
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    throw new WebhookError('Malformed JSON payload.', 400);
  }
};

const header = (headers, name) => {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

// ---------------------------------------------------------------------------
// SendGrid
// ---------------------------------------------------------------------------

const sendgridKey = (config) => {
  try {
    return crypto.createPublicKey({
      key: Buffer.from(config.sendgridPublicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new WebhookError('Webhook provider is misconfigured.', 503);
  }
};

export const verifySendgrid = (rawBody, headers, config) => {
  if (!config.sendgridPublicKey) throw new WebhookError('Webhook provider is not enabled.', 404);
  const signature = header(headers, 'x-twilio-email-event-webhook-signature');
  const timestamp = header(headers, 'x-twilio-email-event-webhook-timestamp');
  if (!signature || !timestamp) throw new WebhookError('Missing webhook signature.', 401);

  let valid = false;
  try {
    valid = crypto.verify(
      'sha256',
      Buffer.concat([Buffer.from(String(timestamp)), Buffer.from(rawBody)]),
      sendgridKey(config),
      Buffer.from(signature, 'base64')
    );
  } catch (err) {
    if (err instanceof WebhookError) throw err;
    valid = false;
  }
  if (!valid) throw new WebhookError('Invalid webhook signature.', 401);
};

export const parseSendgrid = (rawBody) => {
  const payload = parseJson(rawBody);
  if (!Array.isArray(payload)) throw new WebhookError('Expected an array of events.', 400);

  const events = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object' || typeof item.email !== 'string') continue;
    let eventType = null;
    if (item.event === 'bounce') {
      eventType = String(item.status || '').startsWith('4') ? 'soft_bounce' : 'hard_bounce';
    } else if (item.event === 'blocked') {
      eventType = 'soft_bounce';
    } else if (item.event === 'spamreport') {
      eventType = 'complaint';
    }
    if (!eventType) continue;

    const messageId = typeof item.sg_message_id === 'string' ? item.sg_message_id.split('.')[0] : null;
    events.push({
      providerEventId: String(item.sg_event_id || `${messageId}:${item.event}:${item.email}`),
      deliveryId: typeof item[DELIVERY_TAG] === 'string' ? item[DELIVERY_TAG] : null,
      messageId,
      email: item.email.trim().toLowerCase(),
      eventType,
      reason: cleanReason(item.reason) || cleanReason(item.type) || null,
      occurredAt: toDate(item.timestamp),
    });
  }
  return events;
};

// ---------------------------------------------------------------------------
// Mailgun
// ---------------------------------------------------------------------------

export const verifyMailgun = (payload, config) => {
  if (!config.mailgunSigningKey) throw new WebhookError('Webhook provider is not enabled.', 404);
  const sig = payload?.signature;
  if (!sig || typeof sig.timestamp === 'undefined' || !sig.token || !sig.signature) {
    throw new WebhookError('Missing webhook signature.', 401);
  }
  const expected = crypto
    .createHmac('sha256', config.mailgunSigningKey)
    .update(`${sig.timestamp}${sig.token}`)
    .digest('hex');
  if (!safeEqual(expected, sig.signature)) throw new WebhookError('Invalid webhook signature.', 401);
};

export const parseMailgun = (payload) => {
  const data = payload?.['event-data'];
  if (!data || typeof data !== 'object' || typeof data.recipient !== 'string') return [];

  let eventType = null;
  if (data.event === 'failed') {
    eventType = data.severity === 'temporary' ? 'soft_bounce' : 'hard_bounce';
  } else if (data.event === 'complained') {
    eventType = 'complaint';
  }
  if (!eventType) return [];

  const status = data['delivery-status'] || {};
  const rawMessageId = data.message?.headers?.['message-id'];
  return [
    {
      providerEventId: String(data.id || `${rawMessageId}:${data.event}:${data.recipient}`),
      deliveryId:
        typeof data['user-variables']?.[DELIVERY_TAG] === 'string' ? data['user-variables'][DELIVERY_TAG] : null,
      messageId: typeof rawMessageId === 'string' ? rawMessageId.replace(/^<|>$/g, '') : null,
      email: data.recipient.trim().toLowerCase(),
      eventType,
      reason: cleanReason(status.description) || cleanReason(status.message) || cleanReason(data.reason),
      occurredAt: toDate(data.timestamp),
    },
  ];
};

// ---------------------------------------------------------------------------
// Amazon SES via SNS
// ---------------------------------------------------------------------------

const SNS_CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export const isTrustedSnsUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SNS_CERT_HOST.test(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
};

const SNS_SIGNED_FIELDS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

export const buildSnsStringToSign = (message) => {
  const fields = SNS_SIGNED_FIELDS[message.Type];
  if (!fields) throw new WebhookError('Unsupported SNS message type.', 400);
  return fields
    .filter((name) => typeof message[name] === 'string')
    .map((name) => `${name}\n${message[name]}\n`)
    .join('');
};

const defaultCertCache = new Map();

/**
 * Default certificate loader: https GET of a validated SNS URL, cached per URL.
 */
export const fetchSigningCertificate = async (url) => {
  if (defaultCertCache.has(url)) return defaultCertCache.get(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('Certificate fetch failed');
  const pem = await response.text();
  if (pem.length > 20000 || !pem.includes('BEGIN CERTIFICATE')) throw new Error('Invalid certificate');
  defaultCertCache.set(url, pem);
  return pem;
};

/**
 * Verifies an SNS message (signature, certificate URL and allow-listed topic).
 *
 * @param {object} message - Parsed SNS JSON body
 * @param {object} config
 * @param {{ getCertificate?: (url: string) => Promise<string> }} [deps]
 */
export const verifySns = async (message, config, { getCertificate = fetchSigningCertificate } = {}) => {
  if (config.sesTopicArns.length === 0) throw new WebhookError('Webhook provider is not enabled.', 404);
  if (!message || typeof message !== 'object' || typeof message.Signature !== 'string') {
    throw new WebhookError('Missing webhook signature.', 401);
  }
  if (!config.sesTopicArns.includes(message.TopicArn)) throw new WebhookError('Unknown topic.', 403);
  if (!isTrustedSnsUrl(message.SigningCertURL) || !String(message.SigningCertURL).endsWith('.pem')) {
    throw new WebhookError('Untrusted signing certificate URL.', 401);
  }
  const algorithm = message.SignatureVersion === '2' ? 'RSA-SHA256' : message.SignatureVersion === '1' ? 'RSA-SHA1' : null;
  if (!algorithm) throw new WebhookError('Unsupported signature version.', 401);

  let valid = false;
  try {
    const certificate = await getCertificate(message.SigningCertURL);
    const verifier = crypto.createVerify(algorithm);
    verifier.update(buildSnsStringToSign(message), 'utf8');
    valid = verifier.verify(certificate, message.Signature, 'base64');
  } catch (err) {
    if (err instanceof WebhookError) throw err;
    valid = false;
  }
  if (!valid) throw new WebhookError('Invalid webhook signature.', 401);
};

/**
 * Parses the inner SES notification of a verified SNS message.
 */
export const parseSes = (snsMessage) => {
  let inner;
  try {
    inner = JSON.parse(snsMessage.Message);
  } catch {
    return [];
  }
  const kind = inner?.notificationType || inner?.eventType;
  const tag = inner?.mail?.tags?.[DELIVERY_TAG];
  const deliveryId = Array.isArray(tag) ? tag[0] : typeof tag === 'string' ? tag : null;
  const messageId = typeof inner?.mail?.messageId === 'string' ? inner.mail.messageId : null;
  const events = [];

  if (kind === 'Bounce' && inner.bounce) {
    const eventType = inner.bounce.bounceType === 'Permanent' ? 'hard_bounce' : 'soft_bounce';
    for (const recipient of inner.bounce.bouncedRecipients || []) {
      if (typeof recipient?.emailAddress !== 'string') continue;
      events.push({
        providerEventId: `${inner.bounce.feedbackId || messageId}:${recipient.emailAddress.toLowerCase()}`,
        deliveryId,
        messageId,
        email: recipient.emailAddress.trim().toLowerCase(),
        eventType,
        reason: cleanReason(recipient.diagnosticCode) || cleanReason(inner.bounce.bounceSubType),
        occurredAt: toDate(inner.bounce.timestamp),
      });
    }
  } else if (kind === 'Complaint' && inner.complaint) {
    for (const recipient of inner.complaint.complainedRecipients || []) {
      if (typeof recipient?.emailAddress !== 'string') continue;
      events.push({
        providerEventId: `${inner.complaint.feedbackId || messageId}:${recipient.emailAddress.toLowerCase()}`,
        deliveryId,
        messageId,
        email: recipient.emailAddress.trim().toLowerCase(),
        eventType: 'complaint',
        reason: cleanReason(inner.complaint.complaintFeedbackType),
        occurredAt: toDate(inner.complaint.timestamp),
      });
    }
  }
  return events;
};

/**
 * Confirms an SNS subscription by visiting the (validated) SubscribeURL.
 */
export const confirmSnsSubscription = async (message, { fetchUrl = fetch } = {}) => {
  if (!isTrustedSnsUrl(message.SubscribeURL)) throw new WebhookError('Untrusted subscribe URL.', 400);
  const response = await fetchUrl(message.SubscribeURL, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new WebhookError('Subscription confirmation failed.', 502);
};
