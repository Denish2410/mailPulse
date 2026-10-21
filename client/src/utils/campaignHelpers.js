/**
 * Pure helper utilities for Campaigns UI
 */

/**
 * Safely format an ISO date string into a user-friendly locale date.
 * Gracefully handles invalid, null, or undefined values without throwing.
 *
 * @param {string|Date|unknown} dateValue
 * @returns {string} Formatted date (e.g. "Oct 21, 2026") or "—" fallback
 */
export const formatCampaignDate = (dateValue) => {
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
 * Maps campaign status to human-readable label and Tailwind badge classes.
 *
 * @param {string|unknown} status
 * @returns {{ label: string, pillClass: string }}
 */
export const getCampaignStatusBadge = (status) => {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  switch (normalized) {
    case 'draft':
      return {
        label: 'Draft',
        pillClass: 'bg-amber-500/10 text-amber-300 border border-amber-500/20',
      };
    case 'sending':
      return {
        label: 'Sending',
        pillClass: 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20',
      };
    case 'sent':
      return {
        label: 'Sent',
        pillClass: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20',
      };
    default:
      return {
        label: normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Unknown',
        pillClass: 'bg-slate-800/80 text-slate-400 border border-slate-700',
      };
  }
};

/**
 * Normalizes a search query string by trimming whitespace.
 *
 * @param {string|unknown} search
 * @returns {string} Cleaned search query
 */
export const normalizeSearchQuery = (search) => {
  if (typeof search !== 'string') return '';
  return search.trim();
};

/**
 * Calculates the appropriate page index after deleting a campaign.
 * If deleting the sole item on page N leaves page N empty,
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
  formatCampaignDate,
  getCampaignStatusBadge,
  normalizeSearchQuery,
  computePageAfterDeletion,
};
