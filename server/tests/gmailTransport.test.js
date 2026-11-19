/**
 * Gmail API transport: MIME composition, request shape and send-outcome classification.
 * No network: Gmail is a fake fetch. Nothing is ever sent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GOOGLE_ENDPOINTS } from '../src/config/googleOAuth.js';
import { SEND_OUTCOMES } from '../src/services/email.service.js';
import {
  GmailSendError,
  GMAIL_MAX_RAW_BYTES,
  classifyGmailFetchFailure,
  classifyGmailResponse,
  createGmailTransport,
} from '../src/services/gmailTransport.service.js';

const ACCESS_TOKEN = 'ya29.test-only-access-token-value';
const ACCOUNT = { id: '64b000000000000000000001', email: 'owner.mailbox@example.com', displayName: 'Owner Mailbox' };
const MESSAGE = {
  to: 'recipient@example.org',
  from: 'Spring Sale <someone-else@example.net>',
  subject: 'Hello from the test',
  text: 'Plain body SECRET-BODY-MARKER',
  html: '<p>HTML body SECRET-BODY-MARKER</p>',
  headers: { 'List-Unsubscribe': '<https://app.example.test/u/abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
};

/** Fake Gmail: `answer` is { status, json } | Error | (init) => that. Records requests. */
const fakeGmail = (answer = { status: 200, json: { id: '18c0ffee', threadId: '18c0ffee', labelIds: ['SENT'] } }) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const a = typeof answer === 'function' ? await answer(init) : answer;
    if (a instanceof Error) throw a;
    const headers = { 'Content-Type': 'application/json', ...(a.headers ?? {}) };
    return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status, headers });
  };
  return { fetchImpl, calls };
};

const transportWith = (gmail, { getAccessToken = async () => ACCESS_TOKEN, ...rest } = {}) => {
  let tokenCalls = 0;
  const transport = createGmailTransport({
    account: ACCOUNT,
    getAccessToken: async () => {
      tokenCalls += 1;
      return getAccessToken();
    },
    fetchImpl: gmail.fetchImpl,
    ...rest,
  });
  return { transport, tokenCalls: () => tokenCalls };
};

const decodeRaw = (raw) => Buffer.from(raw, 'base64url').toString('utf8');

const assertSafeError = (error) => {
  const text = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const secret of [ACCESS_TOKEN, 'SECRET-BODY-MARKER', 'Google free text']) {
    assert.ok(!text.includes(secret), 'error must not contain the token, the message or Google text');
  }
};

const rejectsWith = async (promise, { code, outcome, ...props }) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof GmailSendError, `expected GmailSendError, got ${error?.name}`);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.equal(error.sendOutcome, outcome);
    for (const [key, value] of Object.entries(props)) assert.deepEqual(error[key], value, key);
    assertSafeError(error);
    return true;
  });

