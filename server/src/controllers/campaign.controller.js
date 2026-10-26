import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Contact from '../models/Contact.js';
import User from '../models/User.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createEmailService,
  InvalidMessageError,
  EmailConfigurationError,
  EmailTransportError,
} from '../services/email.service.js';

/**
 * Format a Mongoose Campaign document into a safe, client-facing representation.
 *
 * @param {import('../models/Campaign.js').default|object} campaign
 * @returns {object} Safe campaign payload
 */
export const formatSafeCampaign = (campaign) => {
  const doc = campaign.toObject ? campaign.toObject() : { ...campaign };
  const idStr = (doc._id || doc.id).toString();

  const recipientIds = Array.isArray(doc.recipientIds)
    ? doc.recipientIds.map((rId) => (rId._id || rId).toString())
    : [];

  return {
    id: idStr,
    name: doc.name,
    subject: doc.subject,
    textContent: doc.textContent ?? '',
    htmlContent: doc.htmlContent ?? '',
    status: doc.status,
    recipientIds,
    recipientsCount: recipientIds.length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

/**
 * Escape regular expression special characters to ensure literal substring matching.
 *
 * @param {string} string - Raw string to escape
 * @returns {string} Regex-escaped string
 */
export const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Validates that all recipient IDs in the list belong to the authenticated owner.
 * Deduplicates the IDs before verifying and returns the array of unique ObjectId strings.
 *
 * @param {string[]} rawRecipientIds - Array of contact ID strings
 * @param {string} userId - Authenticated user ObjectId
 * @returns {Promise<string[]>} Array of unique contact IDs
 * @throws {AppError} 400 if any recipient does not exist or is not owned by userId
 */
export const validateAndDeduplicateRecipients = async (rawRecipientIds, userId) => {
  if (!Array.isArray(rawRecipientIds) || rawRecipientIds.length === 0) {
    return [];
  }

  // Deduplicate IDs consistently
  const uniqueIds = [...new Set(rawRecipientIds.map((id) => id.toString()))];

  // Verify all unique contact IDs exist and belong to the authenticated user
  const ownedContactsCount = await Contact.countDocuments({
    _id: { $in: uniqueIds },
    userId,
  });

  if (ownedContactsCount !== uniqueIds.length) {
    throw new AppError('One or more selected recipients are invalid or not owned by you.', 400);
  }

  return uniqueIds;
};

/**
 * Create a new campaign draft belonging to the authenticated user.
 *
 * Route: POST /api/v1/campaigns
 * Access: Protected (Bearer JWT)
 */
export const createCampaign = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { name, subject, textContent = '', htmlContent = '', recipientIds = [] } = req.body;

  // Validate recipient ownership and deduplicate
  const verifiedRecipientIds = await validateAndDeduplicateRecipients(recipientIds, userId);

  const campaign = await Campaign.create({
    userId,
    name: name.trim(),
    subject: subject.trim(),
    textContent,
    htmlContent,
    status: 'draft',
    recipientIds: verifiedRecipientIds,
  });

  res.status(201).json({
    success: true,
    message: 'Campaign draft created successfully',
    data: {
      campaign: formatSafeCampaign(campaign),
    },
  });
});

/**
 * Retrieve campaigns belonging to the authenticated user with pagination, search, and status filtering.
 *
 * Route: GET /api/v1/campaigns
 * Access: Protected (Bearer JWT)
 */
export const getCampaigns = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { page = 1, limit = 20, search, status } = req.query;

  // Build filter scoped strictly to the authenticated owner
  const filter = { userId };
  const conditions = [];

  // 1. Optional case-insensitive search by name or subject
  if (search && typeof search === 'string' && search.trim().length > 0) {
    const searchRegex = new RegExp(escapeRegex(search.trim()), 'i');
    conditions.push({
      $or: [{ name: searchRegex }, { subject: searchRegex }],
    });
  }

  // 2. Optional status filter (draft)
  if (status && typeof status === 'string' && status.trim().length > 0) {
    conditions.push({ status: status.trim() });
  }

  if (conditions.length === 1) {
    Object.assign(filter, conditions[0]);
  } else if (conditions.length > 1) {
    filter.$and = conditions;
  }

  const skip = (page - 1) * limit;

  // Execute query and document count concurrently using identical filter
  const [campaigns, total] = await Promise.all([
    Campaign.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Campaign.countDocuments(filter),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const hasNextPage = page < totalPages;
  const hasPrevPage = page > 1 && total > 0;

  res.status(200).json({
    success: true,
    message: 'Campaigns retrieved successfully',
    data: {
      campaigns: campaigns.map(formatSafeCampaign),
      count: campaigns.length,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage,
        hasPrevPage,
      },
    },
  });
});

