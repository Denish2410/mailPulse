import crypto from 'node:crypto';
import mongoose from 'mongoose';
import SenderAccount from '../../src/models/SenderAccount.js';
import { GMAIL_SEND_SCOPE } from '../../src/config/googleOAuth.js';

/**
 * Test fixture: a connected Gmail sender account for `userId` (no real Google account, and no
 * tokens unless `withTokens` is given a function that seals them). Overrides win.
 */
export const createTestSender = async (userId, overrides = {}) => {
  const _id = overrides._id ?? new mongoose.Types.ObjectId();
  const { withTokens, ...rest } = overrides;
  const tokens = typeof withTokens === 'function' ? await withTokens(_id) : {};
  return SenderAccount.create({
    _id,
    userId,
    provider: 'google',
    providerAccountId: `sub-${crypto.randomBytes(6).toString('hex')}`,
    email: `sender-${crypto.randomBytes(4).toString('hex')}@example.com`,
    displayName: 'Test Sender',
    status: 'active',
    scopes: [GMAIL_SEND_SCOPE],
    connectedAt: new Date(),
    ...tokens,
    ...rest,
  });
};

export default { createTestSender };

/**
 * Test-only: makes `Campaign.create({ userId, ... })` attach a connected sender account of that
 * owner when the document does not say anything about `senderAccountId` (find-or-create, one per
 * owner). Production code has no such default; a test that wants "no sender" passes
 * `senderAccountId: null`.
 */
export const installAutoSender = (Campaign) => {
  if (Campaign.create.__autoSender) return;
  const original = Campaign.create.bind(Campaign);
  const patched = async (doc, ...rest) => {
    if (doc && !Array.isArray(doc) && typeof doc === 'object' && doc.userId && doc.senderAccountId === undefined) {
      let sender = await SenderAccount.findOne({ userId: doc.userId, status: 'active' });
      if (!sender) sender = await createTestSender(doc.userId);
      return original({ ...doc, senderAccountId: sender._id }, ...rest);
    }
    return original(doc, ...rest);
  };
  patched.__autoSender = true;
  Campaign.create = patched;
};
