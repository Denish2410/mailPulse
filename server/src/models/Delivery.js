import mongoose from 'mongoose';

/**
 * Delivery Mongoose Schema (Phase 5)
 *
 * One Delivery document records the dispatch of one campaign to one recipient.
 *
 * Design:
 * - Recipient snapshot: `email` and `name` are copied from the Contact when the send starts, so
 *   later contact edits or deletions never change who a campaign was actually sent to.
 * - Exactly-once records: the unique `{ campaignId, contactId }` index guarantees a recipient
 *   gets at most one Delivery per campaign, even if dispatch is retried or resumed.
 * - At-most-once sending: the dispatcher claims a delivery by atomically moving it from
 *   'pending' to 'processing' before calling the transport. A delivery found in 'processing'
 *   after a crash is marked failed ('INTERRUPTED') instead of being sent again, because the
 *   transport may already have accepted it.
 * - Sanitized errors: only an error code is stored, never raw SMTP/provider messages.
 * - Tenant scoping: `userId` is denormalized so every query can be owner-scoped.
 */
export const DELIVERY_STATUSES = ['pending', 'processing', 'sent', 'failed'];

export const DELIVERY_ERROR_CODES = [
  'INVALID_MESSAGE',
  'CONFIGURATION_ERROR',
  'TRANSPORT_ERROR',
  'INTERRUPTED',
  'UNKNOWN_ERROR',
];

const deliverySchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: [true, 'campaignId is required'],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: [true, 'contactId is required'],
    },
    email: {
      type: String,
      required: [true, 'Recipient email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Recipient email cannot exceed 254 characters'],
    },
    name: {
      type: String,
      trim: true,
      default: '',
      maxlength: [100, 'Recipient name cannot exceed 100 characters'],
    },
    status: {
      type: String,
      enum: {
        values: DELIVERY_STATUSES,
        message: 'Status must be one of pending, processing, sent, or failed',
      },
      default: 'pending',
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    messageId: {
      type: String,
      default: null,
    },
    errorCode: {
      type: String,
      enum: {
        values: DELIVERY_ERROR_CODES,
        message: 'Unsupported delivery error code',
      },
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * One delivery per recipient per campaign.
 */
deliverySchema.index({ campaignId: 1, contactId: 1 }, { unique: true });

/**
 * Dispatcher work queue and per-status counts for a campaign.
 */
deliverySchema.index({ campaignId: 1, status: 1 });

/**
 * Owner-scoped listing of a campaign's deliveries.
 */
deliverySchema.index({ userId: 1, campaignId: 1, createdAt: 1 });

// Prevent model overwrite in development watch and test runners
const Delivery = mongoose.models.Delivery || mongoose.model('Delivery', deliverySchema);

export { deliverySchema };
export default Delivery;
