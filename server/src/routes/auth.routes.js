import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { register, login, getMe } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import { registerSchema, loginSchema } from '../validators/auth.validator.js';

const router = Router();

/**
 * Authentication Brute-Force Rate Limiter
 *
 * Implements a tighter threshold on authentication endpoints to defend against
 * credential stuffing and brute-force password guessing attempts.
 * Operates in addition to the global /api limiter mounted in app.js.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: () => (process.env.NODE_ENV === 'test' ? 1000 : (Number(process.env.AUTH_RATE_LIMIT_MAX) || 20)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts from this IP address, please try again after 15 minutes.',
  },
});

/**
 * @route   POST /api/v1/auth/register
 * @desc    Register a new user account and receive an access token
 * @access  Public
 */
router.post('/register', authLimiter, validate(registerSchema), register);

/**
 * @route   POST /api/v1/auth/login
 * @desc    Authenticate with email and password and receive an access token
 * @access  Public
 */
router.post('/login', authLimiter, validate(loginSchema), login);

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get currently authenticated user's safe profile
 * @access  Protected (Bearer token)
 */
router.get('/me', authenticate, getMe);

export default router;

