import mongoose from 'mongoose';

/**
 * GrantLock: a short-lived mutual-exclusion record, one per Google account (`google:<sub>`).
 * It serializes "is any other connection still using this grant? then revoke it" against "save a
 * connection for this grant", across processes. The unique key makes acquiring atomic; the TTL
 * index removes a lock whose holder died.
 */
const grantLockSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 300 },
    holder: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
grantLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const GrantLock = mongoose.models.GrantLock || mongoose.model('GrantLock', grantLockSchema);
export default GrantLock;
