import crypto from 'node:crypto';
import GrantLock from '../models/GrantLock.js';

export const GRANT_LOCK_TTL_MS = 30_000;
export const GRANT_LOCK_WAIT_MS = 8_000;
const POLL_MS = 40;

export const grantLockKey = (providerAccountId) => `google:${String(providerAccountId)}`;

export class GrantLockBusyError extends Error {
  constructor() {
    super('The Google account is being updated by another request.');
    this.name = 'GrantLockBusyError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding the lock for `key`. Waits up to `waitMs` for a holder to finish, then
 * throws GrantLockBusyError (the caller decides whether that means "skip" or "try again").
 * A lock whose holder died expires by itself (TTL), and an expired one is replaced at once.
 */
export const withGrantLock = async (key, fn, { waitMs = GRANT_LOCK_WAIT_MS, ttlMs = GRANT_LOCK_TTL_MS } = {}) => {
  const holder = crypto.randomBytes(12).toString('hex');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await GrantLock.create({ key, holder, expiresAt: new Date(Date.now() + ttlMs) });
      break;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // The TTL monitor is not instant: remove a lock that has already expired
      await GrantLock.deleteOne({ key, expiresAt: { $lte: new Date() } });
      if (Date.now() >= deadline) throw new GrantLockBusyError();
      await sleep(POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await GrantLock.deleteOne({ key, holder }).catch(() => {});
  }
};

export default { withGrantLock, grantLockKey, GrantLockBusyError };
