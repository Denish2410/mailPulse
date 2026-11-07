import mongoose from 'mongoose';
import User from '../models/User.js';
import { hashPassword, verifyPassword } from '../services/password.service.js';
import { signAccessToken } from '../utils/token.js';
import { getAuthConfig } from '../config/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getDefaultEmailService } from '../services/email.service.js';
import {
  createResetToken,
  hashResetToken,
  buildResetLink,
  buildResetEmail,
  createVerificationToken,
  buildVerificationLink,
  buildVerificationEmail,
} from '../services/passwordReset.service.js';

/**
 * Pre-computed valid Argon2id dummy hash.
 * Used during login when an email does not match any record in the database.
 * Performing a dummy verification equalizes response execution time, neutralizing
 * side-channel timing attacks that could otherwise be used to enumerate registered emails.
 */
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$FY7RCR3ntPJzHY3UExvQ4Q$4Au5P/Bof0jgSZq9oCCEgZ8SL5/nnkqAzFBcyENAI60';

/**
 * Format a Mongoose User document into a safe, client-facing data object.
 * Strictly guarantees that internal Mongoose internals, password hashes, and secrets
 * are excluded from API payloads.
 *
 * @param {import('../models/User.js').default} user
 * @returns {object} Safe user representation
 */
const formatSafeUser = (user) => ({
  id: user._id ? user._id.toString() : user.id,
  name: user.name,
  email: user.email,
  status: user.status,
  emailVerified: Boolean(user.emailVerifiedAt),
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

/**
 * Creates a verification token for the user and emails the link in the background.
 * Failures never affect the caller; the token and link are never logged.
 */
const issueVerificationEmail = async (req, user) => {
  const { token, tokenHash, expiresAt } = createVerificationToken();
  await User.updateOne(
    { _id: user._id },
    { $set: { emailVerificationTokenHash: tokenHash, emailVerificationExpiresAt: expiresAt } }
  );
  const link = buildVerificationLink(token);
  const emailService = req.app?.locals?.emailService || getDefaultEmailService();
  emailService
    .sendEmail({ to: user.email, ...buildVerificationEmail({ name: user.name, link }) })
    .catch(() => {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[Auth] Verification email could not be sent (dev only) link: ${link}`);
      }
    });
};

/**
 * Register a new user account.
 *
 * Route: POST /api/v1/auth/register
 * Access: Public
 */
export const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Check for existing account to provide immediate friendly conflict feedback
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new AppError('An account with this email address already exists.', 409);
  }

  // 2. Hash the raw password using Argon2id with unique salt
  const passwordHash = await hashPassword(password);

  // 3. Persist the User record, handling potential concurrent race conditions via index error code 11000
  let user;
  try {
    user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
    });
  } catch (err) {
    if (err.code === 11000) {
      throw new AppError('An account with this email address already exists.', 409);
    }
    throw err;
  }

  // 3b. Send the verification email in the background (never blocks or fails registration)
  issueVerificationEmail(req, user).catch(() => {});

  // 4. Issue initial short-lived JWT access token
  const token = signAccessToken(user);
  const authConfig = getAuthConfig();

  // 5. Send safe response
  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    data: {
      user: formatSafeUser(user),
      token,
      tokenType: 'Bearer',
      expiresIn: authConfig.expiresIn,
    },
  });
});

/**
 * Authenticate an existing user with credentials.
 *
 * Route: POST /api/v1/auth/login
 * Access: Public
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Query user by normalized email, explicitly requesting the passwordHash field
  const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');

  // 2. Mitigate email enumeration timing attacks if account does not exist
  if (!user) {
    await verifyPassword(password, DUMMY_ARGON2_HASH);
    throw new AppError('Invalid email or password.', 401);
  }

  // 3. Verify submitted password against stored Argon2id hash
  const isMatch = await verifyPassword(password, user.passwordHash);
  if (!isMatch) {
    throw new AppError('Invalid email or password.', 401);
  }

  // 4. Validate account status (must be active)
  if (user.status === 'suspended') {
    throw new AppError('Your account has been suspended. Please contact support.', 403);
  }

  // 5. Issue short-lived JWT access token
  const token = signAccessToken(user);
  const authConfig = getAuthConfig();

  // 6. Send safe response
  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: {
      user: formatSafeUser(user),
      token,
      tokenType: 'Bearer',
      expiresIn: authConfig.expiresIn,
    },
  });
});

/**
 * Retrieve the current authenticated user's profile.
 *
 * Route: GET /api/v1/auth/me
 * Access: Protected (Bearer JWT)
 */
export const getMe = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;

  // Validate that the request identity exists and is a valid MongoDB ObjectId
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('User account not found.', 401);
  }

  // Look up current user in MongoDB to enforce database state
  const user = await User.findById(userId);

  if (!user) {
    throw new AppError('User account not found.', 401);
  }

  // Account-state enforcement: reject suspended accounts
  if (user.status === 'suspended') {
    throw new AppError('Your account has been suspended. Please contact support.', 403);
  }

  res.status(200).json({
    success: true,
    message: 'Current user profile retrieved successfully',
    data: {
      user: formatSafeUser(user),
    },
  });
});

export default {
  register,
  login,
  getMe,
};

const FORGOT_PASSWORD_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

/**
 * Start a password reset. Always answers with the same message so account existence is never
 * revealed. The email is sent in the background (not awaited) to keep response timing uniform.
 *
 * Route: POST /api/v1/auth/forgot-password
 * Access: Public
 */
export const forgotPassword = asyncHandler(async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const user = await User.findOne({ email });

  if (user && user.status !== 'suspended') {
    const { token, tokenHash, expiresAt } = createResetToken();
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt } }
    );

    const link = buildResetLink(token);
    const emailService = req.app?.locals?.emailService || getDefaultEmailService();
    emailService
      .sendEmail({ to: user.email, ...buildResetEmail({ name: user.name, link }) })
      .catch(() => {
        // Never log the token or link. In local development, surface it so the flow is testable
        // without SMTP.
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[Auth] Password reset email could not be sent (dev only) link: ${link}`);
        } else if (process.env.NODE_ENV !== 'test') {
          console.warn('[Auth] Password reset email could not be sent.');
        }
      });
  }

  res.status(200).json({ success: true, message: FORGOT_PASSWORD_MESSAGE });
});