describe('Gmail transport: request and message', () => {
  it('posts one MIME message from the account address to users.messages.send', async () => {
    const gmail = fakeGmail();
    const { transport } = transportWith(gmail);
    const result = await transport.sendMail(MESSAGE);

    assert.equal(gmail.calls.length, 1);
    const [call] = gmail.calls;
    assert.equal(call.url, GOOGLE_ENDPOINTS.gmailSend);
    assert.equal(call.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal, 'request has a timeout');
    assert.deepEqual(Object.keys(call.body), ['raw']);
    assert.match(call.body.raw, /^[A-Za-z0-9_-]+$/, 'base64url');

    const mime = decodeRaw(call.body.raw);
    assert.match(mime, /^From: Spring Sale <owner\.mailbox@example\.com>$/m, 'display name kept, address forced to the account');
    assert.ok(!mime.includes('someone-else@example.net'));
    assert.match(mime, /^To: recipient@example\.org$/m);
    assert.match(mime, /^Subject: Hello from the test$/m);
    assert.match(mime, /^List-Unsubscribe: <https:\/\/app\.example\.test\/u\/abc>$/m);
    assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    assert.match(mime, /^Message-ID: <.+>$/m);
    assert.ok(!/^(Bcc|Cc):/im.test(mime));
    assert.match(mime, /multipart\/alternative/);

    assert.equal(result.providerMessageId, '18c0ffee');
    assert.equal(result.threadId, '18c0ffee');
    assert.match(result.messageId, /^<.+>$/);
    assert.ok(mime.includes(`Message-ID: ${result.messageId}`));
    assert.deepEqual(result.accepted, ['recipient@example.org']);
  });

  it('uses the account display name when the caller gives none', async () => {
    const gmail = fakeGmail();
    await transportWith(gmail).transport.sendMail({ ...MESSAGE, from: undefined });
    assert.match(decodeRaw(gmail.calls[0].body.raw), /^From: Owner Mailbox <owner\.mailbox@example\.com>$/m);
  });

  it('refuses identity and recipient headers, extra recipients and oversized messages before anything is sent', async () => {
    const bad = [
      { ...MESSAGE, headers: { Bcc: 'hidden@example.org' } },
      { ...MESSAGE, headers: { cc: 'copy@example.org' } },
      { ...MESSAGE, headers: { From: 'evil@example.org' } },
      { ...MESSAGE, headers: { 'Reply-To': 'x@example.org' } },
      { ...MESSAGE, headers: { 'X-Ok': 'line\r\nBcc: injected@example.org' } },
      { ...MESSAGE, headers: { 'Bad Name': 'x' } },
      { ...MESSAGE, to: 'a@example.org, b@example.org' },
      { ...MESSAGE, to: 'a@example.org\r\nBcc: b@example.org' },
      { ...MESSAGE, to: 'Name <a@example.org>' },
      { ...MESSAGE, to: '' },
    ];
    for (const message of bad) {
      const gmail = fakeGmail();
      const { transport, tokenCalls } = transportWith(gmail);
      await rejectsWith(transport.sendMail(message), { code: 'GMAIL_INVALID_MESSAGE', outcome: SEND_OUTCOMES.REJECTED });
      assert.equal(gmail.calls.length, 0);
      assert.equal(tokenCalls(), 0, 'no token is even fetched for an invalid message');
    }
    const gmail = fakeGmail();
    const big = { ...MESSAGE, html: `<p>${'x'.repeat(GMAIL_MAX_RAW_BYTES)}</p>` };
    await rejectsWith(transportWith(gmail).transport.sendMail(big), { code: 'GMAIL_MESSAGE_TOO_LARGE', outcome: SEND_OUTCOMES.REJECTED });
    assert.equal(gmail.calls.length, 0);
  });

  it('an unavailable sender account means not sent, with the reason passed on', async () => {
    const gmail = fakeGmail();
    const reauth = Object.assign(new Error('Google no longer accepts this sender account.'), {
      code: 'SENDER_REAUTH_REQUIRED',
      reauthRequired: true,
      retryable: false,
    });
    const { transport } = transportWith(gmail, { getAccessToken: async () => Promise.reject(reauth) });
    await rejectsWith(transport.sendMail(MESSAGE), {
      code: 'GMAIL_SENDER_UNAVAILABLE',
      outcome: SEND_OUTCOMES.REJECTED,
      reauthRequired: true,
      retryable: false,
      reason: 'SENDER_REAUTH_REQUIRED',
    });
    const transient = Object.assign(new Error('x'), { code: 'SENDER_TOKEN_REFRESH_FAILED', retryable: true });
    await rejectsWith(transportWith(gmail, { getAccessToken: async () => Promise.reject(transient) }).transport.sendMail(MESSAGE), {
      code: 'GMAIL_SENDER_UNAVAILABLE',
      outcome: SEND_OUTCOMES.REJECTED,
      retryable: true,
    });
    await rejectsWith(transportWith(gmail, { getAccessToken: async () => '' }).transport.sendMail(MESSAGE), {
      code: 'GMAIL_SENDER_UNAVAILABLE',
      outcome: SEND_OUTCOMES.REJECTED,
    });
    assert.equal(gmail.calls.length, 0);
  });

  it('requires an account and a token provider', () => {
    assert.throws(() => createGmailTransport({ account: {}, getAccessToken: async () => 'x' }), TypeError);
    assert.throws(() => createGmailTransport({ account: ACCOUNT }), TypeError);
  });
});

