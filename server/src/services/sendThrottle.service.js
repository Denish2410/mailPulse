/**
 * Send throttle (messages per minute).
 *
 * Spreads sends evenly across all dispatch workers in this process: each caller reserves the next
 * time slot (`60000 / ratePerMinute` ms apart) and waits for it. A rate of 0 (the default)
 * disables throttling. New sender domains should ramp up volume gradually ("warm-up"), and some
 * SMTP relays enforce per-minute limits; this keeps a large campaign inside them.
 *
 * Single-instance like the rest of the dispatcher: the schedule lives in process memory.
 */

export const MAX_SEND_RATE_PER_MINUTE = 100000;

/**
 * Resolves the rate from CAMPAIGN_SEND_RATE_PER_MINUTE (integer 0..100000, default 0 = unlimited).
 *
 * @param {object} [env=process.env]
 * @returns {number}
 */
export const getSendRatePerMinute = (env = process.env) => {
  const raw = env.CAMPAIGN_SEND_RATE_PER_MINUTE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1) return 0;
  return Math.min(value, MAX_SEND_RATE_PER_MINUTE);
};

/**
 * @param {number} ratePerMinute - 0 disables throttling
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<void> }} [deps]
 * @returns {{ wait: () => Promise<void>, cancel: () => void, ratePerMinute: number }}
 */
export const createSendThrottle = (ratePerMinute, { now = Date.now, sleep } = {}) => {
  const interval = ratePerMinute > 0 ? 60000 / ratePerMinute : 0;
  let nextSlot = 0;
  const timers = new Set();

  const defaultSleep = (ms) =>
    new Promise((resolve) => {
      const entry = { resolve };
      entry.timer = setTimeout(() => {
        timers.delete(entry);
        resolve();
      }, ms);
      timers.add(entry);
    });
  const doSleep = sleep || defaultSleep;

  return {
    ratePerMinute,
    async wait() {
      if (interval === 0) return;
      const current = now();
      const slot = Math.max(current, nextSlot);
      nextSlot = slot + interval;
      const delay = slot - current;
      if (delay > 0) await doSleep(delay);
    },
    /** Releases every waiting caller immediately (used on shutdown). */
    cancel() {
      for (const entry of timers) {
        clearTimeout(entry.timer);
        entry.resolve();
      }
      timers.clear();
    },
  };
};

let sharedThrottle = null;

/**
 * Process-wide throttle that follows the current environment configuration.
 */
export const getSharedSendThrottle = (env = process.env) => {
  const rate = getSendRatePerMinute(env);
  if (!sharedThrottle || sharedThrottle.ratePerMinute !== rate) {
    sharedThrottle?.cancel();
    sharedThrottle = createSendThrottle(rate);
  }
  return sharedThrottle;
};

export const cancelSharedSendThrottle = () => sharedThrottle?.cancel();
