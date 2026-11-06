import mongoose from 'mongoose';

/**
 * BounceEvent Mongoose Schema (Phase 12)
 *
 * Audit record of an inbound bounce or spam complaint reported by an email service provider
 * webhook and matched to one of our Delivery records.
 *
 * Integrity:
 * - Only events matched to a Delivery are stored, so `userId` always comes from our own data and
 *   never from the webhook payload.
 * - `{ provider, providerEventId }` is unique, which makes webhook retries idempotent.
 * - `reason` is a short sanitized string; raw provider payloads are never stored.
 */
export const BOUNCE_PROVIDERS = ['sendgrid', 'mailgun', 'ses'];
export const BOUNCE_EVENT_TYPES = ['hard_bounce', 'soft_bounce', 'complaint'];

const bounceEventSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: [true, 'campaignId is required'],
    },
    deliveryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Delivery',
      required: [true, 'deliveryId is required'],
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      default: null,
    },
    email: {
      type: String,
      required: [true, 'Recipient email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Recipient email cannot exceed 254 characters'],
    },
    provider: {
      type: String,
      required: [true, 'Provider is required'],
      enum: { values: BOUNCE_PROVIDERS, message: 'Provider must be sendgrid, mailgun, or ses' },
    },
    eventType: {
      type: String,
      required: [true, 'Event type is required'],
      enum: {
        values: BOUNCE_EVENT_TYPES,
        message: 'Event type must be hard_bounce, soft_bounce, or complaint',
      },
    },
    reason: {
      type: String,
      trim: true,
      default: null,
      maxlength: [200, 'Reason cannot exceed 200 characters'],
    },
    providerEventId: {
      type: String,
      required: [true, 'Provider event ID is required'],
      trim: true,
      maxlength: [300, 'Provider event ID cannot exceed 300 characters'],
    },
    occurredAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

bounceEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });
bounceEventSchema.index({ userId: 1, email: 1, eventType: 1, occurredAt: -1 });
bounceEventSchema.index({ campaignId: 1, eventType: 1 });

const BounceEvent = mongoose.models.BounceEvent || mongoose.model('BounceEvent', bounceEventSchema);

export default BounceEvent;
