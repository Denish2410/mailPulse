/**
 * Pure helpers for the suppression list UI.
 */

const SOURCES = {
  link: { label: 'Unsubscribed (link)', pillClass: 'bg-amber-500/10 text-amber-300 border border-amber-500/20' },
  'one-click-header': { label: 'Unsubscribed (one-click)', pillClass: 'bg-amber-500/10 text-amber-300 border border-amber-500/20' },
  admin: { label: 'Added manually', pillClass: 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20' },
  import: { label: 'Imported', pillClass: 'bg-sky-500/10 text-sky-300 border border-sky-500/20' },
  bounce: { label: 'Bounced', pillClass: 'bg-rose-500/10 text-rose-300 border border-rose-500/20' },
  complaint: { label: 'Spam complaint', pillClass: 'bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/20' },
};

export const SOURCE_FILTER_OPTIONS = Object.freeze([
  { value: '', label: 'All sources' },
  ...Object.entries(SOURCES).map(([value, { label }]) => ({ value, label })),
]);

/**
 * @param {string|unknown} source
 * @returns {{ label: string, pillClass: string }}
 */
export const getSuppressionSourceInfo = (source) =>
  SOURCES[source] ?? { label: 'Unknown', pillClass: 'bg-slate-800/80 text-slate-400 border border-slate-700' };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validates the manual-suppression form. Returns field errors (empty when valid).
 */
export const validateSuppressionForm = ({ email, reason } = {}) => {
  const errors = {};
  const trimmed = typeof email === 'string' ? email.trim() : '';
  if (!trimmed) errors.email = 'Email is required.';
  else if (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) errors.email = 'Enter a valid email address.';
  if (typeof reason === 'string' && reason.trim().length > 250) errors.reason = 'Reason cannot exceed 250 characters.';
  return errors;
};

/**
 * Friendly messages for suppression API failures.
 */
export const getSuppressionErrorMessage = (error) => {
  switch (error?.response?.status) {
    case 400:
      return 'Please check the details and try again.';
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 404:
      return 'This entry no longer exists. Refresh and try again.';
    case 409:
      return error?.response?.data?.message || 'That change is not allowed.';
    default:
      return 'Something went wrong. Please try again.';
  }
};
