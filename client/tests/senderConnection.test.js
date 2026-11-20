import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiClient } from '../src/lib/api.js';
import { startGoogleConnection, completeGoogleConnection } from '../src/api/senderAccounts.js';
import {
  parseOAuthCallback,
  isGoogleAuthorizationUrl,
  getConnectErrorMessage,
  getCallbackErrorMessage,
  CALLBACK_MESSAGES,
  OAUTH_CALLBACK_PATH,
  SENDER_ACCOUNTS_PATH,
} from '../src/utils/senderAccountHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf-8');
const httpError = (status, data = {}) => Object.assign(new Error(`status ${status}`), { response: { status, data } });

describe('Gmail connection: OAuth callback parsing', () => {
  it('accepts a code and a state', () => {
    assert.deepEqual(parseOAuthCallback('?state=abc123&code=4%2F0AXyz'), { kind: 'ready', code: '4/0AXyz', state: 'abc123' });
  });

  it('treats an empty query as "nothing in progress" (refresh / direct visit)', () => {
    assert.deepEqual(parseOAuthCallback(''), { kind: 'empty' });
    assert.deepEqual(parseOAuthCallback(undefined), { kind: 'empty' });
  });

  it('never forwards a Google error: access_denied is "denied", anything else is generic', () => {
    assert.deepEqual(parseOAuthCallback('?error=access_denied&state=x'), { kind: 'denied' });
    assert.deepEqual(parseOAuthCallback('?error=server_error&error_description=secret&state=x'), { kind: 'google_error' });
  });

  it('rejects a missing half, whitespace, control characters and oversize values', () => {
    assert.equal(parseOAuthCallback('?code=abc').kind, 'invalid');
    assert.equal(parseOAuthCallback('?state=abc').kind, 'invalid');
    assert.equal(parseOAuthCallback('?state=a%20b&code=c').kind, 'invalid');
    assert.equal(parseOAuthCallback('?state=a%0Ab&code=c').kind, 'invalid');
    assert.equal(parseOAuthCallback(`?state=${'a'.repeat(513)}&code=c`).kind, 'invalid');
    assert.equal(parseOAuthCallback(`?state=s&code=${'a'.repeat(2049)}`).kind, 'invalid');
  });

  it('has a user-facing message for every non-ready outcome', () => {
    for (const kind of ['denied', 'google_error', 'invalid', 'empty']) assert.ok(CALLBACK_MESSAGES[kind].length > 10);
  });
});

describe('Gmail connection: authorization URL safety', () => {
  it('only accepts https URLs on accounts.google.com', () => {
    assert.equal(isGoogleAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true);
    for (const bad of [
      'http://accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com.evil.example/auth',
      'https://evil.example/https://accounts.google.com/',
      'https://user:pw@accounts.google.com/auth',
      'javascript:alert(1)',
      '//accounts.google.com/auth',
      '',
      null,
      undefined,
      42,
    ]) {
      assert.equal(isGoogleAuthorizationUrl(bad), false, String(bad));
    }
  });
});

describe('Gmail connection: API client', () => {
  afterEach(() => mock.restoreAll());

  it('startGoogleConnection POSTs to the connect endpoint with an empty body', async () => {
    let captured;
    mock.method(apiClient, 'post', async (url, body) => {
      captured = { url, body };
      return { data: { data: { authorizationUrl: 'https://accounts.google.com/x', expiresAt: 'soon' } } };
    });
    const data = await startGoogleConnection();
    assert.equal(captured.url, '/sender-accounts/google/connect');
    assert.deepEqual(captured.body, {});
    assert.equal(data.authorizationUrl, 'https://accounts.google.com/x');
  });

  it('completeGoogleConnection sends state and code in the body only, never in the URL', async () => {
    let captured;
    mock.method(apiClient, 'post', async (url, body) => {
      captured = { url, body };
      return { status: 201, data: { data: { senderAccount: { id: 'a1', email: 'me@gmail.com' } } } };
    });
    const result = await completeGoogleConnection({ state: 'STATE-1', code: 'CODE-1' });
    assert.equal(captured.url, '/sender-accounts/google/callback');
    assert.ok(!captured.url.includes('CODE-1') && !captured.url.includes('STATE-1'));
    assert.deepEqual(captured.body, { state: 'STATE-1', code: 'CODE-1' });
    assert.equal(result.created, true);
    assert.equal(result.senderAccount.email, 'me@gmail.com');
    assert.ok(!JSON.stringify(result).includes('CODE-1'), 'the code is not returned');
  });

  it('reports a reconnect (200) as not created', async () => {
    mock.method(apiClient, 'post', async () => ({ status: 200, data: { data: { senderAccount: { id: 'a1' } } } }));
    assert.equal((await completeGoogleConnection({ state: 's', code: 'c' })).created, false);
  });
});

describe('Gmail connection: error messages', () => {
  it('explains missing server configuration (503) and rate limiting (429)', () => {
    assert.match(getConnectErrorMessage(httpError(503)), /not set up/i);
    assert.match(getConnectErrorMessage(httpError(429)), /too many/i);
    assert.match(getCallbackErrorMessage(httpError(503)), /not set up/i);
  });

  it('shows the API message for invalid or expired state, and falls back safely', () => {
    const message = 'This connection request is invalid or has expired. Please start connecting your Gmail account again.';
    assert.equal(getCallbackErrorMessage(httpError(400, { message })), message);
    assert.match(getCallbackErrorMessage(new Error('boom')), /try again/i);
    assert.match(getConnectErrorMessage(Object.assign(new Error('x'), { code: 'ERR_NETWORK' })), /reach the server/i);
  });
});

describe('Gmail connection: pages and routes', () => {
  const app = read('App.jsx');
  const protectedBlock = app.match(/<Route\s+element=\{<ProtectedRoute\s*\/>\}>([\s\S]*?)<\/Route>/)[1];
  const callbackPage = read('pages/settings/SenderAccountCallbackPage.jsx');
  const accountsPage = read('pages/settings/SenderAccountsPage.jsx');

  it('serves both pages only behind the sign-in guard, at the paths the helpers name', () => {
    assert.equal(SENDER_ACCOUNTS_PATH, '/settings/sender-accounts');
    assert.equal(OAUTH_CALLBACK_PATH, '/settings/sender-accounts/callback');
    assert.match(protectedBlock, /path="\/settings\/sender-accounts"\s+element=\{<SenderAccountsPage/);
    assert.match(protectedBlock, /path="\/settings\/sender-accounts\/callback"\s+element=\{<SenderAccountCallbackPage/);
  });

  it('the callback page scrubs the code from the address bar and posts each state only once', () => {
    assert.match(callbackPage, /history\.replaceState\(/);
    assert.match(callbackPage, /completions\s*=\s*new Map\(\)/);
    assert.doesNotMatch(callbackPage, /console\./, 'nothing is logged');
    assert.doesNotMatch(callbackPage, /localStorage|sessionStorage/, 'nothing is persisted');
  });

  it('the connect page validates the URL before redirecting and has a Connect Gmail button', () => {
    assert.match(accountsPage, /isGoogleAuthorizationUrl\(authorizationUrl\)/);
    assert.match(accountsPage, /Connect Gmail/);
    assert.doesNotMatch(accountsPage, /console\./);
  });

  it('the navbar links to the Gmail accounts page', () => {
    assert.match(read('components/layout/Navbar.jsx'), /to="\/settings\/sender-accounts"/);
  });
});
