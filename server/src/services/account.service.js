import User from '../models/User.js';
import Contact from '../models/Contact.js';
import Campaign from '../models/Campaign.js';
import Delivery from '../models/Delivery.js';
import Template from '../models/Template.js';
import Segment from '../models/Segment.js';
import Suppression from '../models/Suppression.js';
import SignupForm from '../models/SignupForm.js';
import PendingSubscription from '../models/PendingSubscription.js';
import BounceEvent from '../models/BounceEvent.js';
import TrackingEvent from '../models/TrackingEvent.js';

/**
 * Account data rights (GDPR access/portability and erasure).
 *
 * Every collection is read and deleted strictly by the owner's `userId`. The exported file holds
 * the user's own data; credentials and one-time tokens are never included.
 */

const EXPORT_LIMIT_PER_COLLECTION = 100000;

/** Collections that hold user-owned documents, with the fields to leave out of exports. */
const OWNED_COLLECTIONS = [
  { key: 'contacts', model: Contact },
  { key: 'campaigns', model: Campaign, omit: ['dispatchLeaseOwner', 'dispatchLeaseUntil'] },
  { key: 'deliveries', model: Delivery },
  { key: 'templates', model: Template },
  { key: 'segments', model: Segment },
  { key: 'suppressions', model: Suppression },
  { key: 'signupForms', model: SignupForm },
  { key: 'bounceEvents', model: BounceEvent },
];

/** Tracking events carry no userId: they belong to the owner through their campaigns. */
const campaignIdsOf = (userId) => Campaign.distinct('_id', { userId });
const TRACKING_EXPORT_OMIT = { ip: 0, userAgent: 0 };

/**
 * Builds the full export for a user.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<object|null>} null when the user does not exist
 */
export const buildAccountExport = async (userId) => {
  const user = await User.findById(userId).lean();
  if (!user) return null;

  const data = {};
  const truncated = [];
  for (const { key, model, omit = [] } of OWNED_COLLECTIONS) {
    const projection = Object.fromEntries(omit.map((field) => [field, 0]));
    const rows = await model
      .find({ userId }, projection)
      .limit(EXPORT_LIMIT_PER_COLLECTION + 1)
      .lean();
    if (rows.length > EXPORT_LIMIT_PER_COLLECTION) {
      truncated.push(key);
      rows.length = EXPORT_LIMIT_PER_COLLECTION;
    }
    data[key] = rows;
  }

  const trackingRows = await TrackingEvent.find({ campaignId: { $in: await campaignIdsOf(userId) } }, TRACKING_EXPORT_OMIT)
    .limit(EXPORT_LIMIT_PER_COLLECTION + 1)
    .lean();
  if (trackingRows.length > EXPORT_LIMIT_PER_COLLECTION) {
    truncated.push('trackingEvents');
    trackingRows.length = EXPORT_LIMIT_PER_COLLECTION;
  }
  data.trackingEvents = trackingRows;

  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      status: user.status,
      mailingAddress: user.mailingAddress ?? '',
      emailVerifiedAt: user.emailVerifiedAt ?? null,
      createdAt: user.createdAt,
    },
    ...data,
    ...(truncated.length > 0 && { truncatedCollections: truncated }),
  };
};

/**
 * Permanently deletes a user and everything they own. Returns how many documents were removed
 * per collection. The caller must already have authenticated the request and checked that no
 * dispatch is running.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<Record<string, number>>}
 */
export const deleteAccountData = async (userId) => {
  const counts = {};
  // Tracking events first: they are found through the campaigns that are deleted below
  counts.trackingEvents = (
    await TrackingEvent.deleteMany({ campaignId: { $in: await campaignIdsOf(userId) } })
  ).deletedCount;
  for (const { key, model } of OWNED_COLLECTIONS) {
    counts[key] = (await model.deleteMany({ userId })).deletedCount;
  }
  counts.pendingSubscriptions = (await PendingSubscription.deleteMany({ userId })).deletedCount;
  // The user goes last: if anything above fails the account still exists and can retry
  counts.users = (await User.deleteOne({ _id: userId })).deletedCount;
  return counts;
};
