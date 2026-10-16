import jwt from 'jsonwebtoken';
import { getAuthConfig } from '../config/auth.js';

/**
 * Token Service Utility
 *
 * Provides functions for signing and verifying short-lived JSON Web Tokens (JWTs).
 * - Enforces standard HMAC-SHA256 (HS256) signature verification.
 * - Strictly rejects unsigned ('none') or unexpected algorithms.
 * - Enforces minimal payload structure containing only essential user identity.
 * - Disallows caller-supplied overrides to mandatory cryptographic settings.
 */

/**
 * Signs a short-lived access token for a validated user identity.
 *
 * @param {string|{ _id?: string|object, userId?: string, id?: string, sub?: string }} userOrId - User entity or ID string
 * @param {object} [customConfig] - Optional configuration override (used for testing)
 * @returns {string} Signed JWT access token
 * @throws {Error} If userId is missing or invalid
 */
export const signAccessToken = (userOrId, customConfig) => {
  const config = customConfig || getAuthConfig();

  // Extract stable userId identifier, ensuring raw objects with credentials are discarded
  let userId;
  if (typeof userOrId === 'string') {
    userId = userOrId.trim();
  } else if (userOrId && typeof userOrId === 'object') {
    const rawId = userOrId._id || userOrId.userId || userOrId.id || userOrId.sub;
    userId = rawId != null ? String(rawId).trim() : '';
  }

  if (!userId) {
    throw new Error('Failed to sign access token: A valid non-empty userId is required.');
  }

  // Strictly minimal payload - only essential identifier
  const payload = {
    userId,
  };

  return jwt.sign(payload, config.secret, {
    algorithm: 'HS256',
    expiresIn: config.expiresIn,
    issuer: config.issuer,
    audience: config.audience,
    subject: userId,
  });
};

/**
 * Verifies a JWT access token's signature, expiration, and claims.
 *
 * @param {string} token - The raw JWT token string
 * @param {object} [customConfig] - Optional configuration override (used for testing)
 * @returns {object} Decoded token payload
 * @throws {Error} If token is missing, expired, tampered with, or invalid
 */
export const verifyAccessToken = (token, customConfig) => {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('Authorization token must be a non-empty string.');
  }

  const config = customConfig || getAuthConfig();

  // Explicitly restrict accepted algorithms to HS256 to prevent algorithm confusion attacks
  return jwt.verify(token.trim(), config.secret, {
    algorithms: ['HS256'],
    issuer: config.issuer,
    audience: config.audience,
  });
};

export default {
  signAccessToken,
  verifyAccessToken,
};
