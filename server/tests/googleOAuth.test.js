/**
 * Google OAuth configuration and client (no database, no network: Google is a fake fetch).
 * Client IDs, secrets, codes and tokens below are made-up test values.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  GOOGLE_OAUTH_SCOPES,
  GMAIL_SEND_SCOPE,
  GOOGLE_ENDPOINTS,
  GoogleOAuthConfigError,
  getGoogleOAuthConfig,
  validateGoogleOAuthConfig,
} from '../src/config/googleOAuth.js';
import {
  GoogleOAuthError,
  setGoogleHttpClient,
  resolveGoogleFetch,
  createOAuthState,
  hashOAuthState,
  createPkcePair,
  buildAuthorizationUrl,
  hasGmailSendScope,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  readIdTokenClaims,
} from '../src/services/googleOAuth.service.js';

process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');

const CLIENT_ID = '123456789-testonly.apps.googleusercontent.com';
const CLIENT_SECRET = `test-only-secret-${crypto.randomBytes(8).toString('hex')}`;
const REDIRECT = 'https://app.example.test/settings/sender-accounts/callback';
const ENV = { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI: REDIRECT };
const CONFIG = getGoogleOAuthConfig(ENV);

/** A fake fetch that records requests and answers with the given responses in order. */
const fakeGoogle = (...answers) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: Object.fromEntries(new URLSearchParams(init.body)) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    const { status = 200, json, text } = answer;
    return new Response(text ?? JSON.stringify(json ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
};

const idToken = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.c2lnbmF0dXJl`;
};
const goodClaims = (overrides = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '109876543210987654321',
  email: 'Sender.Test@Example.com',
  email_verified: true,
  name: 'Sender Test',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});

const assertNoSecrets = (error, secrets) => {
  const text = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const secret of secrets) assert.ok(!text.includes(secret), 'error must not contain secrets');
};

describe('Google OAuth configuration', () => {
  it('is off when nothing is set, and complete when all three are valid', () => {
    assert.equal(getGoogleOAuthConfig({}), null);
    assert.equal(getGoogleOAuthConfig({ GOOGLE_OAUTH_CLIENT_ID: '  ' }), null);
    assert.deepEqual(validateGoogleOAuthConfig({}), { enabled: false });
    assert.deepEqual(validateGoogleOAuthConfig(ENV), { enabled: true });
    assert.deepEqual({ ...CONFIG }, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT });
  });

  it('keeps the redirect URI exactly as configured (Google compares it literally)', () => {
    const bare = getGoogleOAuthConfig({ ...ENV, GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example.test' });
    assert.equal(bare.redirectUri, 'https://app.example.test');
    const local = getGoogleOAuthConfig({ ...ENV, GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:5173/cb' });
    assert.equal(local.redirectUri, 'http://localhost:5173/cb');
  });

  it('refuses partial or invalid settings, naming variables but never values', () => {
    const cases = [
      { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID },
      { ...ENV, GOOGLE_OAUTH_CLIENT_SECRET: '' },
      { ...ENV, GOOGLE_OAUTH_REDIRECT_URI: '' },
      { ...ENV, GOOGLE_OAUTH_CLIENT_ID: 'not-a-google-client-id' },
      { ...ENV, GOOGLE_OAUTH_CLIENT_SECRET: 'short' },
      { ...ENV, GOOGLE_OAUTH_CLIENT_SECRET: 'has a space in it' },
      { ...ENV, GOOGLE_OAUTH_REDIRECT_URI: '/relative/path' },
      { ...ENV, GOOGLE_OAUTH_REDIRECT_URI: 'http://app.example.test/cb' },
      { ...ENV, GOOGLE_OAUTH_REDIRECT_URI: 'https://user:pw@app.example.test/cb' },
      { ...ENV, GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example.test/cb#frag' },
      { ...ENV, GOOGLE_OAUTH_REDIRECT_URI: 'javascript:alert(1)' },
      { ...ENV, NODE_ENV: 'production', GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:5173/cb' },
    ];
    for (const env of cases) {
      assert.throws(
        () => validateGoogleOAuthConfig(env),
        (error) => {
          assert.ok(error instanceof GoogleOAuthConfigError);
          assert.ok(!error.message.includes(CLIENT_SECRET));
          return true;
        }
      );
    }
    assert.throws(() => getGoogleOAuthConfig({ GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID }), /GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI/);
  });

  it('the API and the worker refuse to start on a partial configuration, without printing values', () => {
    for (const script of ['src/server.js', 'src/worker.js']) {
      const result = spawnSync(process.execPath, [script], {
        cwd: SERVER_DIR,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          MONGODB_URI: 'mongodb://127.0.0.1:1/never_connected',
          JWT_SECRET: 'test_only_jwt_secret_for_startup_validation_0123456789',
          TOKEN_ENCRYPTION_KEYS: `k1:${crypto.randomBytes(32).toString('base64')}`,
          GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
          GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
        },
        encoding: 'utf8',
        timeout: 20000,
      });
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1, `${script} must exit 1 (${output})`);
      assert.match(output, /Google OAuth configuration error/);
      assert.ok(!output.includes(CLIENT_SECRET), `${script} must not print the client secret`);
    }
  });
});

describe('Google OAuth: state, PKCE and consent URL', () => {
  it('state is 256 random bits and only its hash is meant to be stored', () => {
    const states = new Set(Array.from({ length: 100 }, createOAuthState));
    assert.equal(states.size, 100);
    const state = createOAuthState();
    assert.equal(Buffer.from(state, 'base64url').length, 32);
    assert.match(hashOAuthState(state), /^[0-9a-f]{64}$/);
    assert.notEqual(hashOAuthState(state), state);
  });

  it('PKCE uses S256 with a 64-character verifier (RFC 7636)', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    assert.match(codeVerifier, /^[A-Za-z0-9_-]{64}$/);
    assert.equal(codeChallenge, crypto.createHash('sha256').update(codeVerifier).digest('base64url'));
    // RFC 7636 appendix B test vector, same formula
    assert.equal(
      crypto.createHash('sha256').update('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').digest('base64url'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
    assert.notEqual(createPkcePair().codeVerifier, codeVerifier);
  });

  it('consent URL asks for the minimum scopes, offline access, PKCE and the exact redirect URI', () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, { state: 'st', codeChallenge: 'ch' }));
    assert.equal(`${url.origin}${url.pathname}`, GOOGLE_ENDPOINTS.authorization);
    const p = url.searchParams;
    assert.equal(p.get('client_id'), CLIENT_ID);
    assert.equal(p.get('redirect_uri'), REDIRECT);
    assert.equal(p.get('response_type'), 'code');
    assert.deepEqual(p.get('scope').split(' '), [...GOOGLE_OAUTH_SCOPES]);
    assert.deepEqual(p.get('scope').split(' '), ['openid', 'email', GMAIL_SEND_SCOPE]);
    assert.equal(p.get('state'), 'st');
    assert.equal(p.get('code_challenge'), 'ch');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.equal(p.get('access_type'), 'offline');
    assert.equal(p.get('prompt'), 'consent');
    assert.equal(p.get('include_granted_scopes'), 'false');
    assert.ok(!url.toString().includes(CLIENT_SECRET), 'the secret never goes to the browser');
    assert.throws(() => buildAuthorizationUrl(CONFIG, { state: 'st' }), TypeError);
  });

  it('recognises the gmail.send scope', () => {
    assert.equal(hasGmailSendScope(['openid', 'email', GMAIL_SEND_SCOPE]), true);
    assert.equal(hasGmailSendScope(['openid', 'email']), false);
    assert.equal(hasGmailSendScope(undefined), false);
  });
});

describe('Google OAuth: token endpoint', () => {
  afterEach(() => setGoogleHttpClient(null));

  it('never reaches the network in tests unless a fake client is injected', async () => {
    assert.throws(() => resolveGoogleFetch({ NODE_ENV: 'test' }), (e) => e.code === 'GOOGLE_HTTP_DISABLED');
    await assert.rejects(
      exchangeAuthorizationCode(CONFIG, { code: 'c', codeVerifier: 'v' }),
      (e) => e instanceof GoogleOAuthError && e.code === 'GOOGLE_HTTP_DISABLED'
    );
    const fake = fakeGoogle({ json: { access_token: 'ya29.x', expires_in: 3599, token_type: 'Bearer' } });
    setGoogleHttpClient(fake.fetchImpl);
    assert.equal(resolveGoogleFetch({ NODE_ENV: 'test' }), fake.fetchImpl);
    assert.throws(() => setGoogleHttpClient('not a function'), TypeError);
  });

  it('exchanges a code with the PKCE verifier and client credentials in the POST body', async () => {
    const code = `4/test-only-code-${crypto.randomBytes(6).toString('hex')}`;
    const fake = fakeGoogle({
      json: {
        access_token: 'ya29.test-access',
        expires_in: 3599,
        refresh_token: '1//test-refresh',
        scope: `openid ${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
        token_type: 'Bearer',
        id_token: idToken(goodClaims()),
      },
    });
    const tokens = await exchangeAuthorizationCode(CONFIG, { code, codeVerifier: 'verifier-123' }, { fetchImpl: fake.fetchImpl });
    assert.equal(tokens.accessToken, 'ya29.test-access');
    assert.equal(tokens.refreshToken, '1//test-refresh');
    assert.equal(tokens.expiresIn, 3599);
    assert.ok(tokens.scopes.includes(GMAIL_SEND_SCOPE));
    assert.ok(tokens.idToken);

    const [call] = fake.calls;
    assert.equal(call.url, GOOGLE_ENDPOINTS.token);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal, 'request has a timeout');
    assert.deepEqual(call.body, {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
      code_verifier: 'verifier-123',
    });
    assert.ok(!call.url.includes(code) && !call.url.includes(CLIENT_SECRET), 'secrets never in the URL');
  });

  it('maps Google failures to codes without leaking the request or response', async () => {
    const code = '4/test-only-code-secret';
    const cases = [
      [{ status: 400, json: { error: 'invalid_grant', error_description: `Bad code ${code}` } }, 'GOOGLE_INVALID_GRANT', false],
      [{ status: 401, json: { error: 'invalid_client' } }, 'GOOGLE_INVALID_CLIENT', false],
      [{ status: 400, json: { error: 'invalid_request' } }, 'GOOGLE_REQUEST_REJECTED', false],
      [{ status: 429, json: {} }, 'GOOGLE_RATE_LIMITED', true],
      [{ status: 503, text: `<html>${code}</html>` }, 'GOOGLE_SERVER', true],
      [{ status: 200, json: { expires_in: 3599 } }, 'GOOGLE_BAD_RESPONSE', false],
      [{ status: 200, json: { access_token: 'ya29.x', expires_in: -1 } }, 'GOOGLE_BAD_RESPONSE', false],
      [{ status: 200, json: { access_token: 'ya29.x', expires_in: 3599, token_type: 'MAC' } }, 'GOOGLE_BAD_RESPONSE', false],
      [{ status: 200, text: 'not json' }, 'GOOGLE_BAD_RESPONSE', false],
      [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'GOOGLE_TIMEOUT', true],
      [new TypeError('fetch failed'), 'GOOGLE_NETWORK', true],
    ];
    for (const [answer, expectedCode, retryable] of cases) {
      const fake = fakeGoogle(answer);
      await assert.rejects(
        exchangeAuthorizationCode(CONFIG, { code, codeVerifier: 'v' }, { fetchImpl: fake.fetchImpl }),
        (error) => {
          assert.ok(error instanceof GoogleOAuthError);
          assert.equal(error.code, expectedCode);
          assert.equal(error.retryable, retryable);
          assertNoSecrets(error, [code, CLIENT_SECRET, 'Bad code']);
          return true;
        }
      );
    }
  });

  it('only keeps a short Google error keyword', async () => {
    const fake = fakeGoogle({ status: 400, json: { error: 'contains spaces and 1//token' } });
    await assert.rejects(refreshAccessToken(CONFIG, '1//refresh', { fetchImpl: fake.fetchImpl }), (error) => {
      assert.equal(error.googleError, null);
      assert.equal(error.code, 'GOOGLE_REQUEST_REJECTED');
      return true;
    });
  });

  it('refreshes an access token with the refresh token in the POST body', async () => {
    const fake = fakeGoogle({ json: { access_token: 'ya29.fresh', expires_in: 3599, scope: GMAIL_SEND_SCOPE, token_type: 'Bearer' } });
    const tokens = await refreshAccessToken(CONFIG, '1//refresh-secret', { fetchImpl: fake.fetchImpl });
    assert.equal(tokens.accessToken, 'ya29.fresh');
    assert.equal(tokens.refreshToken, null);
    assert.deepEqual(fake.calls[0].body, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: '1//refresh-secret',
      grant_type: 'refresh_token',
    });
    const revoked = fakeGoogle({ status: 400, json: { error: 'invalid_grant' } });
    await assert.rejects(refreshAccessToken(CONFIG, '1//gone', { fetchImpl: revoked.fetchImpl }), (e) => e.code === 'GOOGLE_INVALID_GRANT');
  });

  it('revokes a token; an already-invalid token counts as revoked', async () => {
    const ok = fakeGoogle({ status: 200, json: {} });
    assert.equal(await revokeToken('1//r', { fetchImpl: ok.fetchImpl }), true);
    assert.equal(ok.calls[0].url, GOOGLE_ENDPOINTS.revoke);
    assert.deepEqual(ok.calls[0].body, { token: '1//r' });
    const already = fakeGoogle({ status: 400, json: { error: 'invalid_token' } });
    assert.equal(await revokeToken('1//r', { fetchImpl: already.fetchImpl }), true);
    const down = fakeGoogle({ status: 500, json: {} });
    await assert.rejects(revokeToken('1//r', { fetchImpl: down.fetchImpl }), (e) => e.code === 'GOOGLE_SERVER');
  });
});