/**
 * Retrieve a single campaign belonging to the authenticated user.
 *
 * Route: GET /api/v1/campaigns/:id
 * Access: Protected (Bearer JWT)
 */
export const getCampaignById = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { id } = req.params;

  // Query scoped strictly to { _id: id, userId } to prevent cross-tenant disclosure
  const campaign = await Campaign.findOne({ _id: id, userId });
  if (!campaign) {
    throw new AppError('Campaign not found.', 404);
  }

  res.status(200).json({
    success: true,
    message: 'Campaign retrieved successfully',
    data: {
      campaign: formatSafeCampaign(campaign),
    },
  });
});

/**
 * Update an existing campaign draft belonging to the authenticated user.
 *
 * Route: PATCH /api/v1/campaigns/:id
 * Access: Protected (Bearer JWT)
 */
export const updateCampaign = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { id } = req.params;
  const { name, subject, textContent, htmlContent, recipientIds } = req.body;

  // Query scoped strictly to owner
  const campaign = await Campaign.findOne({ _id: id, userId });
  if (!campaign) {
    throw new AppError('Campaign not found.', 404);
  }

  // Update name if provided
  if (name !== undefined) {
    campaign.name = name.trim();
  }

  // Update subject if provided
  if (subject !== undefined) {
    campaign.subject = subject.trim();
  }

  // Update textContent if provided (allows explicit '' to clear content)
  if (textContent !== undefined) {
    campaign.textContent = textContent;
  }

  // Update htmlContent if provided (allows explicit '' to clear content)
  if (htmlContent !== undefined) {
    campaign.htmlContent = htmlContent;
  }

  // Update recipientIds if provided (allows explicit [] to clear selection)
  // Preserves existing stored IDs if recipientIds was omitted in req.body
  if (recipientIds !== undefined) {
    const verifiedRecipientIds = await validateAndDeduplicateRecipients(recipientIds, userId);
    campaign.recipientIds = verifiedRecipientIds;
  }

  await campaign.save();

  res.status(200).json({
    success: true,
    message: 'Campaign updated successfully',
    data: {
      campaign: formatSafeCampaign(campaign),
    },
  });
});

/**
 * Delete a campaign draft belonging to the authenticated user.
 *
 * Route: DELETE /api/v1/campaigns/:id
 * Access: Protected (Bearer JWT)
 */
export const deleteCampaign = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { id } = req.params;

  // Delete scoped strictly to owner
  const deleted = await Campaign.findOneAndDelete({ _id: id, userId });
  if (!deleted) {
    throw new AppError('Campaign not found.', 404);
  }

  res.status(200).json({
    success: true,
    message: 'Campaign deleted successfully',
  });
});

/**
 * Evaluate the send-readiness of a campaign draft belonging to the authenticated user.
 *
 * Route: GET /api/v1/campaigns/:id/readiness
 * Access: Protected (Bearer JWT)
 */
