import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { GOOGLE_ENDPOINTS } from '../config/googleOAuth.js';
import { SEND_OUTCOMES } from './email.service.js';

/**
 * Gmail API transport: sends one message as one customer-owned Gmail account.
 *
 * Nodemailer-compatible (`sendMail(mailOptions)`), so it can stand in for the SMTP transport.
 * It is NOT wired into campaign dispatch yet.
 *
 * - The message is composed with Nodemailer's MIME composer and posted to
 *   users.messages.send with Node's fetch and a timeout. No SDK.
 * - From is always the connected account's own address (a display name is allowed). Only To,
 *   Subject, text, HTML and safe extra headers are taken from the caller; Cc, Bcc, From,
 *   Sender, To and similar headers cannot be smuggled in.
 * - Every failure is a GmailSendError with `outcome` (= `sendOutcome`):
 *     'rejected'  Gmail provably did not accept the message (nothing was sent, or Gmail answered
 *                 with a definite refusal: 400, 401, 403, 404, 413, 429), so it is safe to
 *                 record as not sent;
 *     'uncertain' it may have been accepted (timeout or connection lost after the request could
 *                 have reached Gmail, any 5xx, any unrecognised answer). Callers must NEVER retry
 *                 an uncertain send automatically (Stage 4A rule).
 * - Errors never contain the access token, the message or Google's free-text error message;
 *   only Google's short reason keyword is kept.
 */

export const GMAIL_SEND_TIMEOUT_MS = 30000;
/** Raw (base64url) message size accepted on the simple JSON endpoint; kept well under Gmail's limits. */
export const GMAIL_MAX_RAW_BYTES = 5 * 1024 * 1024;

/** Socket/DNS/TLS failures that happen before any byte of the request can reach Gmail. */
const PRE_CONNECT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

/** Headers the caller may never set: identity and recipients come only from the transport. */
const FORBIDDEN_HEADERS = new Set([
  'from', 'sender', 'to', 'cc', 'bcc', 'subject', 'reply-to', 'return-path', 'message-id',
  'date', 'mime-version', 'content-type', 'content-transfer-encoding', 'received', 'dkim-signature',
]);

export class GmailSendError extends Error {
  /**
   * @param {string} code
   * @param {'rejected'|'uncertain'} outcome
   * @param {string} message fixed, safe text
   * @param {object} [details]
   */
  constructor(code, outcome, message, { status = null, reason = null, retryable = false, reauthRequired = false, authFailure = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'GmailSendError';
    this.code = code;
    this.outcome = outcome;
    this.sendOutcome = outcome;
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
    this.reauthRequired = reauthRequired;
    this.authFailure = authFailure;
    this.retryAfterMs = retryAfterMs;
  }
}

const rejected = (code, message, details) => new GmailSendError(code, SEND_OUTCOMES.REJECTED, message, details);
const uncertain = (code, message, details) => new GmailSendError(code, SEND_OUTCOMES.UNCERTAIN, message, details);

const errorCodeOf = (error) => {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (typeof current.code === 'string') return current.code;
  }
  return null;
};

/** Classifies an exception thrown by fetch (no HTTP answer received). */
export const classifyGmailFetchFailure = (error) => {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return uncertain('GMAIL_TIMEOUT', 'Gmail did not answer in time; the message may have been sent.');
  }
  const code = errorCodeOf(error);
  if (code && PRE_CONNECT_CODES.has(code)) {
    return rejected('GMAIL_UNREACHABLE', 'Could not connect to Gmail; the message was not sent.', { retryable: true });
  }
  return uncertain('GMAIL_CONNECTION_LOST', 'The connection to Gmail failed; the message may have been sent.');
};

const reasonOf = (body) => {
  const candidates = [body?.error?.errors?.[0]?.reason, body?.error?.details?.[0]?.reason, body?.error?.status];
  const found = candidates.find((r) => typeof r === 'string' && /^[A-Za-z_]{1,64}$/.test(r));
  return found ?? null;
};

const retryAfterMsOf = (response) => {
  const value = response.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 86400) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 86400_000)) : null;
};

/** Classifies a non-2xx Gmail answer. */
export const classifyGmailResponse = (status, body, { retryAfterMs = null } = {}) => {
  const reason = reasonOf(body);
  const details = { status, reason };
  if (status === 429 || (status === 403 && RATE_LIMIT_REASONS.has(reason))) {
    return rejected('GMAIL_RATE_LIMITED', 'Gmail is limiting sending for this account; the message was not sent.', {
      ...details,
      retryable: true,
      retryAfterMs,
    });
  }
  if (status === 401) {
    return rejected('GMAIL_UNAUTHORIZED', 'Gmail did not accept the access token; the message was not sent.', {
      ...details,
      retryable: true,
      authFailure: true,
    });
  }
  if (status === 403) {
    const reauthRequired = SCOPE_REASONS.has(reason);
    return rejected('GMAIL_FORBIDDEN', 'Gmail refused to send from this account; the message was not sent.', {
      ...details,
      reauthRequired,
    });
  }
  if (status === 400 || status === 404 || status === 413) {
    return rejected('GMAIL_INVALID_REQUEST', 'Gmail rejected the message; it was not sent.', details);
  }
  return uncertain('GMAIL_UNCERTAIN_RESPONSE', 'Gmail answered with an error; the message may have been sent.', details);
};

