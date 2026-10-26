import rateLimit from 'express-rate-limit';

/**
 * Dedicated Rate Limiter for Campaign Test Emails (Phase 4.4 Step 3)
 *
 * Applied in addition to the global IP-based API limiter mounted in app.js.
 *
 * Design:
 * - Keyed by the authenticated user ID (`req.auth.userId`), not by IP address, so one
 *   account cannot bypass the limit by rotating IPs and users behind a shared IP (NAT,
 *   office network) do not consume each other's quota.
 * - Must be mounted AFTER the `authenticate` middleware.
 * - Configuration is resolved lazily on the first request so that environment variables
 *   set at runtime (for example, in test files whose static imports are hoisted) are honored.
 * - Every attempt counts toward the quota, including requests that later fail validation
 *   or ownership checks, which keeps the endpoint expensive to probe or abuse.
 */

export const DEFAULT_TEST_EMAIL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_TEST_EMAIL_RATE_LIMIT_MAX = 5;

export const TEST_EMAIL_RATE_LIMIT_MESSAGE =
  'Too many test email requests. Please wait before sending another test email.';

/**
 * Parses a positive integer environment value, falling back to a default when the value
 * is missing, non-numeric, non-integer, or not strictly positive.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
const parsePositiveInteger = (raw, fallback) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number(String(raw).trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * Resolves limiter configuration from environment variables.
 *
 * @param {object} [env=process.env]
 * @returns {{ windowMs: number, max: number }}
 */
export const getTestEmailRateLimitConfig = (env = process.env) => ({
  windowMs: parsePositiveInteger(
    env.TEST_EMAIL_RATE_LIMIT_WINDOW_MS,
    DEFAULT_TEST_EMAIL_RATE_LIMIT_WINDOW_MS
  ),
  max: parsePositiveInteger(env.TEST_EMAIL_RATE_LIMIT_MAX, DEFAULT_TEST_EMAIL_RATE_LIMIT_MAX),
});

/**
 * Creates a per-user test email rate limiter middleware.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs] - Explicit window override (falls back to env/defaults)
 * @param {number} [options.max] - Explicit maximum override (falls back to env/defaults)
 * @param {object} [options.env=process.env] - Environment used when overrides are omitted
 * @returns {import('express').RequestHandler}
 */
export const createTestEmailRateLimiter = ({ windowMs, max, env = process.env } = {}) => {
  const resolved = getTestEmailRateLimitConfig(env);

  return rateLimit({
    windowMs: windowMs ?? resolved.windowMs,
    limit: max ?? resolved.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Authenticated identity is guaranteed by the upstream `authenticate` middleware.
    // The fallback bucket is defensive only and never shares quota with real users.
    keyGenerator: (req) => {
      const userId = req.auth?.userId;
      return typeof userId === 'string' && userId ? `user:${userId}` : 'unauthenticated';
    },
    message: {
      success: false,
      message: TEST_EMAIL_RATE_LIMIT_MESSAGE,
    },
  });
};

/**
 * Lazily-initialized limiter used by the campaign routes.
 * The underlying limiter is created on the first request so runtime env values apply.
 *
 * @returns {import('express').RequestHandler}
 */
export const createLazyTestEmailRateLimiter = () => {
  let limiter = null;
  return (req, res, next) => {
    if (!limiter) {
      limiter = createTestEmailRateLimiter();
    }
    return limiter(req, res, next);
  };
};

export const testEmailRateLimiter = createLazyTestEmailRateLimiter();

export default testEmailRateLimiter;
