/**
 * Completing a Gmail connection: POST /api/v1/sender-accounts/google/callback.
 * Google is a fake HTTP client (no network); every credential and token is a made-up test value.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.TOKEN_ENCRYPTION_KEYS = `callback-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import OAuthState from '../src/models/OAuthState.js';
import SenderAccount from '../src/models/SenderAccount.js';
import { connectDB } from '../src/config/db.js';
import { GOOGLE_ENDPOINTS, GMAIL_SEND_SCOPE } from '../src/config/googleOAuth.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { resetTokenCipher } from '../src/utils/tokenCrypto.js';
import { setGoogleHttpClient } from '../src/services/googleOAuth.service.js';
import { openRefreshToken, openAccessToken, MAX_SENDER_ACCOUNTS_PER_USER } from '../src/services/senderAccount.service.js';

resetTokenCipher();

const GOOGLE_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: '123456789-testonly.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: `test-only-secret-${crypto.randomBytes(8).toString('hex')}`,
  GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example.test/settings/sender-accounts/callback',
};
const setGoogleEnv = (on) => {
  for (const [name, value] of Object.entries(GOOGLE_ENV)) {
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
};

const idToken = (overrides = {}) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    aud: GOOGLE_ENV.GOOGLE_OAUTH_CLIENT_ID,
    sub: '100000000000000000001',
    email: 'mailbox.one@example.com',
    email_verified: true,
    name: 'Mailbox One',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.c2ln`;
};

/** Token endpoint answer for a successful exchange, with fresh made-up tokens. */
const grant = ({ sub, email, scope = `openid ${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`, refresh = true, claims = {} } = {}) => ({
  access_token: `ya29.test-access-${crypto.randomBytes(8).toString('hex')}`,
  expires_in: 3599,
  token_type: 'Bearer',
  scope,
  ...(refresh && { refresh_token: `1//test-refresh-${crypto.randomBytes(8).toString('hex')}` }),
  id_token: idToken({ ...(sub && { sub }), ...(email && { email }), ...claims }),
});

/**
 * Fake Google. `tokenAnswer` answers the token endpoint; revocations are recorded and accepted.
 */
const fakeGoogle = (tokenAnswer) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, body });
    if (url === GOOGLE_ENDPOINTS.revoke) return new Response('{}', { status: 200 });
    if (url !== GOOGLE_ENDPOINTS.token) throw new Error(`unexpected URL ${url}`);
    if (tokenAnswer instanceof Error) throw tokenAnswer;
    const { status = 200, json } = tokenAnswer.status ? tokenAnswer : { json: tokenAnswer };
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  setGoogleHttpClient(fetchImpl);
  return {
    calls,
    tokenCalls: () => calls.filter((c) => c.url === GOOGLE_ENDPOINTS.token),
    revokeCalls: () => calls.filter((c) => c.url === GOOGLE_ENDPOINTS.revoke),
  };
};

