import Campaign from '../models/Campaign.js';
import SenderAccount from '../models/SenderAccount.js';
import { getSenderUnusableReason } from './campaignSender.service.js';
import { PAUSE_REASON_MESSAGES } from './campaignSenderGuard.service.js';

/**
 * Explicit resume of a paused campaign.
 *
 * A campaign pauses when its locked sender can no longer be used. Reconnecting that Google
 * account, or anything else, never resumes it; only this owner action does, and only when the
 * campaign's LOCKED sender is usable again AS THE SAME IDENTITY:
 *   - the account record named by the snapshot still belongs to this owner,
 *   - it is the same Google account (sub) and the same address,
 *   - it is connected and allowed to send.
 * Anything else is refused with the reason. A different account is never substituted; the
 * campaign cannot be moved to one (create a new campaign for that).
 *
 * Resuming flips 'paused' to 'sending' with no lease owner and an already-ended lease, so the
 * worker's normal recovery (watchdog) takes it over under a new epoch, fences, and sends only the
 * deliveries that are still pending. Sent and uncertain deliveries are never touched or re-sent.
 */

export class CampaignResumeError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = 'CampaignResumeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * @param {{ campaignId: any, userId: any }} params
 * @returns {Promise<import('mongoose').Document>} the campaign, now 'sending'
 * @throws {CampaignResumeError}
 */
export const resumePausedCampaign = async ({ campaignId, userId }) => {
  const campaign = await Campaign.findOne({ _id: campaignId, userId });
  if (!campaign) throw new CampaignResumeError('NOT_FOUND', 404, 'Campaign not found.');
  if (campaign.status !== 'paused') {
    throw new CampaignResumeError('NOT_PAUSED', 409, 'Only a paused campaign can be resumed.');
  }
  const snapshot = campaign.dispatchSender;
  if (!snapshot?.accountId) {
    throw new CampaignResumeError('NO_LOCKED_SENDER', 409, 'This campaign has no locked sender account, so it cannot be resumed.');
  }

  const account = await SenderAccount.findOne({ _id: snapshot.accountId, userId });
  const unusable = getSenderUnusableReason(account);
  if (unusable) {
    throw new CampaignResumeError(
      unusable.code,
      409,
      `${unusable.message} This campaign can only be resumed from the same Gmail account (${snapshot.email}).`
    );
  }
  if (account.providerAccountId !== snapshot.googleSub || account.email !== snapshot.email) {
    throw new CampaignResumeError(
      'SENDER_IDENTITY_CHANGED',
      409,
      `This campaign was locked to ${snapshot.email}, and that Gmail account is no longer what this sender account refers to. It cannot be resumed from another account.`
    );
  }

  // Atomic: only the exact paused state that was checked. A concurrent resume wins once.
  const resumed = await Campaign.findOneAndUpdate(
    { _id: campaign._id, userId, status: 'paused', pauseReason: campaign.pauseReason, 'dispatchSender.accountId': snapshot.accountId },
    [
      {
        $set: {
          status: 'sending',
          pauseReason: null,
          pausedAt: null,
          updatedAt: '$$NOW',
          dispatchLeaseUntil: '$$NOW', // an ended lease: listed by the watchdog at its next sweep
        },
      },
      { $unset: 'dispatchLeaseOwner' },
    ],
    { new: true }
  );
  if (!resumed) {
    throw new CampaignResumeError('CONFLICT', 409, 'The campaign changed while it was being resumed. Refresh and try again.');
  }
  return resumed;
};

export const describePause = (campaign) =>
  campaign?.status === 'paused' && campaign.pauseReason
    ? {
        reason: campaign.pauseReason,
        message:
          PAUSE_REASON_MESSAGES[campaign.pauseReason] ??
          'This campaign was paused. Check its sender account, then resume it.',
        pausedAt: campaign.pausedAt ?? null,
      }
    : null;

export default { CampaignResumeError, resumePausedCampaign, describePause };
