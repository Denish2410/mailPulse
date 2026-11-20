import mongoose from 'mongoose';

/**
 * SenderSendWindow: the send attempts of ONE sender account during the last 24 hours (a rolling
 * window), kept in a single document so that "prune old entries, check the cap, record this one"
 * is one atomic update across all worker processes. Each entry has the MongoDB server time of the
 * reservation and a random token, so a reservation that turned out unused can be given back
 * exactly. Entries older than 24 hours are dropped on every reservation; the array is bounded by
 * the daily cap (at most 400).
 */
const sendWindowSchema = new mongoose.Schema(
  {
    senderAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SenderAccount', required: true },
    sends: {
      type: [{ _id: false, at: { type: Date, required: true }, k: { type: String, required: true } }],
      default: [],
    },
    // The token of the newest successful reservation: how a caller learns that ITS update won
    lastToken: { type: String, default: null },
  },
  { timestamps: true }
);

sendWindowSchema.index({ senderAccountId: 1 }, { unique: true });

const SenderSendWindow = mongoose.models.SenderSendWindow || mongoose.model('SenderSendWindow', sendWindowSchema);
export default SenderSendWindow;
