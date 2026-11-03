import mongoose from 'mongoose';

/**
 * Template Mongoose Schema (Phase 10)
 *
 * A reusable email design owned by one user. Templates hold a subject plus HTML/text bodies that
 * may contain merge tags (see personalization.service.js). Applying a template copies its content
 * into a campaign draft; there is no live link, so editing a template never alters existing
 * campaigns.
 *
 * Tenant isolation: always query by `{ _id, userId }`. Template names are unique per user.
 */
export const MAX_TEMPLATES_PER_USER = 200;

const templateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Template name is required'],
      trim: true,
      minlength: [2, 'Template name must be at least 2 characters long'],
      maxlength: [120, 'Template name cannot exceed 120 characters'],
    },
    subject: {
      type: String,
      trim: true,
      default: '',
      maxlength: [200, 'Template subject cannot exceed 200 characters'],
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
  },
  { timestamps: true }
);

templateSchema.index({ userId: 1, name: 1 }, { unique: true });
templateSchema.index({ userId: 1, updatedAt: -1 });

const Template = mongoose.models.Template || mongoose.model('Template', templateSchema);

export default Template;