const assertSafeHeaders = (headers) => {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9-]{1,76}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw rejected('GMAIL_INVALID_MESSAGE', 'The message has a header that is not allowed; it was not sent.');
    }
    if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 2000) {
      throw rejected('GMAIL_INVALID_MESSAGE', 'The message has an invalid header value; it was not sent.');
    }
    out[name] = value;
  }
  return out;
};

const singleRecipient = (to) => {
  if (typeof to !== 'string' || !to || /[\r\n,;<>]/.test(to) || to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw rejected('GMAIL_INVALID_MESSAGE', 'The message needs exactly one valid recipient; it was not sent.');
  }
  return to;
};

const displayNameOf = (from) => {
  if (from && typeof from === 'object' && typeof from.name === 'string') return from.name;
  if (typeof from === 'string') {
    const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
    if (match) return match[1];
  }
  return '';
};

/**
 * Builds the RFC 5322 message. From is the account address; the display name comes from the
 * caller's `from` (if any) or the account.
 *
 * @returns {Promise<{ raw: string, messageId: string }>}
 */
export const composeGmailMessage = async (account, mailOptions) => {
  const to = singleRecipient(mailOptions?.to);
  const headers = assertSafeHeaders(mailOptions?.headers);
  const name = (displayNameOf(mailOptions?.from) || account.displayName || '').replace(/[\r\n"]/g, '').slice(0, 200);
  const composer = new MailComposer({
    from: name ? { name, address: account.email } : account.email,
    to,
    subject: typeof mailOptions.subject === 'string' ? mailOptions.subject : '',
    text: mailOptions.text || undefined,
    html: mailOptions.html || undefined,
    headers,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const mail = composer.compile();
  mail.keepBcc = false;
  const buffer = await new Promise((resolve, reject) => mail.build((error, message) => (error ? reject(error) : resolve(message))));
  return { raw: buffer.toString('base64url'), messageId: mail.messageId() };
};

/**
 * @param {object} options
 * @param {{ id: string, email: string, displayName?: string }} options.account the sender account (owner already checked)
 * @param {() => Promise<string>} options.getAccessToken resolves the account's access token
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {number} [options.timeoutMs=GMAIL_SEND_TIMEOUT_MS]
 */
export const createGmailTransport = ({ account, getAccessToken, fetchImpl = globalThis.fetch, timeoutMs = GMAIL_SEND_TIMEOUT_MS }) => {
  if (!account?.email || typeof getAccessToken !== 'function') {
    throw new TypeError('createGmailTransport requires an account and getAccessToken.');
  }
  return {
    name: 'gmail-api',
    senderAccountId: String(account.id ?? ''),
    senderEmail: account.email,

    async sendMail(mailOptions = {}) {
      // 1. Everything before the request: any failure here means nothing was sent
      let composed;
      try {
        composed = await composeGmailMessage(account, mailOptions);
      } catch (error) {
        if (error instanceof GmailSendError) throw error;
        throw rejected('GMAIL_INVALID_MESSAGE', 'The message could not be built; it was not sent.');
      }
      if (Buffer.byteLength(composed.raw) > GMAIL_MAX_RAW_BYTES) {
        throw rejected('GMAIL_MESSAGE_TOO_LARGE', 'The message is too large for Gmail; it was not sent.');
      }
      let accessToken;
      try {
        accessToken = await getAccessToken();
      } catch (error) {
        throw rejected('GMAIL_SENDER_UNAVAILABLE', 'The sender account is not available; the message was not sent.', {
          retryable: error?.retryable === true,
          reauthRequired: error?.reauthRequired === true,
          reason: typeof error?.code === 'string' ? error.code : null,
        });
      }
      if (typeof accessToken !== 'string' || !accessToken) {
        throw rejected('GMAIL_SENDER_UNAVAILABLE', 'The sender account is not available; the message was not sent.');
      }

      // 2. The request: from here on, failures may mean it was sent
      let response;
      try {
        response = await fetchImpl(GOOGLE_ENDPOINTS.gmailSend, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ raw: composed.raw }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw classifyGmailFetchFailure(error);
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (response.status >= 200 && response.status < 300) {
        // Accepted. A malformed success body does not change that.
        return {
          messageId: composed.messageId,
          providerMessageId: typeof body?.id === 'string' ? body.id : null,
          threadId: typeof body?.threadId === 'string' ? body.threadId : null,
          accepted: [mailOptions.to],
          rejected: [],
          response: `Gmail API ${response.status}`,
        };
      }
      throw classifyGmailResponse(response.status, body, { retryAfterMs: retryAfterMsOf(response) });
    },
  };
};

export default {
  GMAIL_SEND_TIMEOUT_MS,
  GMAIL_MAX_RAW_BYTES,
  GmailSendError,
  classifyGmailFetchFailure,
  classifyGmailResponse,
  composeGmailMessage,
  createGmailTransport,
};