export const getCampaignReadiness = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { id } = req.params;

  // Retrieve campaign strictly scoped to the authenticated owner
  const campaign = await Campaign.findOne({ _id: id, userId });
  if (!campaign) {
    throw new AppError('Campaign not found.', 404);
  }

  const issues = [];

  // 1. Evaluate name constraints
  const trimmedName = typeof campaign.name === 'string' ? campaign.name.trim() : '';
  if (!trimmedName || trimmedName.length < 2) {
    issues.push('Campaign name must be at least 2 characters long.');
  } else if (trimmedName.length > 120) {
    issues.push('Campaign name cannot exceed 120 characters.');
  }

  // 2. Evaluate subject constraints
  const trimmedSubject = typeof campaign.subject === 'string' ? campaign.subject.trim() : '';
  if (!trimmedSubject || trimmedSubject.length < 1) {
    issues.push('Email subject cannot be empty.');
  } else if (trimmedSubject.length > 200) {
    issues.push('Email subject cannot exceed 200 characters.');
  }

  // 3. Evaluate content presence (at least one of textContent or htmlContent must have non-whitespace content)
  const hasTextContent =
    typeof campaign.textContent === 'string' && campaign.textContent.trim().length > 0;
  const hasHtmlContent =
    typeof campaign.htmlContent === 'string' && campaign.htmlContent.trim().length > 0;

  if (!hasTextContent && !hasHtmlContent) {
    issues.push('Campaign must have non-empty text content or HTML content.');
  }

  // 4. Evaluate status (must be draft)
  if (campaign.status !== 'draft') {
    issues.push('Only draft campaigns can be evaluated for readiness.');
  }

  // 5. Evaluate recipients
  // Deduplicate stored recipient IDs to compute exact unique IDs evaluated
  const rawRecipientIds = Array.isArray(campaign.recipientIds) ? campaign.recipientIds : [];
  const uniqueRecipientIds = [
    ...new Set(
      rawRecipientIds
        .map((rId) => (rId._id || rId).toString())
        .filter((rId) => mongoose.isValidObjectId(rId))
    ),
  ];

  const totalRecipients = uniqueRecipientIds.length;

  let eligibleRecipients = [];
  if (totalRecipients > 0) {
    // Query contacts strictly belonging to the authenticated owner
    const contacts = await Contact.find({
      _id: { $in: uniqueRecipientIds },
      userId,
    }).sort({ createdAt: -1, _id: -1 });

    eligibleRecipients = contacts.map((contact) => ({
      id: contact._id.toString(),
      name: contact.name,
      email: contact.email,
    }));
  }

  const eligibleRecipientsCount = eligibleRecipients.length;
  const missingRecipientsCount = Math.max(0, totalRecipients - eligibleRecipientsCount);

  if (eligibleRecipientsCount === 0) {
    issues.push('Campaign must have at least one eligible recipient.');
  }

  const isReady = issues.length === 0;

  res.status(200).json({
    success: true,
    message: isReady ? 'Campaign is ready for sending' : 'Campaign is not ready for sending',
    data: {
      isReady,
      issues,
      summary: {
        totalRecipients,
        eligibleRecipients,
        eligibleRecipientsCount,
        missingRecipientsCount,
        hasTextContent,
        hasHtmlContent,
        status: campaign.status,
      },
    },
  });
});

/**
 * Subject prefix applied to every campaign test email.
 */
export const TEST_EMAIL_SUBJECT_PREFIX = '[TEST] ';

/**
 * Maximum subject length accepted by the email service (mirrors Campaign.subject).
 */
const MAX_EMAIL_SUBJECT_LENGTH = 200;

/**
 * Builds the test email subject by prefixing "[TEST] " and truncating the original
 * subject so the result never exceeds the email service's 200-character limit.
 *
 * @param {string} subject - Stored campaign subject
 * @returns {string}
 */
export const buildTestEmailSubject = (subject) => {
  const base = typeof subject === 'string' ? subject.trim() : '';
  const available = MAX_EMAIL_SUBJECT_LENGTH - TEST_EMAIL_SUBJECT_PREFIX.length;
  return `${TEST_EMAIL_SUBJECT_PREFIX}${base.slice(0, available).trimEnd()}`;
};

/**
 * Evaluates whether a campaign has the content required to send a test email.
 * Unlike send-readiness, recipients are intentionally NOT required: test emails only
 * ever go to the authenticated user's own account address.
 *
 * @param {object} campaign - Plain campaign object
 * @returns {Array<{ path: string, message: string }>} Structured issues (empty when sendable)
 */
export const getTestEmailContentIssues = (campaign) => {
  const issues = [];

  const name = typeof campaign.name === 'string' ? campaign.name.trim() : '';
  if (name.length < 2 || name.length > 120) {
    issues.push({
      path: 'campaign.name',
      message: 'Campaign name must be between 2 and 120 characters long.',
    });
  }

  const subject = typeof campaign.subject === 'string' ? campaign.subject.trim() : '';
  if (subject.length < 1 || subject.length > MAX_EMAIL_SUBJECT_LENGTH) {
    issues.push({
      path: 'campaign.subject',
      message: 'Email subject must be between 1 and 200 characters long.',
    });
  }

  const hasText = typeof campaign.textContent === 'string' && campaign.textContent.trim().length > 0;
  const hasHtml = typeof campaign.htmlContent === 'string' && campaign.htmlContent.trim().length > 0;
  if (!hasText && !hasHtml) {
    issues.push({
      path: 'campaign.content',
      message: 'Campaign must have non-empty text content or HTML content.',
    });
  }

  if (campaign.status !== 'draft') {
    issues.push({
      path: 'campaign.status',
      message: 'Test emails can only be sent for draft campaigns.',
    });
  }

  return issues;
};

