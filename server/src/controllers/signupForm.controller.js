import mongoose from 'mongoose';
import SignupForm, { MAX_SIGNUP_FORMS_PER_USER } from '../models/SignupForm.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Owner management of public signup forms. All queries are scoped to the authenticated owner.
 */

export const formatSafeSignupForm = (form) => {
  const doc = typeof form.toObject === 'function' ? form.toObject() : form;
  return {
    id: String(doc._id),
    name: doc.name,
    description: doc.description ?? '',
    tags: doc.tags ?? [],
    slug: doc.slug,
    enabled: Boolean(doc.enabled),
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

export const createSignupForm = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  if ((await SignupForm.countDocuments({ userId })) >= MAX_SIGNUP_FORMS_PER_USER) {
    throw new AppError(`You can have at most ${MAX_SIGNUP_FORMS_PER_USER} signup forms.`, 409);
  }
  const form = await SignupForm.create({ userId, ...req.body });
  res.status(201).json({
    success: true,
    message: 'Signup form created successfully',
    data: { form: formatSafeSignupForm(form) },
  });
});

export const getSignupForms = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const forms = await SignupForm.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(MAX_SIGNUP_FORMS_PER_USER);
  res.status(200).json({
    success: true,
    message: 'Signup forms retrieved successfully',
    data: { forms: forms.map(formatSafeSignupForm), count: forms.length },
  });
});

export const updateSignupForm = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const form = await SignupForm.findOneAndUpdate(
    { _id: req.params.id, userId },
    { $set: req.body },
    { new: true, runValidators: true }
  );
  if (!form) throw new AppError('Signup form not found.', 404);
  res.status(200).json({
    success: true,
    message: 'Signup form updated successfully',
    data: { form: formatSafeSignupForm(form) },
  });
});

export const deleteSignupForm = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const deleted = await SignupForm.findOneAndDelete({ _id: req.params.id, userId });
  if (!deleted) throw new AppError('Signup form not found.', 404);
  res.status(200).json({ success: true, message: 'Signup form deleted successfully' });
});
