import mongoose from 'mongoose';

/**
 * Segment Mongoose Schema (Phase 11)
 *
 * A named, saved set of contact-selection criteria owned by one user. Segments store rules, not
 * contacts: membership is evaluated when the segment is previewed or applied to a campaign.
 * Always query by `{ _id, userId }`. Names are unique per user.
 */
export const MAX_SEGMENTS_PER_USER = 100;

const segmentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
    },
    name: {
      type: String,
      required: [true, 'Segment name is required'],
      trim: true,
      minlength: [2, 'Segment name must be at least 2 characters long'],
      maxlength: [120, 'Segment name cannot exceed 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    criteria: {
      tagsAny: { type: [String], default: [] },
      tagsAll: { type: [String], default: [] },
      tagsNone: { type: [String], default: [] },
      engagement: {
        type: {
          type: String,
          enum: ['opened', 'clicked', 'not_opened'],
        },
        days: { type: Number, min: 1, max: 365 },
      },
      createdWithinDays: { type: Number, min: 1, max: 365, default: null },
    },
  },
  { timestamps: true }
);

segmentSchema.index({ userId: 1, name: 1 }, { unique: true });
segmentSchema.index({ userId: 1, updatedAt: -1 });

const Segment = mongoose.models.Segment || mongoose.model('Segment', segmentSchema);

export default Segment;
