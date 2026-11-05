import mongoose from 'mongoose';
import Segment, { MAX_SEGMENTS_PER_USER } from '../models/Segment.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { escapeRegex } from './campaign.controller.js';
import { normalizeCriteria, resolveSegment } from '../services/segment.service.js';

const SAMPLE_SIZE = 10;
const DUPLICATE_MESSAGE = 'A segment with this name already exists.';

export const formatSafeSegment = (segment) => {
  const doc = typeof segment.toObject === 'function' ? segment.toObject() : segment;
  return {
    id: String(doc._id),
    name: doc.name,
    description: doc.description ?? '',
    criteria: normalizeCriteria(doc.criteria),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

const requireUserId = (req) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }
  return userId;
};

const toStoredCriteria = (criteria) => {
  const normalized = normalizeCriteria(criteria);
  return {
    tagsAny: normalized.tagsAny,
    tagsAll: normalized.tagsAll,
    tagsNone: normalized.tagsNone,
    ...(normalized.engagement && { engagement: normalized.engagement }),
    createdWithinDays: normalized.createdWithinDays,
  };
};

const formatPreview = ({ total, contacts }) => ({
  total,
  sample: contacts.slice(0, SAMPLE_SIZE).map((c) => ({ id: String(c._id), name: c.name, email: c.email })),
});

export const createSegment = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  if ((await Segment.countDocuments({ userId })) >= MAX_SEGMENTS_PER_USER) {
    throw new AppError(`You can store at most ${MAX_SEGMENTS_PER_USER} segments.`, 409);
  }

  let segment;
  try {
    segment = await Segment.create({
      userId,
      name: req.body.name,
      description: req.body.description,
      criteria: toStoredCriteria(req.body.criteria),
    });
  } catch (err) {
    if (err.code === 11000) throw new AppError(DUPLICATE_MESSAGE, 409);
    throw err;
  }

  res.status(201).json({
    success: true,
    message: 'Segment created successfully',
    data: { segment: formatSafeSegment(segment) },
  });
});

export const getSegments = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { page = 1, limit = 20, search } = req.query;
  const filter = { userId };
  if (search) filter.name = new RegExp(escapeRegex(search), 'i');

  const [segments, total] = await Promise.all([
    Segment.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Segment.countDocuments(filter),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  res.status(200).json({
    success: true,
    message: 'Segments retrieved successfully',
    data: {
      segments: segments.map(formatSafeSegment),
      count: segments.length,
      pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 && total > 0 },
    },
  });
});

export const getSegmentById = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const segment = await Segment.findOne({ _id: req.params.id, userId });
  if (!segment) throw new AppError('Segment not found.', 404);
  res.status(200).json({
    success: true,
    message: 'Segment retrieved successfully',
    data: { segment: formatSafeSegment(segment) },
  });
});

export const updateSegment = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const update = { ...req.body };
  if (update.criteria) update.criteria = toStoredCriteria(update.criteria);

  let segment;
  try {
    segment = await Segment.findOneAndUpdate(
      { _id: req.params.id, userId },
      { $set: update }, // criteria is replaced wholesale, so omitted rules are removed
      { new: true, runValidators: true }
    );
  } catch (err) {
    if (err.code === 11000) throw new AppError(DUPLICATE_MESSAGE, 409);
    throw err;
  }
  if (!segment) throw new AppError('Segment not found.', 404);

  res.status(200).json({
    success: true,
    message: 'Segment updated successfully',
    data: { segment: formatSafeSegment(segment) },
  });
});

export const deleteSegment = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const deleted = await Segment.findOneAndDelete({ _id: req.params.id, userId });
  if (!deleted) throw new AppError('Segment not found.', 404);
  res.status(200).json({ success: true, message: 'Segment deleted successfully' });
});

/** Evaluate a saved segment: exact matching count plus a small sample. */
export const previewSegment = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const segment = await Segment.findOne({ _id: req.params.id, userId }).lean();
  if (!segment) throw new AppError('Segment not found.', 404);

  const result = await resolveSegment(userId, segment.criteria, { limit: SAMPLE_SIZE });
  res.status(200).json({
    success: true,
    message: 'Segment previewed successfully',
    data: { preview: formatPreview(result) },
  });
});

/** Evaluate unsaved criteria (live preview while editing). */
export const previewCriteria = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const result = await resolveSegment(userId, req.body.criteria, { limit: SAMPLE_SIZE });
  res.status(200).json({
    success: true,
    message: 'Segment previewed successfully',
    data: { preview: formatPreview(result) },
  });
});
