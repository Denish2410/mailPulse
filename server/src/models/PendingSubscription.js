import mongoose from 'mongoose';

/**
 * PendingSubscription (double opt-in)
 *
 * Created when someone submits a public signup form and removed when they confirm via the emailed
 * link or after expiry (TTL index). Only the SHA-256 hash of the confirmation token is stored.
 * One pending record per `{ formId, email }`.
 */
export const PENDING_TTL_MS = 48 * 60 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 5 * 60 * 1000;

const pendingSubscriptionSchema = new mongoose.Schema(
  {
    formId: { type: mongoose.Schema.Types.ObjectId, ref: 'SignupForm', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    name: { type: String, trim: true, default: '', maxlength: 100 },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

pendingSubscriptionSchema.index({ formId: 1, email: 1 }, { unique: true });
// MongoDB removes the document once `expiresAt` has passed
pendingSubscriptionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PendingSubscription =
  mongoose.models.PendingSubscription || mongoose.model('PendingSubscription', pendingSubscriptionSchema);

export default PendingSubscription;
