import mongoose from 'mongoose';
import Contact from '../models/Contact.js';

/**
 * Campaign Readiness Evaluation (shared by the readiness endpoint and the send endpoint)
 *
 * Keeping one implementation guarantees that "the preview says ready" and "the server agrees to
 * send" can never drift apart.
 */

/**
 * Evaluates whether a campaign can be sent and resolves its eligible recipients.
 *
 * Recipients are resolved strictly against contacts owned by `userId`; deleted or foreign
 * contact IDs are counted as missing and never sent to.
 *
 * @param {object} campaign - Campaign document or plain object
 * @param {string|import('mongoose').Types.ObjectId} userId - Authenticated owner
 * @returns {Promise<{
 *   isReady: boolean,
 *   issues: string[],
 *   eligibleContacts: Array<{ _id: import('mongoose').Types.ObjectId, name: string, email: string }>,
 *   summary: {
 *     totalRecipients: number,
 *     eligibleRecipients: Array<{ id: string, name: string, email: string }>,
 *     eligibleRecipientsCount: number,
 *     missingRecipientsCount: number,
 *     hasTextContent: boolean,
 *     hasHtmlContent: boolean,
 *     status: string,
 *   }
 * }>}
 */
export const evaluateCampaignReadiness = async (campaign, userId) => {
  const issues = [];

  // 1. Name constraints
  const trimmedName = typeof campaign.name === 'string' ? campaign.name.trim() : '';
  if (!trimmedName || trimmedName.length < 2) {
    issues.push('Campaign name must be at least 2 characters long.');
  } else if (trimmedName.length > 120) {
    issues.push('Campaign name cannot exceed 120 characters.');
  }

  // 2. Subject constraints
  const trimmedSubject = typeof campaign.subject === 'string' ? campaign.subject.trim() : '';
  if (!trimmedSubject || trimmedSubject.length < 1) {
    issues.push('Email subject cannot be empty.');
  } else if (trimmedSubject.length > 200) {
    issues.push('Email subject cannot exceed 200 characters.');
  }

  // 3. Content presence (at least one non-whitespace body)
  const hasTextContent =
    typeof campaign.textContent === 'string' && campaign.textContent.trim().length > 0;
  const hasHtmlContent =
    typeof campaign.htmlContent === 'string' && campaign.htmlContent.trim().length > 0;

  if (!hasTextContent && !hasHtmlContent) {
    issues.push('Campaign must have non-empty text content or HTML content.');
  }

  // 4. Status (must be draft)
  if (campaign.status !== 'draft') {
    issues.push('Only draft campaigns can be evaluated for readiness.');
  }

  // 5. Recipients: deduplicate stored IDs and resolve only contacts owned by the user
  const rawRecipientIds = Array.isArray(campaign.recipientIds) ? campaign.recipientIds : [];
  const uniqueRecipientIds = [
    ...new Set(
      rawRecipientIds
        .map((rId) => (rId?._id || rId)?.toString())
        .filter((rId) => typeof rId === 'string' && mongoose.isValidObjectId(rId))
    ),
  ];

  const totalRecipients = uniqueRecipientIds.length;

  let eligibleContacts = [];
  if (totalRecipients > 0) {
    eligibleContacts = await Contact.find({
      _id: { $in: uniqueRecipientIds },
      userId,
    })
      .select('name email')
      .sort({ createdAt: -1, _id: -1 })
      .lean();
  }

  const eligibleRecipients = eligibleContacts.map((contact) => ({
    id: contact._id.toString(),
    name: contact.name,
    email: contact.email,
  }));

  const eligibleRecipientsCount = eligibleRecipients.length;
  const missingRecipientsCount = Math.max(0, totalRecipients - eligibleRecipientsCount);

  if (eligibleRecipientsCount === 0) {
    issues.push('Campaign must have at least one eligible recipient.');
  }

  return {
    isReady: issues.length === 0,
    issues,
    eligibleContacts,
    summary: {
      totalRecipients,
      eligibleRecipients,
      eligibleRecipientsCount,
      missingRecipientsCount,
      hasTextContent,
      hasHtmlContent,
      status: campaign.status,
    },
  };
};

export default { evaluateCampaignReadiness };
