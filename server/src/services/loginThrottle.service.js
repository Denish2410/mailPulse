import User from '../models/User.js';

/**
 * Per-account login throttling.
 *
 * The IP rate limiter alone cannot stop an attacker who spreads guesses for ONE account across
 * many addresses. After LOGIN_MAX_FAILURES consecutive wrong passwords within the window, the
 * account refuses logins for LOGIN_LOCK_MINUTES. State lives on the User document and is updated
 * with one atomic MongoDB pipeline, so concurrent guesses (even on different instances) cannot
 * slip under the limit.
 *
 * To avoid revealing which accounts exist, a locked account answers exactly like a wrong
 * password (the caller still performs a password hash for timing parity). The owner can always
 * recover through "forgot password", which clears the lock.
 *
 * Trade-off: someone who knows an email can keep that account locked by guessing. The IP rate
 * limiter bounds how fast they can do so from one address.
 */

export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_LOCK_MINUTES = 15;

const positiveInt = (raw, fallback) => {
  const value = Number(String(raw ?? '').trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * @param {object} [env=process.env]
 * @returns {{ maxFailures: number, lockMs: number, windowMs: number }}
 */
export const getLoginThrottleConfig = (env = process.env) => {
  const lockMs = positiveInt(env.LOGIN_LOCK_MINUTES, DEFAULT_LOCK_MINUTES) * 60 * 1000;
  return {
    maxFailures: positiveInt(env.LOGIN_MAX_FAILURES, DEFAULT_MAX_FAILURES),
    lockMs,
    windowMs: lockMs, // failures older than one lock period no longer count
  };
};

/** @returns {boolean} True while the loaded user document is locked out */
export const isLoginLocked = (user, now = Date.now()) =>
  Boolean(user?.lockedUntil) && new Date(user.lockedUntil).getTime() > now;

/**
 * Records one wrong-password attempt atomically and locks the account when the limit is hit.
 *
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {{ now?: number, config?: object }} [options]
 */
export const recordLoginFailure = async (userId, { now = Date.now(), config = getLoginThrottleConfig() } = {}) => {
  const nowDate = new Date(now);
  const windowStart = new Date(now - config.windowMs);
  const lockUntil = new Date(now + config.lockMs);
  const inWindow = { $gt: [{ $ifNull: ['$loginFailureAt', new Date(0)] }, windowStart] };

  await User.updateOne({ _id: userId }, [
    {
      $set: {
        loginFailureCount: { $cond: [inWindow, { $add: [{ $ifNull: ['$loginFailureCount', 0] }, 1] }, 1] },
        loginFailureAt: nowDate,
      },
    },
    { $set: { lockedUntil: { $cond: [{ $gte: ['$loginFailureCount', config.maxFailures] }, lockUntil, '$lockedUntil'] } } },
    // A fresh lock starts a fresh count, so the first failure after it expires is failure #1
    { $set: { loginFailureCount: { $cond: [{ $gt: ['$lockedUntil', nowDate] }, 0, '$loginFailureCount'] } } },
  ]);
};

/** Clears the failure counter and any lock (after a successful login or a password reset). */
export const clearLoginFailures = (userId) =>
  User.updateOne({ _id: userId }, { $unset: { loginFailureCount: '', loginFailureAt: '', lockedUntil: '' } });
