import rateLimit from 'express-rate-limit';

/**
 * Dedicated Rate Limiter for Campaign Sends (Phase 5)
 *
 * Applied in addition to the global IP-based API limiter mounted in app.js.
 *
 * Design (mirrors testEmailRateLimiter):
 * - Keyed by the authenticated user ID (`req.auth.userId`); must be mounted AFTER `authenticate`.
 * - Configuration is resolved lazily on the first request so runtime env values are honored.
 * - Every attempt counts, including requests that later fail validation or readiness, which keeps
 *   the endpoint expensive to abuse. Double sends are prevented separately by the atomic
 *   draft -> sending transition, not by this limiter.
 */

export const DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_MAX = 10;

export const CAMPAIGN_SEND_RATE_LIMIT_MESSAGE =
  'Too many campaign send requests. Please wait before sending another campaign.';

const parsePositiveInteger = (raw, fallback) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number(String(raw).trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * @param {object} [env=process.env]
 * @returns {{ windowMs: number, max: number }}
 */
export const getCampaignSendRateLimitConfig = (env = process.env) => ({
  windowMs: parsePositiveInteger(
    env.CAMPAIGN_SEND_RATE_LIMIT_WINDOW_MS,
    DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_WINDOW_MS
  ),
  max: parsePositiveInteger(env.CAMPAIGN_SEND_RATE_LIMIT_MAX, DEFAULT_CAMPAIGN_SEND_RATE_LIMIT_MAX),
});

/**
 * @param {object} [options]
 * @param {number} [options.windowMs]
 * @param {number} [options.max]
 * @param {object} [options.env=process.env]
 * @returns {import('express').RequestHandler}
 */
export const createCampaignSendRateLimiter = ({ windowMs, max, env = process.env } = {}) => {
  const resolved = getCampaignSendRateLimitConfig(env);

  return rateLimit({
    windowMs: windowMs ?? resolved.windowMs,
    limit: max ?? resolved.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const userId = req.auth?.userId;
      return typeof userId === 'string' && userId ? `user:${userId}` : 'unauthenticated';
    },
    message: {
      success: false,
      message: CAMPAIGN_SEND_RATE_LIMIT_MESSAGE,
    },
  });
};

/**
 * Lazily-initialized limiter used by the campaign routes.
 *
 * @returns {import('express').RequestHandler}
 */
export const createLazyCampaignSendRateLimiter = () => {
  let limiter = null;
  return (req, res, next) => {
    if (!limiter) {
      limiter = createCampaignSendRateLimiter();
    }
    return limiter(req, res, next);
  };
};

export const campaignSendRateLimiter = createLazyCampaignSendRateLimiter();

export default campaignSendRateLimiter;
