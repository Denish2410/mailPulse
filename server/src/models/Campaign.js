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
export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'paused', 'sent', 'failed'];

/**
 * Maximum recipients a single campaign may target.
 *
 * Bounds the blast radius of one send: it caps the number of Delivery records created per
 * dispatch, the size of the `$in` used to resolve recipients, and the volume one account can
 * queue in a single request. The per-user send rate limit bounds how many *requests* are
 * accepted; this bounds how many *messages* each request can produce.
 */
export const MAX_CAMPAIGN_RECIPIENTS = 5000;

/** One recipient of a locked campaign: contact id, email and name snapshot (short keys by design). */
const dispatchManifestEntrySchema = new mongoose.Schema(
  {
    c: { type: mongoose.Schema.Types.ObjectId, required: true },
    e: { type: String, required: true },
    n: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * The sender a locked campaign is bound to: stable sender account ID, the Google account (`sub`)
 * and the normalized address, captured by the same update that locks the recipient manifest. It is
 * what dispatch and recovery use; the live account must still match it, and nothing ever looks up
 * a different sender.
 */
const dispatchSenderSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    googleSub: { type: String, required: true, immutable: true },
    email: { type: String, required: true, immutable: true },
  },
  { _id: false }
);

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
    // Optional second subject for an A/B test: recipients are split evenly between `subject` (A)
    // and `subjectB` at send time. Empty = no test.
    subjectB: {
      type: String,
      trim: true,
      default: '',
      maxlength: [200, 'Variant B subject cannot exceed 200 characters'],
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
        message: 'Status must be one of draft, scheduled, sending, paused, sent, or failed',
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
      validate: {
        validator: (ids) => !Array.isArray(ids) || ids.length <= MAX_CAMPAIGN_RECIPIENTS,
        message: `A campaign cannot target more than ${MAX_CAMPAIGN_RECIPIENTS} recipients`,
      },
    },
    scheduledAt: {
      type: Date,
      default: null,
      index: true,
    },
    // The customer-owned Gmail account this campaign is sent from: chosen explicitly by the owner
    // (never defaulted, never replaced automatically). Null = no sender yet, so the campaign can
    // not be sent. Ownership and usability are verified by campaignSender.service.js.
    senderAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SenderAccount',
      default: null,
    },
    // Multi-instance dispatch lease (see dispatchLease.service.js): which instance is sending this
    // campaign, until when (MongoDB server time) and under which epoch. Absent/expired means any
    // instance may recover it. The epoch only ever increases (it survives releases) and is what
    // fences a stale worker: its claims, updates and finalization are conditional on it.
    dispatchLeaseOwner: {
      type: String,
      default: undefined,
    },
    dispatchLeaseUntil: {
      type: Date,
      default: undefined,
    },
    dispatchLeaseEpoch: {
      type: Number,
      default: undefined,
    },
    // Dispatch manifest (see utils/dispatchManifest.js): the exact recipient list this campaign was
    // locked to. All three fields are written ONLY by the update that moves the campaign to
    // 'sending' and takes the lease (an update pipeline), never one without the others. They are
    // immutable for every other write path (save(), updateOne/$set, $unset, ...).
    //   version - absent on campaigns locked before manifests existed; never inferred from data
    //   count   - number of entries the lock intended to write
    //   entries - { c: contact id, e: email, n: name }; excluded from every query unless explicitly
    //             selected with '+dispatchManifest', so it is never loaded or returned by accident
    dispatchManifestVersion: {
      type: Number,
      default: undefined,
      immutable: true,
    },
    dispatchManifestCount: {
      type: Number,
      default: undefined,
      min: 0,
      immutable: true,
    },
    dispatchManifest: {
      type: [dispatchManifestEntrySchema],
      default: undefined,
      select: false,
      immutable: true,
    },
    // 'paused': a locked campaign whose dispatch stopped because of its SENDER (disconnected,
    // revoked, identity changed, daily cap, Gmail refusing, an uncertain send). Sent and uncertain
    // deliveries are kept, unsent ones stay pending, and nothing resumes until the owner asks.
    pauseReason: { type: String, default: null, maxlength: 64, match: /^[A-Z][A-Z0-9_]*$/ },
    pausedAt: { type: Date, default: null },
    // Sender snapshot (see dispatchSenderSchema): written ONLY by the lock update, immutable after.
    dispatchSender: {
      type: dispatchSenderSchema,
      default: undefined,
      immutable: true,
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

/**
 * Scheduled dispatch index: lets the scheduler poll for due campaigns efficiently.
 */
campaignSchema.index({ status: 1, scheduledAt: 1 });

// Prevent model overwrite in development watch and test runners
const Campaign = mongoose.models.Campaign || mongoose.model('Campaign', campaignSchema);

export { campaignSchema };
export default Campaign;
