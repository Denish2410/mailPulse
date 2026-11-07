import mongoose from 'mongoose';
import crypto from 'node:crypto';

/**
 * SignupForm Mongoose Schema
 *
 * A public subscribe form owned by one user. People who submit it and confirm their email
 * (double opt-in) become contacts of the owner, tagged with `tags`. The public URL uses the
 * unguessable `slug`; the owner's identity is never exposed publicly.
 */
export const MAX_SIGNUP_FORMS_PER_USER = 10;

export const generateSlug = () => crypto.randomBytes(12).toString('hex');

const signupFormSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Form name is required'],
      trim: true,
      minlength: [2, 'Form name must be at least 2 characters long'],
      maxlength: [120, 'Form name cannot exceed 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [300, 'Description cannot exceed 300 characters'],
    },
    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (tags) => tags.length <= 20,
        message: 'A form cannot apply more than 20 tags',
      },
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      default: generateSlug,
      immutable: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

signupFormSchema.index({ userId: 1, createdAt: -1 });

const SignupForm = mongoose.models.SignupForm || mongoose.model('SignupForm', signupFormSchema);

export default SignupForm;
