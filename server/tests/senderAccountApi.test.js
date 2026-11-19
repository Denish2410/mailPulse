/**
 * Listing and disconnecting sender accounts (GET /api/v1/sender-accounts, POST /:id/disconnect),
 * and grant revocation on account deletion. Google is a fake HTTP client; made-up tokens only.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.TOKEN_ENCRYPTION_KEYS = `list-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import SenderAccount from '../src/models/SenderAccount.js';
import { connectDB } from '../src/config/db.js';
import { GOOGLE_ENDPOINTS } from '../src/config/googleOAuth.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { resetTokenCipher } from '../src/utils/tokenCrypto.js';
import { setGoogleHttpClient } from '../src/services/googleOAuth.service.js';
import { sealRefreshToken, sealAccessToken } from '../src/services/senderAccount.service.js';
import { deleteAccountData } from '../src/services/account.service.js';

resetTokenCipher();

/** Fake Google revocation endpoint answering `status`; records the revoked tokens. */
const fakeRevoke = (status = 200) => {
  const revoked = [];
  setGoogleHttpClient(async (url, init) => {
    if (url !== GOOGLE_ENDPOINTS.revoke) throw new Error(`unexpected URL ${url}`);
    revoked.push(new URLSearchParams(init.body).get('token'));
    return new Response('{}', { status });
  });
  return revoked;
};

