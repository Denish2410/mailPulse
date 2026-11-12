/**
 * Shutdown timing configuration.
 *
 * SHUTDOWN_TIMEOUT_MS bounds how long the server may spend finishing in-flight sends, releasing
 * campaign leases and closing connections after SIGTERM before it forces the exit. A container
 * runtime sends SIGKILL once its own stop grace period ends, so the application timeout has to be
 * shorter than that period, with a margin to spare. Docker Compose passes the period it uses as
 * STOP_GRACE_SECONDS (see docker-compose.yml); when it is set, a SHUTDOWN_TIMEOUT_MS that would
 * not fit is rejected at startup instead of being killed mid-shutdown.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
export const MIN_SHUTDOWN_TIMEOUT_MS = 1000;
export const MAX_SHUTDOWN_TIMEOUT_MS = 10 * 60 * 1000;
/** Time that must remain between our forced exit and the runtime's SIGKILL. */
export const GRACE_MARGIN_MS = 5000;

const blank = (value) => value === undefined || value === null || String(value).trim() === '';
const strictInteger = (value) => (/^\d+$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN);

/**
 * Lenient reader used by the shutdown handler itself: never throws, falls back to the default.
 * (Invalid values are reported by validateShutdownConfig at startup.)
 */
export const getShutdownTimeoutMs = (env = process.env) => {
  if (blank(env.SHUTDOWN_TIMEOUT_MS)) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const value = strictInteger(env.SHUTDOWN_TIMEOUT_MS);
  return value >= MIN_SHUTDOWN_TIMEOUT_MS && value <= MAX_SHUTDOWN_TIMEOUT_MS
    ? value
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
};

/**
 * Strict startup validation.
 *
 * @param {object} [env=process.env]
 * @returns {{ timeoutMs: number, graceMs: number|null }}
 * @throws {Error} For an invalid SHUTDOWN_TIMEOUT_MS or STOP_GRACE_SECONDS, or a timeout that
 *   does not leave GRACE_MARGIN_MS before the container's stop grace period ends.
 */
export const validateShutdownConfig = (env = process.env) => {
  let timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!blank(env.SHUTDOWN_TIMEOUT_MS)) {
    timeoutMs = strictInteger(env.SHUTDOWN_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_SHUTDOWN_TIMEOUT_MS || timeoutMs > MAX_SHUTDOWN_TIMEOUT_MS) {
      throw new Error(
        `Shutdown configuration error: SHUTDOWN_TIMEOUT_MS must be a whole number of milliseconds between ${MIN_SHUTDOWN_TIMEOUT_MS} and ${MAX_SHUTDOWN_TIMEOUT_MS}.`
      );
    }
  }

  let graceMs = null;
  if (!blank(env.STOP_GRACE_SECONDS)) {
    const seconds = strictInteger(env.STOP_GRACE_SECONDS);
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new Error('Shutdown configuration error: STOP_GRACE_SECONDS must be a positive whole number of seconds.');
    }
    graceMs = seconds * 1000;
    if (timeoutMs > graceMs - GRACE_MARGIN_MS) {
      throw new Error(
        `Shutdown configuration error: SHUTDOWN_TIMEOUT_MS (${timeoutMs}) must be at least ${GRACE_MARGIN_MS} ms shorter than the container stop grace period (STOP_GRACE_SECONDS=${seconds}). ` +
          'Lower SHUTDOWN_TIMEOUT_MS or raise STOP_GRACE_SECONDS.'
      );
    }
  }
  return { timeoutMs, graceMs };
};
