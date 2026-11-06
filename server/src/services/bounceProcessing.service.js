import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import Contact from '../models/Contact.js';
import Suppression from '../models/Suppression.js';
import BounceEvent from '../models/BounceEvent.js';

/**
 * MailPulse Bounce & Complaint Processing (Phase 12)
 *
 * Applies normalized, already-authenticated webhook events (see webhookProviders.service.js).
 *
 * Tenant safety: an event is only acted on when it can be matched to one of OUR Delivery records,
 * first by the Delivery ID we tagged the message with, then by the transport message ID. The
 * owner (`userId`) always comes from that Delivery, never from the payload, and the event's
 * address must equal the Delivery's address. Unmatched events are counted and dropped.
 *
 * Policy:
 * - hard bounce       -> permanent suppression for that owner
 * - complaint         -> permanent suppression and the contact is marked unsubscribed
 * - soft bounce       -> recorded; suppression after SOFT_BOUNCE_THRESHOLD soft bounces for the
 *                        same address within SOFT_BOUNCE_WINDOW_DAYS
 *
 * Idempotent: the unique `{ provider, providerEventId }` key makes ESP retries harmless.
 */

export const SOFT_BOUNCE_THRESHOLD = 3;
export const SOFT_BOUNCE_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const findDelivery = async (event) => {
  let delivery = null;
  if (event.deliveryId && mongoose.isValidObjectId(event.deliveryId)) {
    delivery = await Delivery.findById(event.deliveryId).lean();
  }
  if (!delivery && event.messageId) {
    delivery = await Delivery.findOne({
      messageId: { $in: [event.messageId, `<${event.messageId}>`] },
      email: event.email,
    }).lean();
  }
  if (!delivery || delivery.email !== event.email) return null;
  return delivery;
};

const suppress = async (delivery, source, reason, now) => {
  const result = await Suppression.updateOne(
    { userId: delivery.userId, email: delivery.email },
    {
      $setOnInsert: {
        userId: delivery.userId,
        email: delivery.email,
        campaignId: delivery.campaignId,
        reason: reason ? String(reason).slice(0, 250) : null,
        source,
        createdAt: now,
      },
    },
    { upsert: true }
  );
  return Boolean(result.upsertedCount > 0);
};

/**
 * @param {'sendgrid'|'mailgun'|'ses'} provider
 * @param {Array<object>} events - Normalized events from a verified webhook
 * @param {{ now?: Date, logger?: object }} [options]
 * @returns {Promise<{ received: number, processed: number, duplicates: number, unmatched: number, suppressed: number }>}
 */
export const processBounceEvents = async (provider, events, { now = new Date() } = {}) => {
  const summary = { received: events.length, processed: 0, duplicates: 0, unmatched: 0, suppressed: 0 };

  for (const event of events) {
    const delivery = await findDelivery(event);
    if (!delivery) {
      summary.unmatched += 1;
      continue;
    }

    try {
      await BounceEvent.create({
        userId: delivery.userId,
        campaignId: delivery.campaignId,
        deliveryId: delivery._id,
        contactId: delivery.contactId,
        email: delivery.email,
        provider,
        eventType: event.eventType,
        reason: event.reason,
        providerEventId: String(event.providerEventId).slice(0, 300),
        occurredAt: event.occurredAt instanceof Date ? event.occurredAt : now,
      });
    } catch (err) {
      if (err?.code === 11000) {
        summary.duplicates += 1;
        continue;
      }
      throw err;
    }
    summary.processed += 1;

    let suppressed = false;
    if (event.eventType === 'hard_bounce') {
      suppressed = await suppress(delivery, 'bounce', event.reason || 'Hard bounce', now);
    } else if (event.eventType === 'complaint') {
      suppressed = await suppress(delivery, 'complaint', 'Spam complaint', now);
      await Contact.updateMany(
        { _id: delivery.contactId, userId: delivery.userId },
        { $set: { isUnsubscribed: true, unsubscribedAt: now, unsubscribeReason: 'Spam complaint' } }
      );
    } else if (event.eventType === 'soft_bounce') {
      const recent = await BounceEvent.countDocuments({
        userId: delivery.userId,
        email: delivery.email,
        eventType: 'soft_bounce',
        occurredAt: { $gte: new Date(now.getTime() - SOFT_BOUNCE_WINDOW_DAYS * DAY_MS) },
      });
      if (recent >= SOFT_BOUNCE_THRESHOLD) {
        suppressed = await suppress(delivery, 'bounce', 'Repeated soft bounces', now);
      }
    }
    if (suppressed) summary.suppressed += 1;
  }

  return summary;
};
