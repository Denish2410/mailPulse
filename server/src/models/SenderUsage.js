import mongoose from 'mongoose';

/**
 * SenderUsage: how many campaign messages one sender account has been used for on one UTC day.
 * One document per (sender account, day), incremented atomically before each send attempt so the
 * daily cap holds across worker processes. Documents expire by themselves a few days later.
 */
const senderUsageSchema = new mongoose.Schema(
  {
    senderAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SenderAccount', required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    count: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

senderUsageSchema.index({ senderAccountId: 1, day: 1 }, { unique: true });
senderUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SenderUsage = mongoose.models.SenderUsage || mongoose.model('SenderUsage', senderUsageSchema);
export default SenderUsage;
