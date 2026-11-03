import mongoose from 'mongoose';
import Template, { MAX_TEMPLATES_PER_USER } from '../models/Template.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { escapeRegex } from './campaign.controller.js';
import { MERGE_TAGS, findMergeTags } from '../services/personalization.service.js';

/**
 * Template library (Phase 10). Every query is scoped to the authenticated owner.
 */

export const formatSafeTemplate = (template) => {
  const doc = typeof template.toObject === 'function' ? template.toObject() : template;
  return {
    id: String(doc._id),
    name: doc.name,
    subject: doc.subject ?? '',
    textContent: doc.textContent ?? '',
    htmlContent: doc.htmlContent ?? '',
    mergeTags: findMergeTags(`${doc.subject ?? ''} ${doc.textContent ?? ''} ${doc.htmlContent ?? ''}`),
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

const DUPLICATE_MESSAGE = 'A template with this name already exists.';

export const createTemplate = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);

  if ((await Template.countDocuments({ userId })) >= MAX_TEMPLATES_PER_USER) {
    throw new AppError(`You can store at most ${MAX_TEMPLATES_PER_USER} templates.`, 409);
  }

  let template;
  try {
    template = await Template.create({ userId, ...req.body });
  } catch (err) {
    if (err.code === 11000) throw new AppError(DUPLICATE_MESSAGE, 409);
    throw err;
  }

  res.status(201).json({
    success: true,
    message: 'Template created successfully',
    data: { template: formatSafeTemplate(template) },
  });
});

export const getTemplates = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { page = 1, limit = 20, search } = req.query;

  const filter = { userId };
  if (search) filter.name = new RegExp(escapeRegex(search), 'i');

  const [templates, total] = await Promise.all([
    Template.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Template.countDocuments(filter),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  res.status(200).json({
    success: true,
    message: 'Templates retrieved successfully',
    data: {
      templates: templates.map(formatSafeTemplate),
      count: templates.length,
      availableMergeTags: MERGE_TAGS,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1 && total > 0,
      },
    },
  });
});

export const getTemplateById = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const template = await Template.findOne({ _id: req.params.id, userId });
  if (!template) throw new AppError('Template not found.', 404);

  res.status(200).json({
    success: true,
    message: 'Template retrieved successfully',
    data: { template: formatSafeTemplate(template) },
  });
});

export const updateTemplate = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);

  let template;
  try {
    template = await Template.findOneAndUpdate(
      { _id: req.params.id, userId },
      { $set: req.body },
      { new: true, runValidators: true }
    );
  } catch (err) {
    if (err.code === 11000) throw new AppError(DUPLICATE_MESSAGE, 409);
    throw err;
  }
  if (!template) throw new AppError('Template not found.', 404);

  res.status(200).json({
    success: true,
    message: 'Template updated successfully',
    data: { template: formatSafeTemplate(template) },
  });
});

export const deleteTemplate = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const deleted = await Template.findOneAndDelete({ _id: req.params.id, userId });
  if (!deleted) throw new AppError('Template not found.', 404);

  res.status(200).json({ success: true, message: 'Template deleted successfully' });
});
