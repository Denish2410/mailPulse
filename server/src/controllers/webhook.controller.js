import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  WebhookError,
  getWebhookConfig,
  verifySendgrid,
  parseSendgrid,
  verifyMailgun,
  parseMailgun,
  verifySns,
  parseSes,
  confirmSnsSubscription,
} from '../services/webhookProviders.service.js';
import { processBounceEvents } from '../services/bounceProcessing.service.js';

/**
 * Inbound ESP webhooks (Phase 12). Routes are mounted with a raw body parser so signatures are
 * verified against the exact bytes the provider sent.
 *
 * Responses never echo payload content. Authentication failures are 401/403, a provider that is
 * not configured answers 404, and processing (database) failures are 500 so the provider retries.
 */

const rawBodyOf = (req) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new WebhookError('Request body is required.', 400);
  }
  return req.body;
};

const parseJsonBody = (rawBody) => {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookError('Malformed JSON payload.', 400);
  }
};

const respond = (res, summary) =>
  res.status(200).json({ success: true, message: 'Webhook processed', data: summary });

/** Converts provider errors into safe HTTP errors. */
const guard = (handler) =>
  asyncHandler(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof WebhookError) {
        throw new AppError(err.message, err.status, null, { expose: true });
      }
      throw err;
    }
  });

export const handleSendgridWebhook = guard(async (req, res) => {
  const config = getWebhookConfig();
  const rawBody = rawBodyOf(req);
  verifySendgrid(rawBody, req.headers, config);
  const events = parseSendgrid(rawBody);
  respond(res, await processBounceEvents('sendgrid', events));
});

export const handleMailgunWebhook = guard(async (req, res) => {
  const config = getWebhookConfig();
  const payload = parseJsonBody(rawBodyOf(req));
  verifyMailgun(payload, config);
  const events = parseMailgun(payload);
  respond(res, await processBounceEvents('mailgun', events));
});

export const handleSesWebhook = guard(async (req, res) => {
  const config = getWebhookConfig();
  const message = parseJsonBody(rawBodyOf(req));
  const deps = req.app?.locals?.webhookDeps || {};

  await verifySns(message, config, deps);

  if (message.Type === 'SubscriptionConfirmation') {
    await confirmSnsSubscription(message, deps);
    return respond(res, { subscription: 'confirmed' });
  }
  if (message.Type === 'Notification') {
    const events = parseSes(message);
    return respond(res, await processBounceEvents('ses', events));
  }
  // UnsubscribeConfirmation and anything else: acknowledge without action
  return respond(res, { ignored: true });
});
