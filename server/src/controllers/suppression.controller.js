import mongoose from 'mongoose';
import Suppression from '../models/Suppression.js';
import Contact from '../models/Contact.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { escapeRegex } from './campaign.controller.js';

/**
 * Suppression list management (gap fix). All queries are scoped to the authenticated owner.
 *
 * Opt-outs the recipient made themselves ('link', 'one-click-header') and spam complaints are
 * permanent and cannot be removed here: re-mailing someone who opted out is a compliance risk.
 * Only suppressions the owner added ('admin', 'import') or that a bounce created ('bounce') can
 * be removed, so a fixed mailbox can be mailed again.
 */

export const REMOVABLE_SOURCES = ['admin', 'import', 'bounce'];
const MANUAL_REASON = 'Manually suppressed';

export const formatSafeSuppression = (suppression) => {
  const doc = typeof suppression.toObject === 'function' ? suppression.toObject() : suppression;
  return {
    id: String(doc._id),
    email: doc.email,
    reason: doc.reason ?? null,
    source: doc.source,
    removable: REMOVABLE_SOURCES.includes(doc.source),
    createdAt: doc.createdAt,
  };
};

const requireUserId = (req) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }
  return userId;
};

export const getSuppressions = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { page = 1, limit = 20, search, source } = req.query;

  const filter = { userId };
  if (search) filter.email = new RegExp(escapeRegex(search), 'i');
  if (source) filter.source = source;

  const [items, total] = await Promise.all([
    Suppression.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Suppression.countDocuments(filter),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  res.status(200).json({
    success: true,
    message: 'Suppressions retrieved successfully',
    data: {
      suppressions: items.map(formatSafeSuppression),
      count: items.length,
      pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 && total > 0 },
    },
  });
});

export const createSuppression = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { email, reason } = req.body;

  let suppression;
  try {
    suppression = await Suppression.create({
      userId,
      email,
      reason: reason || MANUAL_REASON,
      source: 'admin',
    });
  } catch (err) {
    if (err.code === 11000) throw new AppError('This address is already suppressed.', 409);
    throw err;
  }

  // Keep the contact (if any) consistent so it is excluded everywhere
  await Contact.updateMany(
    { userId, email, isUnsubscribed: { $ne: true } },
    { $set: { isUnsubscribed: true, unsubscribedAt: new Date(), unsubscribeReason: MANUAL_REASON } }
  );

  res.status(201).json({
    success: true,
    message: 'Address suppressed successfully',
    data: { suppression: formatSafeSuppression(suppression) },
  });
});

export const deleteSuppression = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const suppression = await Suppression.findOne({ _id: req.params.id, userId });
  if (!suppression) throw new AppError('Suppression not found.', 404);

  if (!REMOVABLE_SOURCES.includes(suppression.source)) {
    throw new AppError(
      'Opt-outs and spam complaints are permanent and cannot be removed.',
      409,
      null,
      { expose: true }
    );
  }

  await Suppression.deleteOne({ _id: suppression._id, userId });

  // Reverse only the flag this feature set; never touch recipient-made unsubscribes
  if (suppression.source === 'admin') {
    await Contact.updateMany(
      { userId, email: suppression.email, unsubscribeReason: MANUAL_REASON },
      { $set: { isUnsubscribed: false, unsubscribedAt: null, unsubscribeReason: null } }
    );
  }

  res.status(200).json({ success: true, message: 'Suppression removed successfully' });
});
