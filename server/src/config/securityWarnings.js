/**
 * Startup checks for settings that are legal but unsafe in production. They only WARN (changing
 * them can break links in emails that were already sent), but each one names what to set.
 *
 * @param {object} [env=process.env]
 * @returns {string[]} Human-readable warnings; empty outside production
 */
export const getSecurityWarnings = (env = process.env) => {
  if (env.NODE_ENV !== 'production') return [];
  const warnings = [];

  if (!String(env.TRACKING_SECRET ?? '').trim()) {
    warnings.push(
      'TRACKING_SECRET is not set: open/click/unsubscribe tokens are signed with JWT_SECRET, so one leaked key forges both. Set a separate TRACKING_SECRET (note: changing it invalidates links in emails already sent).'
    );
  }
  if (!String(env.CLIENT_URL ?? '').trim() || /localhost|127\.0\.0\.1/.test(env.CLIENT_URL)) {
    warnings.push('CLIENT_URL is unset or points at localhost: CORS and emailed links will be wrong in production.');
  }
  if (!String(env.TRACKING_BASE_URL ?? env.API_BASE_URL ?? '').trim()) {
    warnings.push('TRACKING_BASE_URL is not set: tracking and unsubscribe links in emails will point at localhost.');
  }
  return warnings;
};
