/**
 * SenderAccount model and tenant-scoped access (customer-owned Gmail mailboxes).
 * Uses a disposable random encryption key and made-up token strings; no Google, no network.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.TOKEN_ENCRYPTION_KEYS = `sa-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import SenderAccount from '../src/models/SenderAccount.js';
import { connectDB } from '../src/config/db.js';
import { resetTokenCipher, TokenEncryptionError } from '../src/utils/tokenCrypto.js';
import { hashPassword } from '../src/services/password.service.js';
import { buildAccountExport, deleteAccountData } from '../src/services/account.service.js';
import {
  sealRefreshToken,
  sealAccessToken,
  openRefreshToken,
  openAccessToken,
  findOwnedSenderAccount,
  listOwnedSenderAccounts,
  formatSafeSenderAccount,
} from '../src/services/senderAccount.service.js';

resetTokenCipher();

const fakeRefresh = () => `1//test-only-refresh-${crypto.randomBytes(16).toString('hex')}`;
const fakeAccess = () => `ya29.test-only-access-${crypto.randomBytes(16).toString('hex')}`;

describe('Sender accounts', () => {
  let isDbConnected = false;
  const prefix = `sa-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let owner;
  let other;

  /** Creates an account the way the OAuth callback will: _id first, then tokens sealed to it. */
  const createAccount = async (user, overrides = {}, tokens = {}) => {
    const _id = new mongoose.Types.ObjectId();
    const refresh = tokens.refresh ?? fakeRefresh();
    const access = tokens.access ?? fakeAccess();
    await SenderAccount.create({
      _id,
      userId: user._id,
      provider: 'google',
      providerAccountId: `sub-${crypto.randomBytes(6).toString('hex')}`,
      email: `${prefix}-${crypto.randomBytes(3).toString('hex')}@gmail.example.com`,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      encryptedRefreshToken: sealRefreshToken(_id, refresh),
      encryptedAccessToken: sealAccessToken(_id, access),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      connectedAt: new Date(),
      ...overrides,
    });
    return { id: _id, refresh, access };
  };

  before(async () => {
    try {
      await connectDB();
      await SenderAccount.init();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Sender Account Tests] MongoDB unavailable: ${err.message}`);
      return;
    }
    const passwordHash = await hashPassword('StrongPassword123!');
    owner = await User.create({ name: 'Sender Owner', email: `${prefix}-owner@example.com`, passwordHash });
    other = await User.create({ name: 'Sender Other', email: `${prefix}-other@example.com`, passwordHash });
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

  it('stores tokens only as encrypted envelopes and never returns them by default', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { id, refresh, access } = await createAccount(owner);

    const raw = await SenderAccount.collection.findOne({ _id: id });
    assert.match(raw.encryptedRefreshToken, /^mpt1\.sa-test\./);
    assert.match(raw.encryptedAccessToken, /^mpt1\.sa-test\./);
    assert.ok(!JSON.stringify(raw).includes(refresh), 'no plaintext refresh token in the database');
    assert.ok(!JSON.stringify(raw).includes(access), 'no plaintext access token in the database');

    const plain = await SenderAccount.findById(id);
    assert.equal(plain.encryptedRefreshToken, undefined);
    assert.equal(plain.encryptedAccessToken, undefined);
    const lean = await SenderAccount.findById(id).lean();
    assert.equal(lean.encryptedRefreshToken, undefined);
  });

  it('strips tokens from JSON even when they were explicitly selected', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { id } = await createAccount(owner);
    const withTokens = await SenderAccount.findById(id).select('+encryptedRefreshToken +encryptedAccessToken +accessTokenExpiresAt');
    assert.match(withTokens.encryptedRefreshToken, /^mpt1\./);
    const json = JSON.stringify(withTokens);
    assert.ok(!json.includes('mpt1.'), 'serialized document carries no token envelope');
    assert.equal(withTokens.toObject().encryptedRefreshToken, undefined);
    const safe = formatSafeSenderAccount(withTokens);
    assert.ok(!JSON.stringify(safe).includes('mpt1.'));
    assert.deepEqual(Object.keys(safe).sort(), [
      'canSend', 'connectedAt', 'createdAt', 'disconnectedAt', 'displayName', 'email', 'id',
      'provider', 'scopes', 'status', 'statusChangedAt', 'statusReason', 'updatedAt',
    ]);
    assert.equal(safe.canSend, true);
  });

  it('decrypts tokens only for the account they were sealed to, and only as the right kind', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const a = await createAccount(owner);
    const b = await createAccount(owner);
    const docA = await SenderAccount.findById(a.id).select('+encryptedRefreshToken +encryptedAccessToken');
    assert.equal(openRefreshToken(a.id, docA.encryptedRefreshToken), a.refresh);
    assert.equal(openAccessToken(a.id, docA.encryptedAccessToken), a.access);
    // Copied to another account, or swapped between fields: refused
    assert.throws(() => openRefreshToken(b.id, docA.encryptedRefreshToken), TokenEncryptionError);
    assert.throws(() => openRefreshToken(a.id, docA.encryptedAccessToken), TokenEncryptionError);
    assert.throws(() => openAccessToken(a.id, docA.encryptedRefreshToken), TokenEncryptionError);
  });

  it('refuses to store a plaintext token', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await assert.rejects(
      createAccount(owner, { encryptedRefreshToken: fakeRefresh() }),
      (error) => error.name === 'ValidationError' && !String(error.message).includes('1//test-only')
    );
    await assert.rejects(createAccount(owner, { encryptedAccessToken: fakeAccess() }), { name: 'ValidationError' });
  });

  it('validates provider, status, email and status reason', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await assert.rejects(createAccount(owner, { provider: 'smtp' }), { name: 'ValidationError' });
    await assert.rejects(createAccount(owner, { status: 'paused' }), { name: 'ValidationError' });
    await assert.rejects(createAccount(owner, { email: 'not-an-email' }), { name: 'ValidationError' });
    await assert.rejects(createAccount(owner, { statusReason: 'free text with spaces' }), { name: 'ValidationError' });
    await createAccount(owner, { status: 'reauth_required', statusReason: 'TOKEN_REVOKED' });
  });

  it('allows one record per Google account per user, and the same Google account for two users', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await createAccount(owner, { providerAccountId: 'sub-shared' });
    await assert.rejects(createAccount(owner, { providerAccountId: 'sub-shared' }), (error) => error.code === 11000);
    await createAccount(other, { providerAccountId: 'sub-shared' });
    assert.equal(await SenderAccount.countDocuments({ providerAccountId: 'sub-shared', userId: { $in: [owner._id, other._id] } }), 2);
  });

  it('tenant isolation: another owner\'s account looks exactly like a missing one', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const mine = await createAccount(owner);
    const theirs = await createAccount(other);

    assert.equal(String((await findOwnedSenderAccount(owner._id, mine.id))._id), String(mine.id));
    assert.equal(await findOwnedSenderAccount(owner._id, theirs.id), null);
    assert.equal(await findOwnedSenderAccount(owner._id, new mongoose.Types.ObjectId()), null);
    assert.equal(await findOwnedSenderAccount(owner._id, 'not-an-id'), null);
    assert.equal(await findOwnedSenderAccount('not-an-id', mine.id), null);
    assert.equal(await findOwnedSenderAccount(owner._id, { $ne: null }), null, 'operator objects are refused');

    const listed = await listOwnedSenderAccounts(owner._id);
    assert.deepEqual(listed.map((a) => String(a._id)), [String(mine.id)]);
    assert.equal(listed[0].encryptedRefreshToken, undefined);
  });

  it('account export lists sender accounts without tokens; deletion removes only the owner\'s', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const mine = await createAccount(owner);
    await createAccount(other);

    const exported = await buildAccountExport(owner._id);
    assert.equal(exported.senderAccounts.length, 1);
    assert.equal(String(exported.senderAccounts[0]._id), String(mine.id));
    const text = JSON.stringify(exported);
    assert.ok(!text.includes('mpt1.'), 'no token envelope in the export');
    assert.ok(!text.includes(mine.refresh) && !text.includes(mine.access));
    assert.ok(!('encryptedRefreshToken' in exported.senderAccounts[0]));
    assert.ok(!('accessTokenExpiresAt' in exported.senderAccounts[0]));

    // deleteAccountData also deletes the user; use a throwaway user so `owner` stays for other tests
    const throwaway = await User.create({
      name: 'Sender Throwaway',
      email: `${prefix}-gone@example.com`,
      passwordHash: await hashPassword('StrongPassword123!'),
    });
    await createAccount(throwaway);
    const counts = await deleteAccountData(throwaway._id);
    assert.equal(counts.senderAccounts, 1);
    assert.equal(await SenderAccount.countDocuments({ userId: throwaway._id }), 0);
    assert.equal(await SenderAccount.countDocuments({ userId: owner._id }), 1);
    assert.equal(await SenderAccount.countDocuments({ userId: other._id }), 1);
  });
});
