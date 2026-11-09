import mongoose from 'mongoose';

/**
 * User Mongoose Schema
 *
 * Defines the initial user data model for MailPulse.
 * Handles user identification, credentials storage (password hash only),
 * and account status tracking.
 */
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters long'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      unique: true,
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please provide a valid email address',
      ],
    },
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      select: false,
    },
    // Postal address of the sender, printed in every campaign footer (CAN-SPAM requires one)
    mailingAddress: {
      type: String,
      trim: true,
      default: '',
      maxlength: [300, 'Mailing address cannot exceed 300 characters'],
    },
    // Bumped to revoke every access token issued before now (password reset, sign out everywhere).
    // Tokens carry the version they were issued under and are refused when it no longer matches.
    tokenVersion: { type: Number, default: 0 },
    // Login throttling (see loginThrottle.service.js)
    loginFailureCount: { type: Number, default: undefined, select: false },
    loginFailureAt: { type: Date, default: undefined, select: false },
    lockedUntil: { type: Date, default: undefined, select: false },
    // Email verification (only the SHA-256 hash of the emailed token is stored)
    emailVerifiedAt: {
      type: Date,
      default: null,
    },
    emailVerificationTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    emailVerificationExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    // Password reset (single-use; only the SHA-256 hash of the emailed token is stored)
    passwordResetTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    status: {
      type: String,
      enum: {
        values: ['active', 'suspended'],
        message: 'Status must be either active or suspended',
      },
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

// Prevent model overwrite in development watch modes
const User = mongoose.models.User || mongoose.model('User', userSchema);

export { userSchema };
export default User;
