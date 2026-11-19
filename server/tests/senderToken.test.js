/**
 * Access-token provider for sender accounts (refresh, caching, races, reauth).
 * Google is a fake HTTP client; all tokens are made-up test values.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.TOKEN_ENCRYPTION_KEYS = `token-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import SenderAccount from '../src/models/SenderAccount.js';
import { connectDB } from '../src/config/db.js';
import { GOOGLE_ENDPOINTS, GMAIL_SEND_SCOPE } from '../src/config/googleOAuth.js';
import { hashPassword } from '../src/services/password.service.js';
import { resetTokenCipher, createTokenCipher } from '../src/utils/tokenCrypto.js';
import {
  sealRefreshToken,
  sealAccessToken,
  openRefreshToken,
  openAccessToken,
  refreshTokenContext,
} from '../src/services/senderAccount.service.js';
import {
  ACCESS_TOKEN_MIN_VALIDITY_MS,
  SenderAccountUnavailableError,
  SenderTokenRefreshError,
  getSenderAccessToken,
  invalidateSenderAccessToken,
  markSenderReauthRequired,
} from '../src/services/senderToken.service.js';
import { disconnectSenderAccount } from '../src/services/senderConnection.service.js';

resetTokenCipher();

const GOOGLE_ENV = {
  NODE_ENV: 'test',
  GOOGLE_OAUTH_CLIENT_ID: '123456789-testonly.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: `test-only-secret-${crypto.randomBytes(8).toString('hex')}`,
  GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example.test/settings/sender-accounts/callback',
};

/** Fake token endpoint. `answer` is a JSON body, { status, json }, an Error, or a function. */
const fakeGoogle = (answer) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, GOOGLE_ENDPOINTS.token);
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push(body);
    let a = typeof answer === 'function' ? await answer(calls.length) : answer;
    if (a instanceof Error) throw a;
    if (!a.status) a = { status: 200, json: a };
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
};
const fresh = (extra = {}) => ({
  access_token: `ya29.test-fresh-${crypto.randomBytes(6).toString('hex')}`,
  expires_in: 3599,
  token_type: 'Bearer',
  scope: GMAIL_SEND_SCOPE,
  ...extra,
});

