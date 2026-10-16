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
