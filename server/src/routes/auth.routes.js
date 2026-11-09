import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';

import {
  register,
  login,
  getMe,
  updateMe,
  exportMyData,
  deleteMyAccount,
  logoutAll,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
} from '../controllers/auth.controller.js';
import { authenticateSession as authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  updateProfileSchema,
  deleteAccountSchema,
} from '../validators/auth.validator.js';

const router = Router();

/**
 * Authentication Brute-Force Rate Limiter
 *
 * Implements a tighter threshold on authentication endpoints to defend against
 * credential stuffing and brute-force password guessing attempts.
 * Operates in addition to the global /api limiter mounted in app.js.
 */
const authLimiter = rateLimit({
  store: createRateLimitStore('auth'),
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
 * @route   POST /api/v1/auth/forgot-password
 * @desc    Email a password reset link (same response whether or not the account exists)
 * @access  Public
 */
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), forgotPassword);

/**
 * @route   POST /api/v1/auth/reset-password
 * @desc    Set a new password using the emailed single-use token
 * @access  Public
 */
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);

/**
 * @route   POST /api/v1/auth/verify-email
 * @desc    Confirm an email address with the emailed single-use token
 * @access  Public
 */
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), verifyEmail);

/**
 * @route   POST /api/v1/auth/resend-verification
 * @desc    Email a fresh verification link to the signed-in user
 * @access  Protected
 */
router.post('/resend-verification', authLimiter, authenticate, resendVerification);

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get currently authenticated user's safe profile
 * @access  Protected (Bearer token)
 */
router.get('/me', authenticate, getMe);

/**
 * @route   POST /api/v1/auth/logout-all
 * @desc    Revoke every access token issued so far, on all devices
 * @access  Protected (Bearer token)
 */
router.post('/logout-all', authLimiter, authenticate, logoutAll);

/**
 * @route   PATCH /api/v1/auth/me
 * @desc    Update the account name and the sender mailing address used in campaign footers
 * @access  Protected (Bearer token)
 */
router.patch('/me', authenticate, validate(updateProfileSchema), updateMe);

/**
 * @route   GET /api/v1/auth/me/export
 * @desc    Download all of the account's data as JSON
 * @access  Protected (Bearer token)
 */
router.get('/me/export', authLimiter, authenticate, exportMyData);

/**
 * @route   DELETE /api/v1/auth/me
 * @desc    Permanently delete the account and its data (requires the current password)
 * @access  Protected (Bearer token)
 */
router.delete('/me', authLimiter, authenticate, validate(deleteAccountSchema), deleteMyAccount);

export default router;

