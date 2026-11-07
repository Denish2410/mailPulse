import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getPublicForm, subscribeToForm, confirmFormSubscription } from '../controllers/public.controller.js';
import { validate } from '../validators/validate.js';
import {
  publicFormParamSchema,
  publicSubscribeSchema,
  confirmSubscriptionSchema,
} from '../validators/public.validator.js';

const router = Router();

const isTest = () => process.env.NODE_ENV === 'test';

// Subscribing sends email to an arbitrary address, so it gets a tight per-IP limit
const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => (isTest() ? 1000 : Number(process.env.PUBLIC_SUBSCRIBE_RATE_LIMIT_MAX) || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => (isTest() ? 1000 : 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

router.get('/forms/:slug', readLimiter, validate(publicFormParamSchema), getPublicForm);
router.post('/forms/:slug/subscribe', subscribeLimiter, validate(publicSubscribeSchema), subscribeToForm);
router.post('/subscriptions/confirm', readLimiter, validate(confirmSubscriptionSchema), confirmFormSubscription);

export default router;
