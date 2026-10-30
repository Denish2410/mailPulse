import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import Campaign, { CAMPAIGN_STATUSES } from '../models/Campaign.js';
import Delivery from '../models/Delivery.js';

/**
 * Analytics Service (Phase 6)
 *
 * Builds an owner-scoped overview from existing Contact, Campaign and Delivery records.
 * Every query filters on `userId`, so one tenant can never see another tenant's numbers.
 *
 * Semantics: a delivery counted as `sent` was ACCEPTED by the SMTP transport. Opens, clicks
 * and bounces are not tracked yet, so the rate reported here is an acceptance rate, not a
 * delivery rate.
 */
export const ANALYTICS_RANGES = [7, 30, 90];
export const DEFAULT_ANALYTICS_DAYS = 30;
export const RECENT_CAMPAIGNS_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC of the given date. */
export const startOfUtcDay = (date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** Percentage with one decimal, or null when there is nothing to measure. */
export const computeRate = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

/**
 * Expands sparse aggregation rows into one entry per UTC day (oldest first),
 * filling days without activity with zeros so charts have a continuous axis.
 *
 * @param {Array<{ _id: string, sent: number, failed: number }>} rows
 * @param {number} days
 * @param {Date} now
 */
export const buildDailySeries = (rows, days, now = new Date()) => {
  const byDate = new Map(rows.map((row) => [row._id, row]));
  const end = startOfUtcDay(now).getTime();
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(end - i * DAY_MS).toISOString().slice(0, 10);
    const row = byDate.get(date);
    series.push({ date, sent: row?.sent ?? 0, failed: row?.failed ?? 0 });
  }
  return series;
};

const countsByKey = (rows) =>
  rows.reduce((acc, row) => {
    acc[row._id] = row.count;
    return acc;
  }, {});

/**
 * @param {string} userId - Authenticated owner id
 * @param {{ days?: number, now?: Date }} [options]
 */
export const getAnalyticsOverview = async (userId, { days = DEFAULT_ANALYTICS_DAYS, now = new Date() } = {}) => {
  const owner = new mongoose.Types.ObjectId(String(userId));
  const since = new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);

  const [contactsTotal, campaignRows, deliveryRows, dailyRows, failureRows, recent] =
    await Promise.all([
      Contact.countDocuments({ userId: owner }),
      Campaign.aggregate([
        { $match: { userId: owner } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Delivery.aggregate([
        { $match: { userId: owner } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Delivery.aggregate([
        {
          $match: {
            userId: owner,
            $or: [
              { status: 'sent', sentAt: { $gte: since } },
              { status: 'failed', failedAt: { $gte: since } },
            ],
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                timezone: 'UTC',
                date: { $cond: [{ $eq: ['$status', 'sent'] }, '$sentAt', '$failedAt'] },
              },
            },
            sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          },
        },
      ]),
      Delivery.aggregate([
        { $match: { userId: owner, status: 'failed' } },
        { $group: { _id: { $ifNull: ['$errorCode', 'UNKNOWN_ERROR'] }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ]),
      Campaign.find({ userId: owner, status: { $ne: 'draft' } })
        .sort({ sendStartedAt: -1, _id: -1 })
        .limit(RECENT_CAMPAIGNS_LIMIT)
        .select('name subject status stats sendStartedAt sendCompletedAt')
        .lean(),
    ]);

  const campaignCounts = countsByKey(campaignRows);
  const byStatus = Object.fromEntries(CAMPAIGN_STATUSES.map((s) => [s, campaignCounts[s] || 0]));

  const deliveryCounts = countsByKey(deliveryRows);
  const sent = deliveryCounts.sent || 0;
  const failed = deliveryCounts.failed || 0;
  const inProgress = (deliveryCounts.pending || 0) + (deliveryCounts.processing || 0);

  const daily = buildDailySeries(dailyRows, days, now);
  const periodSent = daily.reduce((sum, d) => sum + d.sent, 0);
  const periodFailed = daily.reduce((sum, d) => sum + d.failed, 0);

  return {
    range: { days, since: since.toISOString(), until: now.toISOString() },
    contacts: { total: contactsTotal },
    campaigns: {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
    },
    deliveries: {
      total: sent + failed + inProgress,
      sent,
      failed,
      inProgress,
      acceptanceRate: computeRate(sent, sent + failed),
    },
    period: {
      sent: periodSent,
      failed: periodFailed,
      acceptanceRate: computeRate(periodSent, periodSent + periodFailed),
    },
    daily,
    failureReasons: failureRows.map((row) => ({ code: row._id, count: row.count })),
    recentCampaigns: recent.map((c) => ({
      id: c._id.toString(),
      name: c.name,
      subject: c.subject,
      status: c.status,
      stats: {
        total: c.stats?.total || 0,
        sent: c.stats?.sent || 0,
        failed: c.stats?.failed || 0,
      },
      acceptanceRate: computeRate(c.stats?.sent || 0, (c.stats?.sent || 0) + (c.stats?.failed || 0)),
      sendStartedAt: c.sendStartedAt,
      sendCompletedAt: c.sendCompletedAt,
    })),
  };
};

export default { getAnalyticsOverview, buildDailySeries, computeRate, startOfUtcDay };