describe('Sender access tokens', () => {
  let isDbConnected = false;
  const prefix = `tok-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let owner;
  let other;

  const createAccount = async (user = owner, { accessValidForMs = 3600_000, ...overrides } = {}) => {
    const _id = new mongoose.Types.ObjectId();
    const refresh = `1//test-refresh-${crypto.randomBytes(6).toString('hex')}`;
    const access = `ya29.test-cached-${crypto.randomBytes(6).toString('hex')}`;
    await SenderAccount.create({
      _id,
      userId: user._id,
      provider: 'google',
      providerAccountId: `sub-${crypto.randomBytes(6).toString('hex')}`,
      email: `${crypto.randomBytes(4).toString('hex')}@example.com`,
      displayName: 'Test Mailbox',
      scopes: [GMAIL_SEND_SCOPE],
      encryptedRefreshToken: sealRefreshToken(_id, refresh),
      encryptedAccessToken: accessValidForMs === null ? null : sealAccessToken(_id, access),
      accessTokenExpiresAt: accessValidForMs === null ? null : new Date(Date.now() + accessValidForMs),
      connectedAt: new Date(),
      ...overrides,
    });
    return { id: _id, refresh, access };
  };
  const get = (account, google, extra = {}) =>
    getSenderAccessToken({ userId: owner._id, senderAccountId: account.id, env: GOOGLE_ENV, fetchImpl: google?.fetchImpl, ...extra });
  const load = (id) => SenderAccount.findById(id).select('+encryptedRefreshToken +encryptedAccessToken +accessTokenExpiresAt');
  const rejectsCode = (promise, Type, code) =>
    assert.rejects(promise, (error) => {
      assert.ok(error instanceof Type, `expected ${Type.name}, got ${error?.name}: ${error?.message}`);
      assert.equal(error.code, code);
      assert.ok(!/ya29\.|1\/\/|mpt1\./.test(`${error.message}${error.stack}`), 'no token in the error');
      return true;
    });

  before(async () => {
    try {
      await connectDB();
      await SenderAccount.init();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Sender Token Tests] MongoDB unavailable: ${err.message}`);
      return;
    }
    const passwordHash = await hashPassword('StrongPassword123!');
    owner = await User.create({ name: 'Token Owner', email: `${prefix}-owner@example.com`, passwordHash });
    other = await User.create({ name: 'Token Other', email: `${prefix}-other@example.com`, passwordHash });
  });

  beforeEach(async () => {
    if (isDbConnected) await SenderAccount.deleteMany({ userId: { $in: [owner._id, other._id] } });
  });

  after(async () => {
    if (isDbConnected) {
      await SenderAccount.deleteMany({ userId: { $in: [owner._id, other._id] } });
      await User.deleteMany({ _id: { $in: [owner._id, other._id] } });
      await mongoose.disconnect();
    }
  });

  it('returns the cached access token while it is valid, without calling Google', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount();
    const google = fakeGoogle(fresh());
    const result = await get(account, google);
    assert.equal(result.accessToken, account.access);
    assert.equal(result.senderAccountId, String(account.id));
    assert.equal(result.displayName, 'Test Mailbox');
    assert.equal(google.calls.length, 0);
  });

  it('refreshes an expired or nearly expired token and stores the new one encrypted', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (const accessValidForMs of [null, -60_000, ACCESS_TOKEN_MIN_VALIDITY_MS - 10_000]) {
      const account = await createAccount(owner, { accessValidForMs });
      const answer = fresh();
      const google = fakeGoogle(answer);
      const result = await get(account, google);
      assert.equal(result.accessToken, answer.access_token);
      assert.equal(google.calls.length, 1);
      assert.equal(google.calls[0].refresh_token, account.refresh);
      assert.equal(google.calls[0].grant_type, 'refresh_token');

      const stored = await load(account.id);
      assert.equal(openAccessToken(account.id, stored.encryptedAccessToken), answer.access_token);
      assert.ok(stored.accessTokenExpiresAt.getTime() > Date.now() + 3500_000);
      assert.ok(stored.lastRefreshedAt);
      assert.equal(openRefreshToken(account.id, stored.encryptedRefreshToken), account.refresh, 'refresh token unchanged');
      const raw = JSON.stringify(await SenderAccount.collection.findOne({ _id: account.id }));
      assert.ok(!raw.includes(answer.access_token));
    }
  });

  it('concurrent callers share one refresh', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount(owner, { accessValidForMs: null });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const answer = fresh();
    const google = fakeGoogle(async () => {
      await gate;
      return answer;
    });
    const pending = Array.from({ length: 5 }, () => get(account, google));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const results = await Promise.all(pending);
    assert.equal(google.calls.length, 1);
    assert.ok(results.every((r) => r.accessToken === answer.access_token));
  });

  it('stores a rotated refresh token and moves to a new generation', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount(owner, { accessValidForMs: null });
    const before = await load(account.id);
    const google = fakeGoogle(fresh({ refresh_token: '1//test-rotated' }));
    const result = await get(account, google);
    const after = await load(account.id);
    assert.equal(openRefreshToken(account.id, after.encryptedRefreshToken), '1//test-rotated');
    assert.equal(after.tokenGeneration, before.tokenGeneration + 1);
    assert.equal(result.tokenGeneration, after.tokenGeneration);
  });

  it('Google refusing the grant marks the account reauth_required; later calls fail without Google', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount(owner, { accessValidForMs: null });
    const google = fakeGoogle({ status: 400, json: { error: 'invalid_grant' } });
    await rejectsCode(get(account, google), SenderAccountUnavailableError, 'SENDER_REAUTH_REQUIRED');
    const stored = await load(account.id);
    assert.equal(stored.status, 'reauth_required');
    assert.equal(stored.statusReason, 'TOKEN_REVOKED');
    assert.equal(stored.encryptedAccessToken, null);
    assert.match(stored.encryptedRefreshToken, /^mpt1\./, 'kept until the customer reconnects or disconnects');

    await rejectsCode(get(account, google), SenderAccountUnavailableError, 'SENDER_REAUTH_REQUIRED');
    assert.equal(google.calls.length, 1);
  });

  it('a refresh without gmail.send marks the account reauth_required (SCOPE_MISSING)', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount(owner, { accessValidForMs: null });
    await rejectsCode(get(account, fakeGoogle(fresh({ scope: 'openid email' }))), SenderAccountUnavailableError, 'SENDER_REAUTH_REQUIRED');
    const stored = await load(account.id);
    assert.equal(stored.status, 'reauth_required');
    assert.equal(stored.statusReason, 'SCOPE_MISSING');
  });

  it('temporary Google failures are retryable and change nothing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const answers = [
      { status: 503, json: {} },
      { status: 429, json: {} },
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      new TypeError('fetch failed'),
    ];
    for (const answer of answers) {
      const account = await createAccount(owner, { accessValidForMs: null });
      await assert.rejects(get(account, fakeGoogle(answer)), (error) => {
        assert.ok(error instanceof SenderTokenRefreshError);
        assert.equal(error.retryable, true);
        return true;
      });
      const stored = await load(account.id);
      assert.equal(stored.status, 'active');
      assert.equal(stored.encryptedAccessToken, null);
    }
    const misconfigured = await createAccount(owner, { accessValidForMs: null });
    await assert.rejects(get(misconfigured, fakeGoogle({ status: 401, json: { error: 'invalid_client' } })), (error) => {
      assert.equal(error.code, 'GOOGLE_CLIENT_MISCONFIGURED');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal((await load(misconfigured.id)).status, 'active', 'a server misconfiguration is not the customer\'s fault');
  });

  it('refuses disconnected, reauth_required, foreign and missing accounts without calling Google', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const google = fakeGoogle(fresh());
    const disconnected = await createAccount(owner, { status: 'disconnected', encryptedRefreshToken: null, accessValidForMs: null });
    await rejectsCode(get(disconnected, google), SenderAccountUnavailableError, 'SENDER_DISCONNECTED');
    const reauth = await createAccount(owner, { status: 'reauth_required', statusReason: 'TOKEN_REVOKED' });
    await rejectsCode(get(reauth, google), SenderAccountUnavailableError, 'SENDER_REAUTH_REQUIRED');
    const theirs = await createAccount(other);
    await rejectsCode(get(theirs, google), SenderAccountUnavailableError, 'SENDER_NOT_FOUND');
    await rejectsCode(get({ id: new mongoose.Types.ObjectId() }, google), SenderAccountUnavailableError, 'SENDER_NOT_FOUND');
    await rejectsCode(get({ id: 'not-an-id' }, google), SenderAccountUnavailableError, 'SENDER_NOT_FOUND');
    assert.equal(google.calls.length, 0);
  });

  it('a disconnect during a refresh wins: wiped tokens are never restored', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount(owner, { accessValidForMs: null });
    const google = fakeGoogle(async () => {
      // The customer disconnects while Google is answering
      await disconnectSenderAccount({ userId: owner._id, accountId: account.id, fetchImpl: async () => new Response('{}') });
      return fresh();
    });
    await rejectsCode(get(account, google), SenderAccountUnavailableError, 'SENDER_DISCONNECTED');
    const raw = await SenderAccount.collection.findOne({ _id: account.id });
    assert.equal(raw.status, 'disconnected');
    assert.equal(raw.encryptedAccessToken, null);
    assert.equal(raw.encryptedRefreshToken, null);
  });

  it('a reconnect during a refresh wins: the new grant\'s tokens are kept and used', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount(owner, { accessValidForMs: null });
    const google = fakeGoogle(async () => {
      await SenderAccount.updateOne(
        { _id: account.id },
        {
          $set: {
            encryptedRefreshToken: sealRefreshToken(account.id, '1//test-reconnected'),
            encryptedAccessToken: sealAccessToken(account.id, 'ya29.test-reconnected'),
            accessTokenExpiresAt: new Date(Date.now() + 3600_000),
          },
          $inc: { tokenGeneration: 1 },
        }
      );
      return fresh();
    });
    const result = await get(account, google);
    assert.equal(result.accessToken, 'ya29.test-reconnected');
    const stored = await load(account.id);
    assert.equal(openRefreshToken(account.id, stored.encryptedRefreshToken), '1//test-reconnected');
    assert.equal(openAccessToken(account.id, stored.encryptedAccessToken), 'ya29.test-reconnected');
  });

  it('a reconnect wins over a stale reauth mark', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount(owner);
    const before = await load(account.id);
    await SenderAccount.updateOne({ _id: account.id }, { $inc: { tokenGeneration: 1 } });
    const changed = await markSenderReauthRequired({
      userId: owner._id,
      senderAccountId: account.id,
      tokenGeneration: before.tokenGeneration,
      reason: 'TOKEN_REVOKED',
    });
    assert.equal(changed, false);
    assert.equal((await load(account.id)).status, 'active');
  });

  it('an unreadable refresh token is reported, and the account is not marked', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount(owner, { accessValidForMs: null });
    const foreignKey = createTokenCipher({ keys: { 'token-test': crypto.randomBytes(32) }, activeKeyId: 'token-test' });
    await SenderAccount.updateOne(
      { _id: account.id },
      { $set: { encryptedRefreshToken: foreignKey.encrypt('1//x', { context: refreshTokenContext(account.id) }) } }
    );
    const google = fakeGoogle(fresh());
    await rejectsCode(get(account, google), SenderAccountUnavailableError, 'SENDER_TOKEN_UNREADABLE');
    assert.equal(google.calls.length, 0);
    assert.equal((await load(account.id)).status, 'active');
  });

  it('invalidating the cached token forces a refresh; not configured fails closed', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const account = await createAccount();
    await invalidateSenderAccessToken({ userId: owner._id, senderAccountId: account.id });
    const google = fakeGoogle(fresh());
    await get(account, google);
    assert.equal(google.calls.length, 1);

    const expired = await createAccount(owner, { accessValidForMs: null });
    await rejectsCode(get(expired, google, { env: { NODE_ENV: 'test' } }), SenderAccountUnavailableError, 'GMAIL_NOT_CONFIGURED');
    // Another user's invalidate does nothing
    await invalidateSenderAccessToken({ userId: other._id, senderAccountId: account.id });
    assert.ok((await load(account.id)).encryptedAccessToken);
  });
});
