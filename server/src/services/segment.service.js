import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import Campaign from '../models/Campaign.js';
import TrackingEvent from '../models/TrackingEvent.js';
import { normalizeTags } from '../utils/tags.js';

/**
 * MailPulse Segment Evaluation (Phase 11)
 *
 * A segment is a saved set of criteria evaluated against the owner's contacts at the moment it
 * is used. Criteria (all optional, combined with AND; at least one is required):
 *
 *   tagsAny:  contact has at least one of these tags
 *   tagsAll:  contact has every one of these tags
 *   tagsNone: contact has none of these tags
 *   engagement: { type: 'opened' | 'clicked' | 'not_opened', days: 1..365 }
 *   createdWithinDays: contact was created in the last N days
 *
 * Unsubscribed contacts are never part of a segment. Everything is scoped to `userId`; engagement
 * is derived only from tracking events of campaigns the user owns.
 */

export const ENGAGEMENT_TYPES = Object.freeze(['opened', 'clicked', 'not_opened']);
export const MAX_ENGAGEMENT_DAYS = 365;
export const MAX_SEGMENT_TAGS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalizes untrusted criteria into the canonical shape. Unknown keys are dropped.
 *
 * @param {object} criteria
 * @returns {{ tagsAny: string[], tagsAll: string[], tagsNone: string[],
 *   engagement: { type: string, days: number }|null, createdWithinDays: number|null }}
 */
export const normalizeCriteria = (criteria = {}) => {
  const days = (value) =>
    Number.isInteger(value) && value >= 1 && value <= MAX_ENGAGEMENT_DAYS ? value : null;

  const engagement =
    criteria?.engagement &&
    ENGAGEMENT_TYPES.includes(criteria.engagement.type) &&
    days(criteria.engagement.days)
      ? { type: criteria.engagement.type, days: criteria.engagement.days }
      : null;

  return {
    tagsAny: normalizeTags(criteria?.tagsAny).slice(0, MAX_SEGMENT_TAGS),
    tagsAll: normalizeTags(criteria?.tagsAll).slice(0, MAX_SEGMENT_TAGS),
    tagsNone: normalizeTags(criteria?.tagsNone).slice(0, MAX_SEGMENT_TAGS),
    engagement,
    createdWithinDays: days(criteria?.createdWithinDays),
  };
};

/**
 * @param {ReturnType<typeof normalizeCriteria>} criteria
 * @returns {boolean} True when at least one condition is set
 */
export const hasCriteria = (criteria) =>
  criteria.tagsAny.length > 0 ||
  criteria.tagsAll.length > 0 ||
  criteria.tagsNone.length > 0 ||
  criteria.engagement !== null ||
  criteria.createdWithinDays !== null;

/**
 * Emails with a given engagement event in the window, across the owner's campaigns only.
 */
const getEngagedEmails = async (userId, eventType, days, now) => {
  const campaignIds = await Campaign.distinct('_id', { userId });
  if (campaignIds.length === 0) return [];
  return TrackingEvent.distinct('recipientEmail', {
    campaignId: { $in: campaignIds },
    eventType,
    timestamp: { $gte: new Date(now.getTime() - days * DAY_MS) },
  });
};

/**
 * Builds the MongoDB filter for a segment, scoped to the owner.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {object} rawCriteria
 * @param {{ now?: Date }} [options]
 * @returns {Promise<object>}
 */
export const buildSegmentFilter = async (userId, rawCriteria, { now = new Date() } = {}) => {
  const criteria = normalizeCriteria(rawCriteria);
  const filter = { userId: new mongoose.Types.ObjectId(String(userId)), isUnsubscribed: { $ne: true } };
  const and = [];

  if (criteria.tagsAny.length > 0) and.push({ tags: { $in: criteria.tagsAny } });
  if (criteria.tagsAll.length > 0) and.push({ tags: { $all: criteria.tagsAll } });
  if (criteria.tagsNone.length > 0) and.push({ tags: { $nin: criteria.tagsNone } });

  if (criteria.createdWithinDays) {
    and.push({ createdAt: { $gte: new Date(now.getTime() - criteria.createdWithinDays * DAY_MS) } });
  }

  if (criteria.engagement) {
    const { type, days } = criteria.engagement;
    const emails = await getEngagedEmails(userId, type === 'clicked' ? 'click' : 'open', days, now);
    and.push({ email: type === 'not_opened' ? { $nin: emails } : { $in: emails } });
  }

  if (and.length > 0) filter.$and = and;
  return filter;
};

/**
 * Resolves the contacts matching a segment.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {object} rawCriteria
 * @param {{ limit?: number, now?: Date }} [options] - `limit` caps returned contacts (total is exact)
 * @returns {Promise<{ total: number, contacts: Array<object> }>}
 */
export const resolveSegment = async (userId, rawCriteria, { limit = 5000, now } = {}) => {
  const criteria = normalizeCriteria(rawCriteria);
  if (!hasCriteria(criteria)) {
    return { total: 0, contacts: [] };
  }
  const filter = await buildSegmentFilter(userId, criteria, { now });
  const [total, contacts] = await Promise.all([
    Contact.countDocuments(filter),
    Contact.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).lean(),
  ]);
  return { total, contacts };
};
