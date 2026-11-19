import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import {
  connectGoogle,
  googleCallback,
  listSenderAccounts,
  getSenderAccount,
  disconnectSender,
} from '../controllers/senderAccount.controller.js';
import { validate } from '../validators/validate.js';
import { googleCallbackSchema, senderAccountIdParamSchema } from '../validators/senderAccount.validator.js';
import { authenticateSession as authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);

/** Connecting a mailbox talks to Google: limit attempts per IP on top of the global /api limiter. */
const connectLimiter = rateLimit({
  store: createRateLimitStore('sender-connect'),
  windowMs: 15 * 60 * 1000,
  max: () => (process.env.NODE_ENV === 'test' ? 1000 : Number(process.env.SENDER_CONNECT_RATE_LIMIT_MAX) || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many connection attempts, please try again later.' },
});

router.get('/', listSenderAccounts);
router.get('/:id', validate(senderAccountIdParamSchema), getSenderAccount);
router.post('/:id/disconnect', validate(senderAccountIdParamSchema), disconnectSender);
router.post('/google/connect', connectLimiter, connectGoogle);
router.post('/google/callback', connectLimiter, validate(googleCallbackSchema), googleCallback);

export default router;
