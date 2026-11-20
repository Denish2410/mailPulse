import SenderAccount from '../models/SenderAccount.js';
import { getSenderUnusableReason } from './campaignSender.service.js';
import { releaseDailySlot, reserveDailySlot, waitForSenderSlot } from './senderQuota.service.js';

/**
 * Sender guard: what a dispatch must establish about its LOCKED sender before every delivery.
 *
 * A campaign is locked to one sender snapshot { accountId, googleSub, email } (written by the same
 * update that locks the recipient manifest). The guard never looks at any other account: the
 * snapshot names the account, the owner scopes the query, and the live record must still BE that
 * identity (same Google account, same address), connected and allowed to send.
 *
 * `beforeClaim()` runs before a delivery is claimed (so a campaign whose sender went away never
 * claims, and never loses, another recipient):
 *   1. the live account still matches the snapshot and can send,
 *   2. an access token can be obtained (a cached one, or a refresh; this is the only place a
 *      token refresh can fail before a message exists, so it can never be mistaken for a message
 *      that was submitted),
 *   3. one slot of the sender's conservative daily quota is reserved (senderQuota.service.js),
 *   4. the sender's own pacing is observed.
 * Any failure sets `stopReason`; the dispatch then stops claiming and pauses the campaign with
 * that reason. Nothing is ever retried or sent from another account.
 */

/** Pause reasons (stored on the campaign) and their customer-facing explanation. */
export const PAUSE_REASON_MESSAGES = Object.freeze({
  SENDER_DISCONNECTED: 'The sender Gmail account was disconnected. Reconnect the same account, then resume the campaign.',
  SENDER_REAUTH_REQUIRED: 'Google no longer accepts the sender Gmail account. Reconnect the same account, then resume the campaign.',
  SENDER_UNAVAILABLE: 'The sender Gmail account is not available. Check the account, then resume the campaign.',
  SENDER_IDENTITY_CHANGED: 'The sender account no longer matches the Gmail account this campaign was locked to. This campaign cannot be resumed from another account.',
  SENDER_SCOPE_MISSING: 'The sender Gmail account is no longer allowed to send email. Reconnect it and allow sending, then resume the campaign.',
  SENDER_TOKEN_REFRESH_FAILED: 'Gmail access could not be renewed. Check the connection, then resume the campaign.',
  SENDER_AUTH_FAILED: 'Gmail did not accept the sender credentials. Resume the campaign to try again with fresh credentials.',
  SEND_UNCERTAIN: "Gmail did not confirm the last message, so it may or may not have been sent. Check the sender's Sent folder, then resume the campaign.",
  GMAIL_RATE_LIMITED: 'Gmail is limiting sending for this account. Wait a while, then resume the campaign.',
  DAILY_QUOTA_REACHED: "This sender account reached MailPulse's conservative sending limit for the last 24 hours. Allowance returns gradually; resume the campaign later.",
});
export const PAUSE_REASONS = Object.freeze(Object.keys(PAUSE_REASON_MESSAGES));

const REASON_BY_ACCOUNT_CODE = {
  SENDER_NOT_FOUND: 'SENDER_UNAVAILABLE',
  SENDER_DISCONNECTED: 'SENDER_DISCONNECTED',
  SENDER_REAUTH_REQUIRED: 'SENDER_REAUTH_REQUIRED',
  SENDER_SCOPE_MISSING: 'SENDER_SCOPE_MISSING',
};

/** Maps an error thrown while getting an access token to a pause reason. */
export const pauseReasonForTokenError = (error) => {
  const code = error?.code ?? error?.reason;
  if (REASON_BY_ACCOUNT_CODE[code]) return REASON_BY_ACCOUNT_CODE[code];
  if (code === 'SENDER_TOKEN_REFRESH_FAILED' || code === 'SENDER_ACCOUNT_CHANGED') return 'SENDER_TOKEN_REFRESH_FAILED';
  return 'SENDER_UNAVAILABLE';
};

/**
 * @param {object} params
 * @param {any} params.campaignId
 * @param {any} params.userId campaign owner
 * @param {{ accountId: any, googleSub: string, email: string }} params.sender the locked snapshot
 * @param {{ ensureReady?: () => Promise<unknown> }} [params.emailService]
 * @param {object} [params.env]
 */
export const createSenderGuard = ({ userId, sender, emailService = null, env = process.env }) => {
  let stopReason = null;

  const stop = (reason) => {
    if (!stopReason) stopReason = reason;
    return false;
  };

  const verifyAccount = async () => {
    const account = await SenderAccount.findOne({ _id: sender.accountId, userId });
    const unusable = getSenderUnusableReason(account);
    if (unusable) return stop(REASON_BY_ACCOUNT_CODE[unusable.code] ?? 'SENDER_UNAVAILABLE');
    if (account.providerAccountId !== sender.googleSub || account.email !== sender.email) {
      return stop('SENDER_IDENTITY_CHANGED');
    }
    return true;
  };

  return {
    sender,
    get stopReason() {
      return stopReason;
    },
    get stopped() {
      return stopReason !== null;
    },
    /** Another worker of this dispatch (or an error mapped from a send) requested a stop. */
    stop,

    /**
     * @returns {Promise<false | { giveBack: () => Promise<void> }>} false when nothing may be
     *   claimed; otherwise a ticket for the reserved quota slot (a slot stays counted unless the
     *   caller gives it back because no delivery was claimed after all)
     */
    async beforeClaim() {
      if (stopReason) return false;
      if (!(await verifyAccount())) return false;
      if (typeof emailService?.ensureReady === 'function') {
        try {
          await emailService.ensureReady();
        } catch (error) {
          return stop(pauseReasonForTokenError(error));
        }
      }
      const slot = await reserveDailySlot(sender.accountId, { env });
      if (!slot.ok) {
        stop('DAILY_QUOTA_REACHED');
        return false;
      }
      let open = true;
      const ticket = {
        giveBack: async () => {
          if (!open) return;
          open = false;
          await releaseDailySlot(sender.accountId, slot.token);
        },
      };
      try {
        await waitForSenderSlot(sender.accountId, { env });
      } catch (error) {
        await ticket.giveBack();
        throw error;
      }
      return ticket;
    },

    /**
     * Re-check right before the message is handed to Gmail (after the claim). It looks only at the
     * ACCOUNT, not at `stopReason`: a stop requested by another worker (daily cap reached, a rate
     * limit) must not turn a delivery that was already claimed and legitimately reserved into a
     * failure. The account check is what makes a vanished sender stop an in-flight claim.
     */
    async verifyBeforeSend() {
      return verifyAccount();
    },
  };
};

export default { PAUSE_REASON_MESSAGES, PAUSE_REASONS, pauseReasonForTokenError, createSenderGuard };
