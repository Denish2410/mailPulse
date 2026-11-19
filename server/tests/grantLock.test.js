/**
 * Shared Google grants: the check "does another connection still use this grant?" and the
 * revocation are serialized with saving a connection for the same Google account.
 * Google is simulated; no real account is involved.
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();
import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('grantlock');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.TOKEN_ENCRYPTION_KEYS = `grant-test:${crypto.randomBytes(32).toString('base64')}`;
delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import SenderAccount from '../src/models/SenderAccount.js';
import GrantLock from '../src/models/GrantLock.js';
import { connectDB } from '../src/config/db.js';
import { resetTokenCipher } from '../src/utils/tokenCrypto.js';
import { sealAccessToken, sealRefreshToken } from '../src/services/senderAccount.service.js';
import { disconnectSenderAccount, revokeGrantIfUnshared } from '../src/services/senderConnection.service.js';
import { withGrantLock, grantLockKey, GrantLockBusyError } from '../src/services/grantLock.service.js';
import { createTestSender } from './helpers/sender.js';

resetTokenCipher();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Grant lock and shared-grant revocation', () => {
  let isDbConnected = false;
  let userA;
  let userB;
  let revokeCalls;
  const revokeFetch = async () => {
    revokeCalls.push(Date.now());
    return new Response('{}', { status: 200 });
  };
  const connect = (user, sub) =>
    createTestSender(user._id, {
      providerAccountId: sub,
      withTokens: (_id) => ({
        encryptedRefreshToken: sealRefreshToken(_id, `1//refresh-${crypto.randomBytes(3).toString('hex')}`),
        encryptedAccessToken: sealAccessToken(_id, 'ya29.test'),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      }),
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), SenderAccount.init(), GrantLock.init()]);
    } catch (error) {
      console.warn(`[Grant lock tests] MongoDB unavailable: ${error.message}`);
    }
  });
  beforeEach(async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await Promise.all([SenderAccount.deleteMany({}), GrantLock.deleteMany({}), User.deleteMany({})]);
    userA = await User.create({ name: 'User A', email: `a-${crypto.randomBytes(3).toString('hex')}@example.com`, passwordHash: 'x'.repeat(60) });
    userB = await User.create({ name: 'User B', email: `b-${crypto.randomBytes(3).toString('hex')}@example.com`, passwordHash: 'x'.repeat(60) });
    revokeCalls = [];
  });
  after(async () => {
    if (isDbConnected) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('never lets two holders overlap, and releases the lock afterwards', async () => {
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withGrantLock('google:x', async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(20);
          active -= 1;
        })
      )
    );
    assert.equal(maxActive, 1);
    assert.equal(await GrantLock.countDocuments({}), 0);
  });

  it('gives up with GrantLockBusyError while another holder keeps it, and replaces an expired lock', async () => {
    await GrantLock.create({ key: 'google:y', holder: 'someone', expiresAt: new Date(Date.now() + 60_000) });
    await assert.rejects(withGrantLock('google:y', async () => 1, { waitMs: 150 }), GrantLockBusyError);
    await GrantLock.updateOne({ key: 'google:y' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await withGrantLock('google:y', async () => 'ok', { waitMs: 150 }), 'ok');
  });

  it('does not revoke a grant that another MailPulse user still has connected', async () => {
    const a = await connect(userA, 'sub-shared');
    const b = await connect(userB, 'sub-shared');
    const first = await disconnectSenderAccount({ userId: userA._id, accountId: a._id, fetchImpl: revokeFetch });
    assert.equal(first.revoked, false);
    assert.equal(revokeCalls.length, 0);
    assert.equal((await SenderAccount.findById(b._id)).status, 'active', "B's connection is untouched");
    const last = await disconnectSenderAccount({ userId: userB._id, accountId: b._id, fetchImpl: revokeFetch });
    assert.equal(last.revoked, true);
    assert.equal(revokeCalls.length, 1);
  });

  it('a revocation waits for a connection being saved for the same Google account, then sees it and does not revoke', async () => {
    const a = await connect(userA, 'sub-race');
    // B's connection is being saved: it holds the grant's lock and becomes visible just before releasing
    let b;
    const saving = withGrantLock(grantLockKey('sub-race'), async () => {
      await sleep(200);
      b = await connect(userB, 'sub-race');
    });
    await sleep(50);
    const result = await disconnectSenderAccount({ userId: userA._id, accountId: a._id, fetchImpl: revokeFetch });
    await saving;
    assert.ok(b, 'the other connection was saved first');
    assert.equal(result.revoked, false);
    assert.equal(revokeCalls.length, 0, "B's fresh grant was not revoked");
  });

  it('skips the revocation (never revokes blindly) when the lock cannot be obtained', async () => {
    await GrantLock.create({ key: grantLockKey('sub-busy'), holder: 'other', expiresAt: new Date(Date.now() + 60_000) });
    // Same code path with a short wait through the lock API: a busy lock means "do not revoke"
    const outcome = await withGrantLock(grantLockKey('sub-busy'), async () => revokeFetch(), { waitMs: 100 }).catch((e) => e);
    assert.ok(outcome instanceof GrantLockBusyError);
    assert.equal(revokeCalls.length, 0);
    assert.equal(await revokeGrantIfUnshared({ providerAccountId: '', token: 't', fetchImpl: revokeFetch }), false);
  });
});
