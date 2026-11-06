import mongoose from 'mongoose';

/**
 * Suppression Mongoose Schema
 *
 * Defines the email suppression list model for MailPulse (Phase 8).
 * Records permanent unsubscribes and opt-outs scoped to an account owner.
 *
 * Architecture & Data Integrity:
 * - Scoped strictly to the owner (`userId` ref: 'User').
 * - Stores normalized lowercase email address.
 * - Compound unique index on `{ userId: 1, email: 1 }` prevents duplicates.
 * - If a contact is deleted and re-added by the account owner, their suppression
 *   record persists, preventing inadvertent resends.
 * - Tracks the triggering campaign (`campaignId`), unsubscribe source (`source`),
 *   and optional feedback reason (`reason`).
 */
const suppressionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
      index: true,
    },
    email: {
      type: String,
      required: [true, 'Suppressed email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Suppressed email cannot exceed 254 characters'],
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please provide a valid email address',
      ],
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      default: null,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
      maxlength: [250, 'Suppression reason cannot exceed 250 characters'],
    },
    source: {
      type: String,
      enum: {
        values: ['link', 'one-click-header', 'admin', 'import', 'bounce', 'complaint'],
        message:
          'Suppression source must be link, one-click-header, admin, import, bounce, or complaint',
      },
      default: 'link',
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Compound unique index: Guarantees that an email is suppressed at most once per account.
 */
suppressionSchema.index({ userId: 1, email: 1 }, { unique: true });

/**
 * Compound query & sort index: Optimizes retrieval of suppression lists scoped to an owner.
 */
suppressionSchema.index({ userId: 1, createdAt: -1 });

const Suppression =
  mongoose.models.Suppression || mongoose.model('Suppression', suppressionSchema);

export { suppressionSchema };
export default Suppression;
