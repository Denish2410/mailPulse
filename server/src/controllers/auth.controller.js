import User from '../models/User.js';
import { hashPassword, verifyPassword } from '../services/password.service.js';
import { signAccessToken } from '../utils/token.js';
import { getAuthConfig } from '../config/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';

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
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  status: user.status,
  createdAt: user.createdAt,
});

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

export default {
  register,
  login,
};
