import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Contact from '../models/Contact.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';

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

export default {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  formatSafeCampaign,
  validateAndDeduplicateRecipients,
};
