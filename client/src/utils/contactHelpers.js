/**
 * Pure helper utilities for Contacts UI
 */

/**
 * Safely format an ISO date string into a user-friendly locale date.
 * Gracefully handles invalid, null, or undefined values without throwing.
 *
 * @param {string|Date|unknown} dateValue
 * @returns {string} Formatted date (e.g. "Oct 18, 2026") or "—" fallback
 */
export const formatContactDate = (dateValue) => {
  if (!dateValue) return '—';

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch {
    return '—';
  }
};

/**
 * Normalizes an email domain input by trimming whitespace,
 * lowercasing, and removing any accidental leading '@'.
 *
 * @param {string|unknown} domain
 * @returns {string} Cleaned domain string
 */
export const normalizeEmailDomain = (domain) => {
  if (typeof domain !== 'string') return '';
  const trimmed = domain.trim().toLowerCase();
  return trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
};

/**
 * Calculates the appropriate page index after deleting a contact.
 * If deleting the sole contact on page N leaves page N empty,
 * it decrements the page to N - 1 (minimum 1).
 *
 * @param {{ currentPage: number, totalCount: number, limit: number }} options
 * @returns {number} The safe page number to navigate to (minimum 1)
 */
export const computePageAfterDeletion = ({ currentPage = 1, totalCount = 0, limit = 20 } = {}) => {
  const safePage = Math.max(1, Number(currentPage) || 1);
  const safeLimit = Math.max(1, Number(limit) || 20);
  const remainingTotal = Math.max(0, (Number(totalCount) || 0) - 1);

  if (remainingTotal === 0) {
    return 1;
  }

  const remainingTotalPages = Math.ceil(remainingTotal / safeLimit);
  if (safePage > remainingTotalPages) {
    return remainingTotalPages;
  }

  return safePage;
};

export default {
  formatContactDate,
  normalizeEmailDomain,
  computePageAfterDeletion,
};