describe('Sender accounts API: list, read, disconnect', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `sal-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let owner;
  let other;
  let ownerToken;

  const call = (method, path, token = ownerToken) =>
    fetch(`${baseUrl}/api/v1/sender-accounts${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(method === 'POST' && { body: '{}' }),
    });

  const createAccount = async (user, overrides = {}) => {
    const _id = new mongoose.Types.ObjectId();
    const refresh = `1//test-refresh-${crypto.randomBytes(8).toString('hex')}`;
    await SenderAccount.create({
      _id,
      userId: user._id,
      provider: 'google',
      providerAccountId: `sub-${crypto.randomBytes(6).toString('hex')}`,
      email: `${crypto.randomBytes(4).toString('hex')}@example.com`,
      encryptedRefreshToken: sealRefreshToken(_id, refresh),
      encryptedAccessToken: sealAccessToken(_id, 'ya29.test-access'),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      connectedAt: new Date(),
      ...overrides,
    });
    return { id: String(_id), refresh };
  };
  const ids = () => [owner._id, other._id];

  before(async () => {
    try {
      await connectDB();
      await SenderAccount.init();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Sender Account API Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      owner = await User.create({ name: 'List Owner', email: `${prefix}-owner@example.com`, passwordHash });
      other = await User.create({ name: 'List Other', email: `${prefix}-other@example.com`, passwordHash });
      ownerToken = signAccessToken(owner);
    }
  });

  beforeEach(async () => {
    if (isDbConnected) await SenderAccount.deleteMany({ userId: { $in: ids() } });
  });

  afterEach(() => setGoogleHttpClient(null));

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await SenderAccount.deleteMany({ userId: { $in: ids() } });
      await User.deleteMany({ _id: { $in: ids() } });
      await mongoose.disconnect();
    }
  });

  it('requires authentication', async () => {
    assert.equal((await call('GET', '/', null)).status, 401);
    assert.equal((await call('POST', `/${new mongoose.Types.ObjectId()}/disconnect`, null)).status, 401);
  });

  it('lists only the caller\'s accounts, newest first, with no token material', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const first = await createAccount(owner);
    const second = await createAccount(owner, { status: 'reauth_required', statusReason: 'TOKEN_REVOKED' });
    await createAccount(other);

    const res = await call('GET', '/');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('mpt1.') && !text.includes('1//test-refresh') && !text.includes('ya29.'));
    const { senderAccounts, count } = JSON.parse(text).data;
    assert.equal(count, 2);
    assert.deepEqual(senderAccounts.map((a) => a.id), [second.id, first.id]);
    assert.equal(senderAccounts[0].canSend, false);
    assert.equal(senderAccounts[0].statusReason, 'TOKEN_REVOKED');
    assert.equal(senderAccounts[1].canSend, true);
  });

  it('reads one account; another user\'s answers 404 like a missing one', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const mine = await createAccount(owner);
    const theirs = await createAccount(other);
    const res = await call('GET', `/${mine.id}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.senderAccount.id, mine.id);
    const foreign = await call('GET', `/${theirs.id}`);
    const missing = await call('GET', `/${new mongoose.Types.ObjectId()}`);
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await foreign.json(), await missing.json());
    assert.equal((await call('GET', '/not-an-id')).status, 400);
  });

  it('disconnect wipes the tokens atomically, then revokes the grant', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const mine = await createAccount(owner);
    const before = await SenderAccount.findById(mine.id);
    const revoked = fakeRevoke(200);

    const res = await call('POST', `/${mine.id}/disconnect`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.revoked, true);
    assert.equal(body.data.senderAccount.status, 'disconnected');
    assert.equal(body.data.senderAccount.canSend, false);
    assert.equal(body.data.senderAccount.statusReason, 'USER_DISCONNECTED');
    assert.ok(body.data.senderAccount.disconnectedAt);
    assert.deepEqual(revoked, [mine.refresh]);

    const raw = await SenderAccount.collection.findOne({ _id: before._id });
    assert.equal(raw.encryptedRefreshToken, null);
    assert.equal(raw.encryptedAccessToken, null);
    assert.equal(raw.accessTokenExpiresAt, null);
    assert.equal(raw.tokenGeneration, before.tokenGeneration + 1);
  });

  it('a failed revocation still disconnects; a repeated disconnect is a no-op', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const mine = await createAccount(owner);
    fakeRevoke(500);
    const res = await call('POST', `/${mine.id}/disconnect`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.revoked, false);
    const raw = await SenderAccount.collection.findOne({ _id: new mongoose.Types.ObjectId(mine.id) });
    assert.equal(raw.status, 'disconnected');
    assert.equal(raw.encryptedRefreshToken, null);

    const revoked = fakeRevoke(200);
    const again = await call('POST', `/${mine.id}/disconnect`);
    assert.equal(again.status, 200);
    const body = await again.json();
    assert.equal(body.message, 'Sender account was already disconnected.');
    assert.equal(body.data.revoked, false);
    assert.deepEqual(revoked, []);
    assert.equal((await SenderAccount.collection.findOne({ _id: raw._id })).tokenGeneration, raw.tokenGeneration);
  });

  it('never revokes a grant another connected record uses', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const mine = await createAccount(owner, { providerAccountId: 'sub-shared-grant' });
    await createAccount(other, { providerAccountId: 'sub-shared-grant' });
    const revoked = fakeRevoke(200);
    const res = await call('POST', `/${mine.id}/disconnect`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.revoked, false);
    assert.deepEqual(revoked, []);
    assert.equal((await SenderAccount.findOne({ userId: other._id })).status, 'active');
  });

  it('cannot disconnect another user\'s account', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const theirs = await createAccount(other);
    const revoked = fakeRevoke(200);
    assert.equal((await call('POST', `/${theirs.id}/disconnect`)).status, 404);
    assert.deepEqual(revoked, []);
    const raw = await SenderAccount.collection.findOne({ _id: new mongoose.Types.ObjectId(theirs.id) });
    assert.equal(raw.status, 'active');
    assert.match(raw.encryptedRefreshToken, /^mpt1\./);
  });

  it('a reauth_required account can be disconnected too', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const mine = await createAccount(owner, { status: 'reauth_required', statusReason: 'TOKEN_REVOKED' });
    fakeRevoke(200);
    const res = await call('POST', `/${mine.id}/disconnect`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.senderAccount.status, 'disconnected');
  });

  it('account deletion revokes the user\'s unshared grants (best effort) and deletes the records', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const gone = await User.create({
      name: 'List Gone',
      email: `${prefix}-gone@example.com`,
      passwordHash: await hashPassword('StrongPassword123!'),
    });
    const unshared = await createAccount(gone);
    await createAccount(gone, { providerAccountId: 'sub-shared-on-delete' });
    await createAccount(other, { providerAccountId: 'sub-shared-on-delete' });
    await createAccount(gone, { status: 'disconnected', encryptedRefreshToken: null, encryptedAccessToken: null });
    const revoked = fakeRevoke(200);

    const counts = await deleteAccountData(gone._id);
    assert.equal(counts.revokedSenderGrants, 1);
    assert.deepEqual(revoked, [unshared.refresh]);
    assert.equal(counts.senderAccounts, 3);
    assert.equal((await SenderAccount.findOne({ userId: other._id })).status, 'active');
  });

  it('account deletion still succeeds when Google cannot be reached', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const gone = await User.create({
      name: 'List Gone Two',
      email: `${prefix}-gone2@example.com`,
      passwordHash: await hashPassword('StrongPassword123!'),
    });
    await createAccount(gone);
    // No fake client: outbound Google requests are refused in tests, which must not block deletion
    const counts = await deleteAccountData(gone._id);
    assert.equal(counts.revokedSenderGrants, 0);
    assert.equal(counts.senderAccounts, 1);
    assert.equal(await User.exists({ _id: gone._id }), null);
  });
});