describe('Gmail transport: send outcomes', () => {
  const googleError = (code, reason, status) => ({
    error: { code, message: 'Google free text that must not leak', status, errors: [{ reason, domain: 'global', message: 'Google free text' }] },
  });

  it('a 2xx answer is a send, even with an unreadable body', async () => {
    const gmail = fakeGmail({ status: 200, text: 'not json' });
    const result = await transportWith(gmail).transport.sendMail(MESSAGE);
    assert.equal(result.providerMessageId, null);
    assert.match(result.messageId, /^<.+>$/);
  });

  it('definite refusals are rejected (safe to record as not sent)', async () => {
    const cases = [
      [400, googleError(400, 'invalidArgument', 'INVALID_ARGUMENT'), { code: 'GMAIL_INVALID_REQUEST' }],
      [401, googleError(401, 'authError', 'UNAUTHENTICATED'), { code: 'GMAIL_UNAUTHORIZED', authFailure: true, retryable: true }],
      [403, googleError(403, 'userRateLimitExceeded', 'PERMISSION_DENIED'), { code: 'GMAIL_RATE_LIMITED', retryable: true }],
      [403, googleError(403, 'dailyLimitExceeded', 'PERMISSION_DENIED'), { code: 'GMAIL_RATE_LIMITED', retryable: true }],
      [403, googleError(403, 'insufficientPermissions', 'PERMISSION_DENIED'), { code: 'GMAIL_FORBIDDEN', reauthRequired: true }],
      [403, googleError(403, 'domainPolicy', 'PERMISSION_DENIED'), { code: 'GMAIL_FORBIDDEN', reauthRequired: false }],
      [404, googleError(404, 'notFound', 'NOT_FOUND'), { code: 'GMAIL_INVALID_REQUEST' }],
      [413, {}, { code: 'GMAIL_INVALID_REQUEST' }],
      [429, googleError(429, 'rateLimitExceeded', 'RESOURCE_EXHAUSTED'), { code: 'GMAIL_RATE_LIMITED', retryable: true }],
    ];
    for (const [status, json, expected] of cases) {
      const gmail = fakeGmail({ status, json });
      await rejectsWith(transportWith(gmail).transport.sendMail(MESSAGE), { ...expected, outcome: SEND_OUTCOMES.REJECTED, status });
    }
    const limited = fakeGmail({ status: 429, json: {}, headers: { 'Retry-After': '30' } });
    await rejectsWith(transportWith(limited).transport.sendMail(MESSAGE), {
      code: 'GMAIL_RATE_LIMITED',
      outcome: SEND_OUTCOMES.REJECTED,
      retryAfterMs: 30000,
    });
  });

  it('server errors and unrecognised answers are uncertain (never retried automatically)', async () => {
    for (const status of [500, 502, 503, 504, 408, 409, 418, 302]) {
      const gmail = fakeGmail({ status, json: googleError(status, 'backendError', 'INTERNAL') });
      await rejectsWith(transportWith(gmail).transport.sendMail(MESSAGE), {
        code: 'GMAIL_UNCERTAIN_RESPONSE',
        outcome: SEND_OUTCOMES.UNCERTAIN,
        status,
      });
    }
  });

  it('connection failures before the request could reach Gmail are rejected; anything later is uncertain', async () => {
    const withCause = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
    const cases = [
      [withCause('ECONNREFUSED'), 'GMAIL_UNREACHABLE', SEND_OUTCOMES.REJECTED],
      [withCause('ENOTFOUND'), 'GMAIL_UNREACHABLE', SEND_OUTCOMES.REJECTED],
      [withCause('UND_ERR_CONNECT_TIMEOUT'), 'GMAIL_UNREACHABLE', SEND_OUTCOMES.REJECTED],
      [withCause('CERT_HAS_EXPIRED'), 'GMAIL_UNREACHABLE', SEND_OUTCOMES.REJECTED],
      [withCause('ECONNRESET'), 'GMAIL_CONNECTION_LOST', SEND_OUTCOMES.UNCERTAIN],
      [withCause('UND_ERR_SOCKET'), 'GMAIL_CONNECTION_LOST', SEND_OUTCOMES.UNCERTAIN],
      [new TypeError('fetch failed'), 'GMAIL_CONNECTION_LOST', SEND_OUTCOMES.UNCERTAIN],
      [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'GMAIL_TIMEOUT', SEND_OUTCOMES.UNCERTAIN],
      [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'GMAIL_TIMEOUT', SEND_OUTCOMES.UNCERTAIN],
      [new Error('something unexpected'), 'GMAIL_CONNECTION_LOST', SEND_OUTCOMES.UNCERTAIN],
    ];
    for (const [error, code, outcome] of cases) {
      await rejectsWith(transportWith(fakeGmail(error)).transport.sendMail(MESSAGE), { code, outcome });
    }
  });

  it('a real timeout is uncertain', async () => {
    const gmail = fakeGmail(
      (init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    // AbortSignal.timeout uses an unref'd timer: keep the event loop alive while waiting for it,
    // as the API and the worker do in production
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      await rejectsWith(transportWith(gmail, { timeoutMs: 50 }).transport.sendMail(MESSAGE), {
        code: 'GMAIL_TIMEOUT',
        outcome: SEND_OUTCOMES.UNCERTAIN,
      });
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('classifiers default to uncertain for anything unknown', () => {
    assert.equal(classifyGmailFetchFailure(undefined).outcome, SEND_OUTCOMES.UNCERTAIN);
    assert.equal(classifyGmailFetchFailure({}).outcome, SEND_OUTCOMES.UNCERTAIN);
    assert.equal(classifyGmailResponse(599, null).outcome, SEND_OUTCOMES.UNCERTAIN);
    assert.equal(classifyGmailResponse(403, null).code, 'GMAIL_FORBIDDEN');
    assert.equal(classifyGmailResponse(400, { error: { errors: [{ reason: 'has spaces <script>' }] } }).reason, null);
  });
});
