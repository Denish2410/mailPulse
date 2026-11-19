/**
 * Starting a Gmail connection: POST /api/v1/sender-accounts/google/connect.
 * Google is never contacted (this step only builds the consent URL). Test-only credentials.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.TOKEN_ENCRYPTION_KEYS = `connect-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import OAuthState from '../src/models/OAuthState.js';
import SenderAccount from '../src/models/SenderAccount.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { resetTokenCipher, decryptToken } from '../src/utils/tokenCrypto.js';
import { hashOAuthState } from '../src/services/googleOAuth.service.js';
import { deleteAccountData } from '../src/services/account.service.js';
import {
  codeVerifierContext,
  MAX_PENDING_CONNECTIONS,
  OAUTH_STATE_TTL_MS,
} from '../src/services/senderConnection.service.js';
import { MAX_SENDER_ACCOUNTS_PER_USER } from '../src/services/senderAccount.service.js';

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

describe('Sender accounts API: start a Gmail connection', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `conn-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let owner;
  let other;
  let ownerToken;

  const connect = (token = ownerToken) =>
    fetch(`${baseUrl}/api/v1/sender-accounts/google/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: '{}',
    });
  const ids = () => [owner._id, other._id];

  before(async () => {
    try {
      await connectDB();
      await OAuthState.init();
      await SenderAccount.init();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Sender Connect Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      owner = await User.create({ name: 'Connect Owner', email: `${prefix}-owner@example.com`, passwordHash });
      other = await User.create({ name: 'Connect Other', email: `${prefix}-other@example.com`, passwordHash });
      ownerToken = signAccessToken(owner);
    }
  });

  beforeEach(async () => {
    setGoogleEnv(true);
    if (isDbConnected) {
      await OAuthState.deleteMany({ userId: { $in: ids() } });
      await SenderAccount.deleteMany({ userId: { $in: ids() } });
    }
  });

  afterEach(() => setGoogleEnv(false));

  after(async () => {
    setGoogleEnv(false);
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await OAuthState.deleteMany({ userId: { $in: ids() } });
      await SenderAccount.deleteMany({ userId: { $in: ids() } });
      await User.deleteMany({ _id: { $in: ids() } });
      await mongoose.disconnect();
    }
  });

  it('requires authentication', async () => {
    assert.equal((await connect(null)).status, 401);
  });

  it('answers 503 when Gmail sending is not configured, and stores nothing', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    setGoogleEnv(false);
    const res = await connect();
    assert.equal(res.status, 503);
    assert.equal((await res.json()).message, 'Gmail sending is not configured on this server.');
    assert.equal(await OAuthState.countDocuments({ userId: owner._id }), 0);
  });

  it('returns the Google consent URL and stores only a hash of the state and an encrypted verifier', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const before = Date.now();
    const res = await connect();
    assert.equal(res.status, 200);
    const body = await res.json();
    const url = new URL(body.data.authorizationUrl);
    assert.equal(url.origin, 'https://accounts.google.com');
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');
    assert.ok(state && challenge);
    assert.equal(url.searchParams.get('client_id'), GOOGLE_ENV.GOOGLE_OAUTH_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), GOOGLE_ENV.GOOGLE_OAUTH_REDIRECT_URI);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!JSON.stringify(body).includes(GOOGLE_ENV.GOOGLE_OAUTH_CLIENT_SECRET));

    const stored = await OAuthState.find({ userId: owner._id }).select('+encryptedCodeVerifier').lean();
    assert.equal(stored.length, 1);
    const [doc] = stored;
    assert.equal(doc.stateHash, hashOAuthState(state));
    assert.equal(doc.consumedAt, null);
    const raw = JSON.stringify(await OAuthState.collection.findOne({ _id: doc._id }));
    assert.ok(!raw.includes(state), 'the raw state is never stored');
    assert.match(doc.encryptedCodeVerifier, /^mpt1\./);
    const verifier = decryptToken(doc.encryptedCodeVerifier, { context: codeVerifierContext(doc._id) });
    assert.ok(!raw.includes(verifier), 'the verifier is never stored in plaintext');
    assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge, 'challenge matches the stored verifier');

    const ttl = new Date(doc.expiresAt).getTime() - before;
    assert.ok(ttl > OAUTH_STATE_TTL_MS - 60_000 && ttl <= OAUTH_STATE_TTL_MS + 60_000);
    assert.equal(new Date(body.data.expiresAt).getTime(), new Date(doc.expiresAt).getTime());
  });

  it('gives every attempt its own state', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const a = new URL((await (await connect()).json()).data.authorizationUrl).searchParams.get('state');
    const b = new URL((await (await connect()).json()).data.authorizationUrl).searchParams.get('state');
    assert.notEqual(a, b);
    assert.equal(await OAuthState.countDocuments({ userId: owner._id }), 2);
  });

  it(`limits pending connections to ${MAX_PENDING_CONNECTIONS} per user (expired and used ones do not count)`, async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 0; i < MAX_PENDING_CONNECTIONS; i += 1) assert.equal((await connect()).status, 200);
    assert.equal((await connect()).status, 429);

    await OAuthState.updateOne({ userId: owner._id }, { $set: { consumedAt: new Date() } });
    assert.equal((await connect()).status, 200);
    await OAuthState.updateOne({ userId: owner._id, consumedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await connect()).status, 200);
    assert.equal((await connect()).status, 429);
  });

  it(`refuses a new connection at ${MAX_SENDER_ACCOUNTS_PER_USER} connected accounts (disconnected ones do not count)`, async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const docs = Array.from({ length: MAX_SENDER_ACCOUNTS_PER_USER }, (_, i) => ({
      userId: owner._id,
      provider: 'google',
      providerAccountId: `sub-limit-${i}`,
      email: `limit${i}@example.com`,
      status: i === 0 ? 'reauth_required' : 'active',
    }));
    await SenderAccount.insertMany(docs);
    const res = await connect();
    assert.equal(res.status, 409);
    assert.equal(await OAuthState.countDocuments({ userId: owner._id }), 0);

    await SenderAccount.updateOne({ userId: owner._id, providerAccountId: 'sub-limit-0' }, { $set: { status: 'disconnected' } });
    assert.equal((await connect()).status, 200);
  });

  it('pending connections are deleted with the account', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const throwaway = await User.create({
      name: 'Connect Gone',
      email: `${prefix}-gone@example.com`,
      passwordHash: await hashPassword('StrongPassword123!'),
    });
    assert.equal((await connect(signAccessToken(throwaway))).status, 200);
    assert.equal((await connect()).status, 200);
    const counts = await deleteAccountData(throwaway._id);
    assert.equal(counts.oauthStates, 1);
    assert.equal(await OAuthState.countDocuments({ userId: throwaway._id }), 0);
    assert.equal(await OAuthState.countDocuments({ userId: owner._id }), 1);
  });
});
