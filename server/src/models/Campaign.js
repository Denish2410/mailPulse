import mongoose from 'mongoose';

/**
 * Campaign Mongoose Schema
 *
 * Defines the email campaign data model for MailPulse (Phase 4).
 * Represents an authored email campaign belonging to an authenticated user.
 *
 * Ownership & Multi-Tenancy Architecture:
 * - Every campaign is strictly scoped to its creator (`userId` ref: 'User').
 * - Tenant isolation on recipient selection (`recipientIds`) is enforced at the
 *   controller / service boundary, where all supplied contact IDs must be verified
 *   to belong to the authenticated `userId`. The schema reference to 'Contact' alone
 *   does not enforce cross-tenant separation.
 *
 * Content Policy:
 * - Supports both plain-text (`textContent`) and HTML (`htmlContent`) bodies.
 * - Both fields default to an empty string to allow flexible draft creation and editing
 *   before final review.
 *
 * Recipient Handling:
 * - `recipientIds` stores an array of ObjectId references to `Contact`.
 * - Deleted contact IDs are intentionally retained in draft documents without cascade deletion;
 *   downstream dispatch/preview operations re-validate and prune inactive contacts.
 *
 * Status Lifecycle (Phase 5):
 * - 'draft'   : Editable authoring state (default).
 * - 'sending' : Locked. A dispatch has been accepted and per-recipient Delivery records are
 *               being processed. Entered only through an atomic draft -> sending transition so a
 *               campaign can never be dispatched twice.
 * - 'sent'    : Dispatch finished and at least one recipient was accepted by the transport.
 * - 'failed'  : Dispatch finished and no recipient was accepted by the transport.
 * Only drafts may be edited, deleted, test-emailed, or sent.
 *
 * Delivery Statistics:
 * - `stats` is a denormalized summary of the campaign's Delivery records, written by the
 *   dispatcher. Delivery documents remain the source of truth.
 */
/**
 * Supported campaign lifecycle states.
 */
export const CAMPAIGN_STATUSES = ['draft', 'sending', 'sent', 'failed'];

const campaignSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
    },
    name: {
      type: String,
      required: [true, 'Campaign name is required'],
      trim: true,
      minlength: [2, 'Campaign name must be at least 2 characters long'],
      maxlength: [120, 'Campaign name cannot exceed 120 characters'],
    },
    subject: {
      type: String,
      required: [true, 'Email subject is required'],
      trim: true,
      minlength: [1, 'Email subject cannot be empty'],
      maxlength: [200, 'Email subject cannot exceed 200 characters'],
    },
    textContent: {
      type: String,
      default: '',
      maxlength: [100000, 'Plain text content cannot exceed 100,000 characters'],
    },
    htmlContent: {
      type: String,
      default: '',
      maxlength: [500000, 'HTML content cannot exceed 500,000 characters'],
    },
    status: {
      type: String,
      enum: {
        values: CAMPAIGN_STATUSES,
        message: 'Status must be one of draft, sending, sent, or failed',
      },
      default: 'draft',
    },
    recipientIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Contact',
        },
      ],
      default: () => [],
    },
    sendStartedAt: {
      type: Date,
      default: null,
    },
    sendCompletedAt: {
      type: Date,
      default: null,
    },
    stats: {
      total: { type: Number, default: 0, min: 0 },
      sent: { type: Number, default: 0, min: 0 },
      failed: { type: Number, default: 0, min: 0 },
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Compound tenant query & sort index:
 * Optimizes listing campaigns scoped to the authenticated owner sorted newest-first.
 */
campaignSchema.index({ userId: 1, createdAt: -1 });

/**
 * Status index: lets the dispatcher find campaigns left in 'sending' after a restart.
 */
campaignSchema.index({ status: 1 });

// Prevent model overwrite in development watch and test runners
const Campaign = mongoose.models.Campaign || mongoose.model('Campaign', campaignSchema);

export { campaignSchema };
export default Campaign;
