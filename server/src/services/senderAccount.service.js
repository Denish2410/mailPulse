import mongoose from 'mongoose';
import SenderAccount from '../models/SenderAccount.js';
import { encryptToken, decryptToken } from '../utils/tokenCrypto.js';

/**
 * Sender accounts: tenant-scoped access and token sealing.
 *
 * Every lookup here takes the owner's userId and includes it in the query, so an account ID from
 * another tenant behaves exactly like one that does not exist. Tokens are sealed with an
 * encryption context naming the account and the token kind: an envelope copied to another
 * account, or from the access-token field to the refresh-token field, does not decrypt.
 */

export const MAX_SENDER_ACCOUNTS_PER_USER = 10;

export const refreshTokenContext = (accountId) => `sender-account:${String(accountId)}:refresh-token`;
export const accessTokenContext = (accountId) => `sender-account:${String(accountId)}:access-token`;

/** @returns {string} encrypted envelope */
export const sealRefreshToken = (accountId, refreshToken) =>
  encryptToken(refreshToken, { context: refreshTokenContext(accountId) });
/** @returns {string} encrypted envelope */
export const sealAccessToken = (accountId, accessToken) =>
  encryptToken(accessToken, { context: accessTokenContext(accountId) });
/** @returns {string} plaintext token (keep it in memory only) */
export const openRefreshToken = (accountId, envelope) =>
  decryptToken(envelope, { context: refreshTokenContext(accountId) });
/** @returns {string} plaintext token (keep it in memory only) */
export const openAccessToken = (accountId, envelope) =>
  decryptToken(envelope, { context: accessTokenContext(accountId) });

const isValidId = (id) =>
  (typeof id === 'string' || id instanceof mongoose.Types.ObjectId) && mongoose.isValidObjectId(id);

/**
 * Loads one sender account of one owner (tokens are NOT selected).
 * Returns null for a malformed ID, a missing account and another owner's account alike.
 */
export const findOwnedSenderAccount = async (userId, accountId) => {
  if (!isValidId(userId) || !isValidId(accountId)) return null;
  return SenderAccount.findOne({ _id: accountId, userId });
};

/** Lists an owner's sender accounts, newest first (tokens are NOT selected). */
export const listOwnedSenderAccounts = async (userId) => {
  if (!isValidId(userId)) return [];
  return SenderAccount.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(MAX_SENDER_ACCOUNTS_PER_USER * 5);
};

/**
 * Client-safe representation. Built from an explicit allow-list, so a token field can never
 * leak even from a document that was loaded with tokens selected.
 */
export const formatSafeSenderAccount = (account) => {
  const doc = typeof account?.toObject === 'function' ? account.toObject() : account;
  return {
    id: String(doc._id),
    provider: doc.provider,
    email: doc.email,
    displayName: doc.displayName ?? '',
    status: doc.status,
    statusReason: doc.statusReason ?? null,
    canSend: doc.status === 'active',
    scopes: Array.isArray(doc.scopes) ? [...doc.scopes] : [],
    connectedAt: doc.connectedAt ?? null,
    statusChangedAt: doc.statusChangedAt ?? null,
    disconnectedAt: doc.disconnectedAt ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
};

export default {
  MAX_SENDER_ACCOUNTS_PER_USER,
  refreshTokenContext,
  accessTokenContext,
  sealRefreshToken,
  sealAccessToken,
  openRefreshToken,
  openAccessToken,
  findOwnedSenderAccount,
  listOwnedSenderAccounts,
  formatSafeSenderAccount,
};