/**
 * Complete a password reset with the emailed token.
 *
 * Route: POST /api/v1/auth/reset-password
 * Access: Public
 */
export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const passwordHash = await hashPassword(password);

  // Atomic consume: only one request can win a given token
  const user = await User.findOneAndUpdate(
    {
      passwordResetTokenHash: hashResetToken(token),
      passwordResetExpiresAt: { $gt: new Date() },
      status: { $ne: 'suspended' },
    },
    {
      $set: { passwordHash },
      $unset: { passwordResetTokenHash: '', passwordResetExpiresAt: '' },
    },
    { new: true }
  );

  if (!user) {
    throw new AppError('Invalid or expired reset link.', 400, null, { expose: true });
  }

  res.status(200).json({
    success: true,
    message: 'Password updated. You can now sign in with your new password.',
  });
});

/**
 * Confirm an email address with the emailed single-use token.
 *
 * Route: POST /api/v1/auth/verify-email
 * Access: Public
 */
export const verifyEmail = asyncHandler(async (req, res) => {
  const user = await User.findOneAndUpdate(
    {
      emailVerificationTokenHash: hashResetToken(req.body.token),
      emailVerificationExpiresAt: { $gt: new Date() },
    },
    {
      $set: { emailVerifiedAt: new Date() },
      $unset: { emailVerificationTokenHash: '', emailVerificationExpiresAt: '' },
    },
    { new: true }
  );

  if (!user) {
    throw new AppError('Invalid or expired verification link.', 400, null, { expose: true });
  }

  res.status(200).json({ success: true, message: 'Email address verified.' });
});

/**
 * Send a fresh verification email to the authenticated user.
 *
 * Route: POST /api/v1/auth/resend-verification
 * Access: Protected (Bearer JWT)
 */
export const resendVerification = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('User account not found.', 401);
  }
  const user = await User.findById(userId);
  if (!user) throw new AppError('User account not found.', 401);
  if (user.status === 'suspended') {
    throw new AppError('Your account has been suspended. Please contact support.', 403);
  }

  if (!user.emailVerifiedAt) {
    await issueVerificationEmail(req, user);
  }

  res.status(200).json({
    success: true,
    message: user.emailVerifiedAt
      ? 'Your email address is already verified.'
      : 'Verification email sent.',
    data: { emailVerified: Boolean(user.emailVerifiedAt) },
  });
});
