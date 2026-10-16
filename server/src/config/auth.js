/**
 * Authentication & JWT Configuration Module
 *
 * Defines and validates authentication parameters for token signing and verification.
 * - Enforces minimum 32-character secret length for HMAC-SHA256 (HS256) security (RFC 7518).
 * - Avoids silent fallbacks to insecure hardcoded secrets.
 * - Access Token Lifetime: Defaults to '15m' (15 minutes). A 15-minute lifetime strikes an optimal
 *   balance between operational usability and security, significantly limiting the exposure window
 *   if an access token is intercepted, without imposing excessive overhead on active user sessions.
 */

export const MIN_SECRET_LENGTH = 32;

/**
 * Validates and retrieves authentication configuration from the provided environment.
 * Does not execute at top-level module load time to prevent side-effect failures when importing
 * unrelated application components.
 *
 * @param {object} [env=process.env] - Environment object to extract configuration from
 * @returns {{
 *   secret: string,
 *   expiresIn: string|number,
 *   issuer: string,
 *   audience: string,
 *   algorithm: 'HS256'
 * }} Validated authentication configuration
 * @throws {Error} If secret is missing or does not meet minimum entropy/length requirements
 */
export const getAuthConfig = (env = process.env) => {
  const secret = env.JWT_SECRET;

  if (!secret || typeof secret !== 'string' || !secret.trim()) {
    throw new Error(
      'Authentication configuration error: JWT_SECRET environment variable is required and must not be empty.'
    );
  }

  const trimmedSecret = secret.trim();
  if (trimmedSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `Authentication configuration error: JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters long for HS256 security (current length: ${trimmedSecret.length}).`
    );
  }

  const rawExpiresIn = env.JWT_EXPIRES_IN;
  // If explicitly provided, it cannot be empty or whitespace
  if (rawExpiresIn !== undefined && (typeof rawExpiresIn !== 'string' || !rawExpiresIn.trim())) {
    throw new Error(
      'Authentication configuration error: JWT_EXPIRES_IN must be a positive number of seconds or a valid time string (e.g., \'15m\', \'1h\', \'7d\').'
    );
  }

  const expiresIn = (rawExpiresIn && typeof rawExpiresIn === 'string' ? rawExpiresIn.trim() : null) || '15m';

  let isValidExpiresIn = false;
  if (typeof expiresIn === 'number' && expiresIn > 0) {
    isValidExpiresIn = true;
  } else if (typeof expiresIn === 'string') {
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (match && Number(match[1]) > 0) {
      isValidExpiresIn = true;
    } else if (/^\d+$/.test(expiresIn) && Number(expiresIn) > 0) {
      isValidExpiresIn = true;
    }
  }

  if (!isValidExpiresIn) {
    throw new Error(
      `Authentication configuration error: JWT_EXPIRES_IN ("${expiresIn}") must be a positive number of seconds or a valid time string (e.g., '15m', '1h', '7d').`
    );
  }

  const issuer = env.JWT_ISSUER || 'mailpulse-api';
  const audience = env.JWT_AUDIENCE || 'mailpulse-client';

  return {
    secret: trimmedSecret,
    expiresIn,
    issuer,
    audience,
    algorithm: 'HS256',
  };
};

/**
 * Explicit validation function for application startup checks.
 *
 * @param {object} [env=process.env]
 * @returns {object} Validated auth configuration
 */
export const validateAuthConfig = (env = process.env) => {
  return getAuthConfig(env);
};

export default {
  getAuthConfig,
  validateAuthConfig,
  MIN_SECRET_LENGTH,
};
