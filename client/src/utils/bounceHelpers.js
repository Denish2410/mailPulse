/**
 * Pure helpers for bounce and complaint display (Phase 12).
 */

const TYPES = {
  hard_bounce: {
    label: 'Hard bounce',
    pillClass: 'bg-rose-500/10 text-rose-300 border border-rose-500/20',
    note: 'Address is permanently undeliverable and has been suppressed.',
  },
  soft_bounce: {
    label: 'Soft bounce',
    pillClass: 'bg-amber-500/10 text-amber-300 border border-amber-500/20',
    note: 'Temporary problem. Suppressed after 3 soft bounces in 30 days.',
  },
  complaint: {
    label: 'Spam complaint',
    pillClass: 'bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/20',
    note: 'Recipient marked the email as spam and has been suppressed.',
  },
};

/**
 * @param {string|unknown} eventType
 * @returns {{ label: string, pillClass: string, note: string }}
 */
export const getBounceTypeInfo = (eventType) =>
  TYPES[eventType] ?? {
    label: 'Unknown',
    pillClass: 'bg-slate-800/80 text-slate-400 border border-slate-700',
    note: '',
  };

/**
 * Normalizes the bounces payload; tolerant of missing or malformed data.
 *
 * @param {unknown} data
 * @returns {{ summary: { hardBounces: number, softBounces: number, complaints: number, total: number }, events: Array<object> }}
 */
export const extractBounceData = (data) => {
  const num = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const summary = {
    hardBounces: num(data?.summary?.hardBounces),
    softBounces: num(data?.summary?.softBounces),
    complaints: num(data?.summary?.complaints),
    total: 0,
  };
  summary.total = summary.hardBounces + summary.softBounces + summary.complaints;
  const events = Array.isArray(data?.events)
    ? data.events.filter((e) => e && typeof e.email === 'string' && typeof e.eventType === 'string')
    : [];
  return { summary, events };
};

/**
 * Bounce rate against the number of recipients, as a percentage string (e.g. "2.5%").
 * Complaints are excluded; they are reported separately.
 */
export const formatBounceRate = (summary, sentCount) => {
  const sent = Number(sentCount);
  if (!Number.isFinite(sent) || sent <= 0) return '—';
  const bounced = (summary?.hardBounces ?? 0) + (summary?.softBounces ?? 0);
  return `${Math.min(100, Math.round((bounced / sent) * 1000) / 10)}%`;
};
