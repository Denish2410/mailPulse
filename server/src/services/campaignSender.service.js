import mongoose from 'mongoose';
import SenderAccount from '../models/SenderAccount.js';
import { hasGmailSendScope } from './googleOAuth.service.js';

/**
 * A campaign's sender: exactly one customer-owned Gmail account, chosen explicitly.
 *
 * - The account is always looked up with the campaign owner's ID, so another tenant's account
 *   behaves exactly like one that does not exist.
 * - Only an `active` account that was granted gmail.send can be selected or used. There is no
 *   default sender, no automatic choice and no fallback to another account, ever.
 * - Responses carry a small allow-listed summary, never tokens.
 */

export class CampaignSenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CampaignSenderError';
    this.code = code;
  }
}

const MESSAGES = {
  SENDER_REQUIRED: 'Select the Gmail account this campaign is sent from.',
  SENDER_NOT_FOUND: 'The selected sender account was not found.',
  SENDER_DISCONNECTED: 'The selected sender account is disconnected. Connect it again or choose another account.',
  SENDER_REAUTH_REQUIRED: 'Google no longer accepts the selected sender account. Reconnect it or choose another account.',
  SENDER_SCOPE_MISSING: 'The selected sender account is not allowed to send email. Reconnect it and allow sending.',
};

const isValidId = (id) =>
  (typeof id === 'string' || id instanceof mongoose.Types.ObjectId) && mongoose.isValidObjectId(id);

/**
 * Why an account cannot send, or null when it can.
 *
 * @returns {null | { code: string, message: string }}
 */
export const getSenderUnusableReason = (account) => {
  if (!account) return { code: 'SENDER_NOT_FOUND', message: MESSAGES.SENDER_NOT_FOUND };
  if (account.status === 'disconnected') return { code: 'SENDER_DISCONNECTED', message: MESSAGES.SENDER_DISCONNECTED };
  if (account.status !== 'active') return { code: 'SENDER_REAUTH_REQUIRED', message: MESSAGES.SENDER_REAUTH_REQUIRED };
  if (account.provider !== 'google' || !hasGmailSendScope(account.scopes)) {
    return { code: 'SENDER_SCOPE_MISSING', message: MESSAGES.SENDER_SCOPE_MISSING };
  }
  return null;
};

/**
 * Loads the owner's sender account and checks it can be used (tokens are NOT selected).
 *
 * @returns {Promise<import('mongoose').Document>}
 * @throws {CampaignSenderError}
 */
export const requireUsableSender = async (userId, senderAccountId) => {
  if (!senderAccountId) throw new CampaignSenderError('SENDER_REQUIRED', MESSAGES.SENDER_REQUIRED);
  const account =
    isValidId(userId) && isValidId(senderAccountId)
      ? await SenderAccount.findOne({ _id: senderAccountId, userId })
      : null;
  const reason = getSenderUnusableReason(account);
  if (reason) throw new CampaignSenderError(reason.code, reason.message);
  return account;
};

/** Client-safe sender summary (explicit allow-list; no tokens, no provider IDs). */
export const formatSenderSummary = (account) => ({
  id: String(account._id),
  email: account.email,
  displayName: account.displayName ?? '',
  status: account.status,
  statusReason: account.statusReason ?? null,
  canSend: getSenderUnusableReason(account) === null,
});

/**
 * Sender summaries for a set of campaigns, keyed by sender account ID (one query, owner-scoped).
 *
 * @returns {Promise<Map<string, object>>}
 */
export const loadSenderSummaries = async (userId, campaigns) => {
  const ids = [
    ...new Set(
      campaigns
        .map((campaign) => campaign?.senderAccountId)
        .filter(Boolean)
        .map(String)
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  if (ids.length === 0) return new Map();
  const accounts = await SenderAccount.find({ _id: { $in: ids }, userId });
  return new Map(accounts.map((account) => [String(account._id), formatSenderSummary(account)]));
};

/**
 * Readiness issue for a campaign's sender, or null. Read-only: it never selects anything.
 *
 * @returns {Promise<string|null>}
 */
export const getSenderReadinessIssue = async (campaign, userId) => {
  try {
    await requireUsableSender(userId, campaign?.senderAccountId);
    return null;
  } catch (error) {
    if (error instanceof CampaignSenderError) return error.message;
    throw error;
  }
};

export default {
  CampaignSenderError,
  getSenderUnusableReason,
  requireUsableSender,
  formatSenderSummary,
  loadSenderSummaries,
  getSenderReadinessIssue,
};
