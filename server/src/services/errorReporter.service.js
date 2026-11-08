import crypto from 'node:crypto';

/**
 * Error reporting: every reported error is written as one structured JSON line to stderr (easy to
 * ship to any log aggregator), and, when ERROR_WEBHOOK_URL is set, posted to that webhook
 * (Slack incoming webhooks and Discord webhooks both accept this payload) so someone gets told.
 *
 * Safety:
 * - Only the error name, message, a short stack, HTTP method, route path (no query string),
 *   status and a request id are reported. Never bodies, headers, tokens or credentials.
 * - The same error is posted at most once per DEDUPE_WINDOW_MS, and at most MAX_PER_HOUR posts are
 *   made per hour, so an error loop cannot flood the channel (or the process).
 * - Reporting never throws and never blocks a request: webhook failures are swallowed.
 */

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 3000;
const MAX_MESSAGE_LENGTH = 300;
const MAX_STACK_LINES = 6;

const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Route path without query string, so tokens in URLs are never reported. */
const safePath = (value) => truncate(String(value ?? '').split('?')[0], 200);

/**
 * Builds the sanitized event for an error.
 *
 * @param {unknown} error
 * @param {{ method?: string, path?: string, status?: number, requestId?: string, source?: string }} [context]
 */
export const buildErrorEvent = (error, context = {}) => {
  const err = error instanceof Error ? error : new Error(truncate(error, MAX_MESSAGE_LENGTH));
  const stack = typeof err.stack === 'string' ? err.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n') : '';
  return {
    time: new Date().toISOString(),
    level: 'error',
    source: context.source || 'request',
    name: truncate(err.name || 'Error', 80),
    message: truncate(err.message, MAX_MESSAGE_LENGTH),
    stack,
    ...(context.method && { method: truncate(context.method, 10) }),
    ...(context.path && { path: safePath(context.path) }),
    ...(context.status && { status: context.status }),
    ...(context.requestId && { requestId: truncate(context.requestId, 80) }),
  };
};

const fingerprint = (event) =>
  crypto
    .createHash('sha1')
    .update(`${event.source}|${event.name}|${event.message}|${event.stack.split('\n')[1] || ''}`)
    .digest('hex');

/**
 * @param {object} [options]
 * @param {string} [options.webhookUrl] - Where to post (https only)
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {{ error: Function }} [options.logger]
 */
export const createErrorReporter = ({
  webhookUrl = '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger = console,
} = {}) => {
  const url = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
  const webhookEnabled = /^https:\/\//i.test(url) && typeof fetchImpl === 'function';
  const lastSent = new Map();
  let hourStart = now();
  let sentThisHour = 0;

  const shouldPost = (event) => {
    const t = now();
    if (t - hourStart >= HOUR_MS) {
      hourStart = t;
      sentThisHour = 0;
    }
    if (sentThisHour >= MAX_PER_HOUR) return false;
    const key = fingerprint(event);
    const previous = lastSent.get(key);
    if (previous !== undefined && t - previous < DEDUPE_WINDOW_MS) return false;
    // Keep the map small: drop entries older than the window
    for (const [k, v] of lastSent) {
      if (t - v >= DEDUPE_WINDOW_MS) lastSent.delete(k);
    }
    lastSent.set(key, t);
    sentThisHour += 1;
    return true;
  };

  /**
   * Logs the error and (if enabled and not a duplicate) posts it to the webhook.
   * Resolves when the post settles; callers on the request path should not await it.
   */
  const reportError = async (error, context = {}) => {
    try {
      const event = buildErrorEvent(error, context);
      logger.error(JSON.stringify(event));

      if (!webhookEnabled || !shouldPost(event)) return false;

      const where = event.path ? ` ${event.method || ''} ${event.path}` : '';
      const text = `MailPulse ${event.source} error${where}: ${event.name}: ${event.message}`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `text` is read by Slack, `content` by Discord
        body: JSON.stringify({ text, content: truncate(text, 1900) }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      return Boolean(response?.ok);
    } catch {
      return false; // reporting must never break the app
    }
  };

  return { reportError, isWebhookEnabled: () => webhookEnabled };
};

let sharedReporter = null;

/** Process-wide reporter configured from ERROR_WEBHOOK_URL. */
export const getErrorReporter = () => {
  if (!sharedReporter) {
    sharedReporter = createErrorReporter({ webhookUrl: process.env.ERROR_WEBHOOK_URL });
  }
  return sharedReporter;
};

/** Test helper: forget the shared reporter so the next call re-reads the environment. */
export const resetErrorReporter = () => {
  sharedReporter = null;
};