describe('Google OAuth: identity from the ID token', () => {
  it('reads sub, email and name from a valid token', () => {
    assert.deepEqual(readIdTokenClaims(idToken(goodClaims()), CONFIG), {
      sub: '109876543210987654321',
      email: 'sender.test@example.com',
      name: 'Sender Test',
    });
    assert.equal(readIdTokenClaims(idToken(goodClaims({ iss: 'accounts.google.com', email_verified: 'true' })), CONFIG).sub, '109876543210987654321');
    const multi = goodClaims({ aud: [CLIENT_ID, 'other.apps.googleusercontent.com'], azp: CLIENT_ID });
    assert.equal(readIdTokenClaims(idToken(multi), CONFIG).email, 'sender.test@example.com');
  });

  it('refuses a token for another app, another issuer, expired, unverified or malformed', () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      idToken(goodClaims({ aud: 'other.apps.googleusercontent.com' })),
      idToken(goodClaims({ aud: [CLIENT_ID, 'other.apps.googleusercontent.com'] })), // no azp
      idToken(goodClaims({ iss: 'https://evil.example' })),
      idToken(goodClaims({ exp: now - 3600 })),
      idToken(goodClaims({ iat: now + 3600 })),
      idToken(goodClaims({ email_verified: false })),
      idToken(goodClaims({ email: 'not-an-email' })),
      idToken(goodClaims({ sub: 'bad sub with spaces' })),
      idToken(goodClaims({ sub: undefined })),
      'only.two',
      'a.!!!.c',
      null,
    ];
    for (const token of bad) {
      assert.throws(() => readIdTokenClaims(token, CONFIG), (e) => e instanceof GoogleOAuthError && e.code === 'GOOGLE_BAD_IDENTITY');
    }
  });
});