describe('Sender accounts API: complete a Gmail connection', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `cb-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let owner;
  let other;
  let ownerToken;
  let otherToken;

  const post = (path, body, token = ownerToken) =>
    fetch(`${baseUrl}/api/v1/sender-accounts${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body ?? {}),
    });

  /** Starts a connection and returns the state and PKCE challenge from the consent URL. */
  const start = async (token = ownerToken) => {
    const res = await post('/google/connect', {}, token);
    assert.equal(res.status, 200);
    const url = new URL((await res.json()).data.authorizationUrl);
    return { state: url.searchParams.get('state'), challenge: url.searchParams.get('code_challenge') };
  };
  const callback = (state, code = `4/test-code-${crypto.randomBytes(6).toString('hex')}`, token = ownerToken) =>
    post('/google/callback', { state, code }, token);
  const ids = () => [owner._id, other._id];
  const withTokens = (filter) =>
    SenderAccount.findOne(filter).select('+encryptedRefreshToken +encryptedAccessToken +accessTokenExpiresAt');

  before(async () => {
    try {
      await connectDB();
      await OAuthState.init();
      await SenderAccount.init();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Sender Callback Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      owner = await User.create({ name: 'Callback Owner', email: `${prefix}-owner@example.com`, passwordHash });
      other = await User.create({ name: 'Callback Other', email: `${prefix}-other@example.com`, passwordHash });
      ownerToken = signAccessToken(owner);
      otherToken = signAccessToken(other);
    }
  });

  beforeEach(async () => {
    setGoogleEnv(true);
    if (isDbConnected) {
      await OAuthState.deleteMany({ userId: { $in: ids() } });
      await SenderAccount.deleteMany({ userId: { $in: ids() } });
    }
  });

  afterEach(() => {
    setGoogleEnv(false);
    setGoogleHttpClient(null);
  });

  after(async () => {
    setGoogleEnv(false);
    setGoogleHttpClient(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await OAuthState.deleteMany({ userId: { $in: ids() } });
      await SenderAccount.deleteMany({ userId: { $in: ids() } });
      await User.deleteMany({ _id: { $in: ids() } });
      await mongoose.disconnect();
    }
  });

  it('connects a mailbox: tokens stored encrypted, PKCE verifier sent, nothing secret returned', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { state, challenge } = await start();
    const answer = grant();
    const google = fakeGoogle(answer);
    const code = '4/test-code-connect';

    const res = await callback(state, code);
    assert.equal(res.status, 201);
    const text = await res.text();
    for (const secret of [answer.access_token, answer.refresh_token, code, state, GOOGLE_ENV.GOOGLE_OAUTH_CLIENT_SECRET, 'mpt1.']) {
      assert.ok(!text.includes(secret), 'response carries no token, code, state or secret');
    }
    const { senderAccount } = JSON.parse(text).data;
    assert.equal(senderAccount.email, 'mailbox.one@example.com');
    assert.equal(senderAccount.displayName, 'Mailbox One');
    assert.equal(senderAccount.status, 'active');
    assert.equal(senderAccount.canSend, true);
    assert.ok(senderAccount.scopes.includes(GMAIL_SEND_SCOPE));

    const [tokenCall] = google.tokenCalls();
    assert.equal(tokenCall.body.code, code);
    assert.equal(tokenCall.body.grant_type, 'authorization_code');
    assert.equal(
      crypto.createHash('sha256').update(tokenCall.body.code_verifier).digest('base64url'),
      challenge,
      'the verifier sent to Google matches the challenge in the consent URL'
    );
    assert.equal(google.revokeCalls().length, 0);

    const stored = await withTokens({ _id: senderAccount.id, userId: owner._id });
    assert.equal(stored.providerAccountId, '100000000000000000001');
    assert.equal(openRefreshToken(stored._id, stored.encryptedRefreshToken), answer.refresh_token);
    assert.equal(openAccessToken(stored._id, stored.encryptedAccessToken), answer.access_token);
    assert.ok(stored.accessTokenExpiresAt.getTime() > Date.now() + 3500_000);
    const raw = JSON.stringify(await SenderAccount.collection.findOne({ _id: stored._id }));
    assert.ok(!raw.includes(answer.refresh_token) && !raw.includes(answer.access_token), 'no plaintext token in the database');
    assert.equal(await OAuthState.countDocuments({ userId: owner._id }), 0, 'the pending connection is gone');
  });

  it('a state works once: a replayed callback is refused without calling Google again', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { state } = await start();
    const google = fakeGoogle(grant());
    assert.equal((await callback(state)).status, 201);
    const replay = await callback(state);
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).message, /invalid or has expired/);
    assert.equal(google.tokenCalls().length, 1);
  });

  it('a state belongs to the user who started it', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { state } = await start(otherToken);
    const google = fakeGoogle(grant());
    assert.equal((await callback(state, undefined, ownerToken)).status, 400);
    assert.equal(google.tokenCalls().length, 0);
    assert.equal(await SenderAccount.countDocuments({ userId: { $in: ids() } }), 0);
    // Still usable by its owner
    assert.equal((await callback(state, undefined, otherToken)).status, 201);
    assert.equal(await SenderAccount.countDocuments({ userId: other._id }), 1);
    assert.equal(await SenderAccount.countDocuments({ userId: owner._id }), 0);
  });

  it('refuses unknown and expired states', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const google = fakeGoogle(grant());
    assert.equal((await callback('made-up-state-value')).status, 400);
    const { state } = await start();
    await OAuthState.updateOne({ userId: owner._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await callback(state)).status, 400);
    assert.equal(google.tokenCalls().length, 0);
  });

  it('validates the request body before doing anything', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { state } = await start();
    const google = fakeGoogle(grant());
    for (const body of [{ state }, { code: 'x' }, { state, code: '' }, { state, code: 'has space' }, { state, code: 'x', extra: 1 }, { state, code: 'x'.repeat(3000) }]) {
      assert.equal((await post('/google/callback', body)).status, 400, JSON.stringify(Object.keys(body)));
    }
    assert.equal(google.tokenCalls().length, 0);
    assert.equal((await post('/google/callback', { state, code: 'x' }, null)).status, 401);
  });

  it('answers 503 when Gmail sending is not configured', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { state } = await start();
    setGoogleEnv(false);
    assert.equal((await callback(state)).status, 503);
  });

  it('maps Google errors safely and stores nothing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const cases = [
      [{ status: 400, json: { error: 'invalid_grant', error_description: 'Bad Request 4/secret' } }, 400, /did not accept/],
      [{ status: 401, json: { error: 'invalid_client' } }, 502, /misconfigured/],
      [{ status: 503, json: {} }, 502, /Could not complete/],
      [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 502, /Could not complete/],
    ];
    for (const [answer, status, message] of cases) {
      const { state } = await start();
      fakeGoogle(answer);
      const res = await callback(state);
      assert.equal(res.status, status);
      const body = await res.json();
      assert.match(body.message, message);
      assert.ok(!JSON.stringify(body).includes('4/secret'));
    }
    assert.equal(await SenderAccount.countDocuments({ userId: owner._id }), 0);
  });

  it('refuses a grant without gmail.send and revokes it', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { state } = await start();
    const answer = grant({ scope: 'openid https://www.googleapis.com/auth/userinfo.email' });
    const google = fakeGoogle(answer);
    const res = await callback(state);
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /Permission to send email was not granted/);
    assert.equal(await SenderAccount.countDocuments({ userId: owner._id }), 0);
    assert.deepEqual(google.revokeCalls().map((c) => c.body.token), [answer.refresh_token]);
  });

  it('never revokes a grant another connected record uses (same Google account)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    // The other user has this Google account connected; revoking would cut them off
    const first = await start(otherToken);
    fakeGoogle(grant());
    assert.equal((await callback(first.state, undefined, otherToken)).status, 201);

    const { state } = await start();
    const google = fakeGoogle(grant({ scope: 'openid' }));
    assert.equal((await callback(state)).status, 400);
    assert.equal(google.revokeCalls().length, 0);
    const theirs = await SenderAccount.findOne({ userId: other._id });
    assert.equal(theirs.status, 'active');
  });

  it('refuses a grant without a refresh token, and an invalid identity (not revoked: unknown owner)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    let { state } = await start();
    let google = fakeGoogle(grant({ refresh: false }));
    assert.equal((await callback(state)).status, 400);
    assert.equal(google.revokeCalls().length, 1);

    ({ state } = await start());
    google = fakeGoogle(grant({ claims: { aud: 'someone-else.apps.googleusercontent.com' } }));
    const res = await callback(state);
    assert.equal(res.status, 502);
    assert.match((await res.json()).message, /invalid account identity/);
    assert.equal(google.revokeCalls().length, 0);

    ({ state } = await start());
    fakeGoogle(grant({ claims: { email_verified: false } }));
    assert.equal((await callback(state)).status, 502);
    assert.equal(await SenderAccount.countDocuments({ userId: owner._id }), 0);
  });

  it('reconnecting the same Google account updates the record and never revokes the grant', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    let { state } = await start();
    fakeGoogle(grant());
    const firstId = (await (await callback(state)).json()).data.senderAccount.id;
    await SenderAccount.updateOne(
      { _id: firstId },
      { $set: { status: 'reauth_required', statusReason: 'TOKEN_REVOKED', encryptedAccessToken: null } }
    );
    const before = await SenderAccount.findById(firstId);

    ({ state } = await start());
    const answer = grant({ email: 'renamed.mailbox@example.com' });
    const google = fakeGoogle(answer);
    const res = await callback(state);
    assert.equal(res.status, 200);
    const { senderAccount } = (await res.json()).data;
    assert.equal(senderAccount.id, firstId);
    assert.equal(senderAccount.status, 'active');
    assert.equal(senderAccount.statusReason, null);
    assert.equal(senderAccount.email, 'renamed.mailbox@example.com');
    assert.equal(google.revokeCalls().length, 0);

    const after = await withTokens({ _id: firstId });
    assert.equal(after.tokenGeneration, before.tokenGeneration + 1);
    assert.equal(openRefreshToken(after._id, after.encryptedRefreshToken), answer.refresh_token);
    assert.equal(await SenderAccount.countDocuments({ userId: owner._id }), 1);
  });

  it('two users may connect the same Google account, each with their own record', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const a = await start(ownerToken);
    fakeGoogle(grant());
    assert.equal((await callback(a.state, undefined, ownerToken)).status, 201);
    const b = await start(otherToken);
    fakeGoogle(grant());
    assert.equal((await callback(b.state, undefined, otherToken)).status, 201);
    const records = await SenderAccount.find({ providerAccountId: '100000000000000000001', userId: { $in: ids() } });
    assert.equal(records.length, 2);
    assert.notEqual(String(records[0]._id), String(records[1]._id));
  });

  it(`enforces the ${MAX_SENDER_ACCOUNTS_PER_USER}-account limit at completion too, discarding the new grant`, async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { state } = await start();
    await SenderAccount.insertMany(
      Array.from({ length: MAX_SENDER_ACCOUNTS_PER_USER }, (_, i) => ({
        userId: owner._id,
        provider: 'google',
        providerAccountId: `sub-full-${i}`,
        email: `full${i}@example.com`,
      }))
    );
    const answer = grant({ sub: '100000000000000000999' });
    const google = fakeGoogle(answer);
    assert.equal((await callback(state)).status, 409);
    assert.equal(await SenderAccount.exists({ userId: owner._id, providerAccountId: '100000000000000000999' }), null);
    assert.deepEqual(google.revokeCalls().map((c) => c.body.token), [answer.refresh_token]);
  });
});