/**
 * Lazily created production email service (SMTP resolved from env on first send).
 * Shared across requests so an SMTP transport, once created, is reused.
 */
let defaultEmailService = null;

/**
 * Resolves the email service for a request.
 * Tests (and future composition roots) inject a service via `app.locals.emailService`;
 * otherwise a fail-closed default service configured from environment variables is used.
 *
 * @param {import('express').Request} req
 * @returns {{ sendEmail: (message: object) => Promise<object> }}
 */
export const resolveEmailService = (req) => {
  const injected = req.app?.locals?.emailService;
  if (injected && typeof injected.sendEmail === 'function') {
    return injected;
  }
  if (!defaultEmailService) {
    defaultEmailService = createEmailService();
  }
  return defaultEmailService;
};

/**
 * Send a single test copy of a campaign to the authenticated user's own account email.
 *
 * Guarantees:
 * - Destination is ALWAYS the account email loaded from the database; never the campaign's
 *   recipients, contacts, or an arbitrary caller-supplied address.
 * - Ownership is enforced by querying { _id, userId }; foreign and missing campaigns both
 *   return the same 404 so campaign existence is never disclosed.
 * - Read-only: the campaign is loaded with .lean() and never saved, so no status, recipient,
 *   or timestamp changes occur, and no delivery records are created.
 * - Errors are mapped to sanitized responses; SMTP details and raw provider errors never leak.
 * - Success is reported as "dispatched" (accepted by the transport), not "delivered".
 *
 * Route: POST /api/v1/campaigns/:id/test-email
 * Access: Protected (Bearer JWT) + per-user test email rate limit
 */
export const sendCampaignTestEmail = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { id } = req.params;
  const requestedTo = req.body?.to;

  // 1. Load campaign strictly scoped to the authenticated owner (read-only)
  const campaign = await Campaign.findOne({ _id: id, userId })
    .select('name subject textContent htmlContent status')
    .lean();
  if (!campaign) {
    throw new AppError('Campaign not found.', 404);
  }

  // 2. Resolve the destination from the authenticated account, never from the request
  const user = await User.findById(userId).select('email status').lean();
  if (!user || typeof user.email !== 'string' || !user.email.trim()) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }
  if (user.status && user.status !== 'active') {
    throw new AppError('Your account is not permitted to send test emails.', 403);
  }

  const destination = user.email.trim().toLowerCase();

  if (requestedTo !== undefined && requestedTo.trim().toLowerCase() !== destination) {
    throw new AppError('Validation failed', 400, [
      {
        path: 'body.to',
        message: 'Test emails can only be sent to your own account email address.',
      },
    ]);
  }

  // 3. Ensure the campaign has sendable content (recipients are not required for tests)
  const issues = getTestEmailContentIssues(campaign);
  if (issues.length > 0) {
    throw new AppError('Campaign is not ready for a test email.', 422, issues);
  }

  // 4. Dispatch exactly one message to the account email
  const emailService = resolveEmailService(req);
  let result;
  try {
    result = await emailService.sendEmail({
      to: destination,
      subject: buildTestEmailSubject(campaign.subject),
      text: campaign.textContent ?? '',
      html: campaign.htmlContent ?? '',
    });
  } catch (error) {
    if (error instanceof InvalidMessageError) {
      // Validation messages from the service are safe, static strings
      throw new AppError('Campaign content cannot be sent as a test email.', 400, [
        { path: 'message', message: error.message },
      ]);
    }
    if (error instanceof EmailConfigurationError) {
      throw new AppError('Email sending is not configured.', 503, null, { expose: true });
    }
    if (error instanceof EmailTransportError) {
      throw new AppError('Failed to send test email. Please try again later.', 502, null, {
        expose: true,
      });
    }
    // Unknown failures fall through to the centralized handler as a sanitized 500
    throw error;
  }

  res.status(200).json({
    success: true,
    message: 'Test email dispatched',
    data: {
      destination: result.destination,
      subject: result.subject,
      messageId: result.messageId,
      sentAt: result.sentAt,
    },
  });
});

export default {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  getCampaignReadiness,
  sendCampaignTestEmail,
  formatSafeCampaign,
  validateAndDeduplicateRecipients,
};