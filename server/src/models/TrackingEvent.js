import mongoose from 'mongoose';

/**
 * TrackingEvent Mongoose Schema
 *
 * Defines the email open and click event data model for MailPulse (Phase 7).
 * Records engagement telemetry when recipients view emails or click tracked links.
 *
 * Architecture & Data Integrity:
 * - Scoped to Campaign (`campaignId` ref: 'Campaign').
 * - Stores recipient contact reference (`recipientId` ref: 'Contact', optional).
 * - Stores normalized recipient email address for deduplication and rate calculations.
 * - Supports 'open' and 'click' event types.
 * - For 'click' events, stores the validated destination `targetUrl`.
 * - Records sanitized request metadata (client IP and User-Agent) for auditing.
 */
const trackingEventSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: [true, 'Campaign ID is required'],
      index: true,
    },
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      default: null,
    },
    recipientEmail: {
      type: String,
      required: [true, 'Recipient email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Recipient email cannot exceed 254 characters'],
    },
    eventType: {
      type: String,
      required: [true, 'Event type is required'],
      enum: {
        values: ['open', 'click'],
        message: 'Event type must be either open or click',
      },
      index: true,
    },
    targetUrl: {
      type: String,
      trim: true,
      default: null,
      maxlength: [2048, 'Target URL cannot exceed 2048 characters'],
    },
    ip: {
      type: String,
      default: null,
      trim: true,
      maxlength: [100, 'IP address cannot exceed 100 characters'],
    },
    userAgent: {
      type: String,
      default: null,
      trim: true,
      maxlength: [500, 'User agent cannot exceed 500 characters'],
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

/**
 * Compound indexes for high-performance analytics aggregation:
 * - Campaign overview metrics: total & unique opens/clicks sorted by time
 * - Per-recipient engagement deduplication
 * - Per-link click aggregation
 */
trackingEventSchema.index({ campaignId: 1, eventType: 1, timestamp: -1 });
trackingEventSchema.index({ campaignId: 1, recipientEmail: 1, eventType: 1 });
trackingEventSchema.index({ campaignId: 1, targetUrl: 1, eventType: 1 });

const TrackingEvent =
  mongoose.models.TrackingEvent || mongoose.model('TrackingEvent', trackingEventSchema);

export { trackingEventSchema };
export default TrackingEvent;
