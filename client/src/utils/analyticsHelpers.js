import { describeDeliveryError } from './campaignHelpers.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 97.5 -> "97.5%", null -> "—" */
export const formatRate = (rate) =>
  typeof rate === 'number' && Number.isFinite(rate) ? `${rate}%` : '—';

/** 12345 -> "12,345" (locale-independent so output is stable in tests) */
export const formatCount = (value) =>
  String(Math.max(0, Math.trunc(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "2026-10-30" -> "Oct 30" (UTC date key, no timezone shifting) */
export const formatDayLabel = (dateKey) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return '';
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}`;
};

/** Chart rows with a readable label. */
export const toChartData = (daily = []) =>
  (Array.isArray(daily) ? daily : []).map((d) => ({
    ...d,
    label: formatDayLabel(d.date),
  }));

/** True when the window contains at least one finished delivery. */
export const hasDeliveryActivity = (daily = []) =>
  Array.isArray(daily) && daily.some((d) => (d.sent || 0) + (d.failed || 0) > 0);

/** Human-readable failure reasons with share of all failures. */
export const describeFailureReasons = (reasons = []) => {
  const list = Array.isArray(reasons) ? reasons : [];
  const total = list.reduce((sum, r) => sum + (r.count || 0), 0);
  return list.map((r) => ({
    code: r.code,
    count: r.count,
    label: describeDeliveryError(r.code) || 'Unknown error',
    share: total > 0 ? Math.round((r.count / total) * 100) : 0,
  }));
};

/** Tailwind text color for an acceptance rate. */
export const getRateTone = (rate) => {
  if (typeof rate !== 'number') return 'text-slate-300';
  if (rate >= 95) return 'text-emerald-300';
  if (rate >= 80) return 'text-amber-300';
  return 'text-rose-300';
};

export default {
  formatRate,
  formatCount,
  formatDayLabel,
  toChartData,
  hasDeliveryActivity,
  describeFailureReasons,
  getRateTone,
};
