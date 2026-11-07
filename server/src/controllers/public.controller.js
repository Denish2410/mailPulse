import SignupForm from '../models/SignupForm.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getDefaultEmailService } from '../services/email.service.js';
import { requestSubscription, confirmSubscription } from '../services/signupSubscription.service.js';

/**
 * Unauthenticated endpoints for public signup forms. They expose only the form's name and
 * description, answer subscribe requests uniformly, and never reveal whether an address is known.
 */

const SUBSCRIBE_MESSAGE = 'Almost done! Check your inbox for a message asking you to confirm your subscription.';

const findPublicForm = async (slug) => {
  const form = await SignupForm.findOne({ slug, enabled: true }).lean();
  if (!form) throw new AppError('This form is not available.', 404, null, { expose: true });
  return form;
};

export const getPublicForm = asyncHandler(async (req, res) => {
  const form = await findPublicForm(req.params.slug);
  res.status(200).json({
    success: true,
    message: 'Form retrieved successfully',
    data: { form: { name: form.name, description: form.description ?? '' } },
  });
});

export const subscribeToForm = asyncHandler(async (req, res) => {
  const form = await findPublicForm(req.params.slug);
  const { email, name, website } = req.body;

  // Bots that fill the honeypot get the same answer and nothing happens
  if (!website) {
    const emailService = req.app?.locals?.emailService || getDefaultEmailService();
    await requestSubscription(form, { email, name }, emailService);
  }

  res.status(200).json({ success: true, message: SUBSCRIBE_MESSAGE });
});

export const confirmFormSubscription = asyncHandler(async (req, res) => {
  const result = await confirmSubscription(req.body.token);
  if (!result.confirmed) {
    throw new AppError('Invalid or expired confirmation link.', 400, null, { expose: true });
  }
  res.status(200).json({
    success: true,
    message: 'Subscription confirmed. Thank you!',
    data: { formName: result.formName },
  });
});
