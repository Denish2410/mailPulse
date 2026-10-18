import mongoose from 'mongoose';

/**
 * Contact Mongoose Schema
 *
 * Defines the contact data model for MailPulse.
 * Represents an email contact belonging to an authenticated user.
 *
 * Ownership & Multi-Tenancy Design:
 * - Every contact must belong to an owning user (`userId` ref: 'User').
 * - Contacts are strictly isolated per user account.
 * - Email addresses are unique per user (`{ userId: 1, email: 1 }`),
 *   allowing different MailPulse users to manage the same contact independently
 *   while preventing duplicate entries within a single user's list.
 */
const contactSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
    },
    name: {
      type: String,
      required: [true, 'Contact name is required'],
      trim: true,
      minlength: [2, 'Contact name must be at least 2 characters long'],
      maxlength: [100, 'Contact name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Contact email is required'],
      trim: true,
      lowercase: true,
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please provide a valid email address',
      ],
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Compound unique index: Enforces that an email is unique per owner.
 * Also serves as an efficient index for queries filtering by `userId`.
 */
contactSchema.index({ userId: 1, email: 1 }, { unique: true });

/**
 * Compound query & sort index: Optimizes sorted list retrieval scoped to an owner.
 */
contactSchema.index({ userId: 1, createdAt: -1 });

// Prevent model overwrite in development watch and test runners
const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);

export { contactSchema };
export default Contact;
