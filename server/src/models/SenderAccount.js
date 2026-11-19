import mongoose from 'mongoose';

/**
 * SenderAccount: a customer-owned mailbox that campaigns are sent from (Gmail API, Google OAuth).
 *
 * Security and tenancy:
 * - Owned by exactly one MailPulse user (`userId`); every query must be scoped by it.
 * - OAuth tokens are stored ONLY as encrypted envelopes (src/utils/tokenCrypto.js) bound to this
 *   account's _id, never in plaintext. The token fields are `select: false` and are also stripped
 *   from toJSON/toObject, so a token can only be read by a query that explicitly asks for it.
 * - The same Google account may be connected by two different MailPulse users (each holds its own
 *   grant); within one user it is unique, so reconnecting updates the existing record.
 *
 * Status:
 * - active           tokens present; may be used for sending
 * - reauth_required  Google refused the stored grant (revoked, expired, scope removed); the
 *                    customer must reconnect. Never replaced by another account automatically.
 * - disconnected     the customer disconnected it; tokens are wiped. The record is kept so
 *                    campaigns that used it still show their sender.
 *
 * `tokenGeneration` increases whenever the refresh token is replaced or wiped. Writers that
 * started from an older generation (for example a token refresh racing a reconnect or a
 * disconnect) make their update conditional on it, so they can never restore stale tokens.
 */

export const SENDER_PROVIDERS = Object.freeze(['google']);
export const SENDER_ACCOUNT_STATUSES = Object.freeze(['active', 'reauth_required', 'disconnected']);
export const SENDER_TOKEN_FIELDS = Object.freeze(['encryptedRefreshToken', 'encryptedAccessToken', 'accessTokenExpiresAt']);

const stripTokens = (doc, ret) => {
  for (const field of SENDER_TOKEN_FIELDS) delete ret[field];
  return ret;
};

const senderAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner userId is required'],
      index: true,
    },
    provider: {
      type: String,
      enum: { values: SENDER_PROVIDERS, message: 'Unsupported sender provider' },
      required: [true, 'Provider is required'],
    },
    // Stable account ID from the provider (Google: the OpenID `sub` claim). Emails can change.
    providerAccountId: {
      type: String,
      required: [true, 'Provider account ID is required'],
      trim: true,
      maxlength: [255, 'Provider account ID cannot exceed 255 characters'],
    },
    email: {
      type: String,
      required: [true, 'Sender email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Sender email cannot exceed 254 characters'],
      match: [/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Please provide a valid email address'],
    },
    displayName: {
      type: String,
      trim: true,
      default: '',
      maxlength: [200, 'Display name cannot exceed 200 characters'],
    },
    status: {
      type: String,
      enum: { values: SENDER_ACCOUNT_STATUSES, message: 'Invalid sender account status' },
      default: 'active',
    },
    // Machine-readable reason for the current status (for example TOKEN_REVOKED)
    statusReason: {
      type: String,
      default: null,
      maxlength: 64,
      match: [/^[A-Z][A-Z0-9_]*$/, 'Invalid status reason'],
    },
    statusChangedAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },

    // Encrypted envelopes only (mpt1....). Never plaintext, never returned unless selected.
    encryptedRefreshToken: { type: String, default: null, select: false },
    encryptedAccessToken: { type: String, default: null, select: false },
    accessTokenExpiresAt: { type: Date, default: null, select: false },
    tokenGeneration: { type: Number, default: 0, min: 0 },

    connectedAt: { type: Date, default: null },
    lastRefreshedAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: stripTokens },
    toObject: { transform: stripTokens },
  }
);

// One record per (user, provider account): reconnecting updates it instead of duplicating
senderAccountSchema.index({ userId: 1, provider: 1, providerAccountId: 1 }, { unique: true });
senderAccountSchema.index({ userId: 1, createdAt: -1 });

/** Tokens must be encrypted envelopes; plaintext can never be stored, even by mistake. */
senderAccountSchema.path('encryptedRefreshToken').validate(
  (value) => value === null || value === undefined || /^mpt1\./.test(value),
  'Tokens must be stored encrypted'
);
senderAccountSchema.path('encryptedAccessToken').validate(
  (value) => value === null || value === undefined || /^mpt1\./.test(value),
  'Tokens must be stored encrypted'
);

const SenderAccount = mongoose.models.SenderAccount || mongoose.model('SenderAccount', senderAccountSchema);

export { senderAccountSchema };
export default SenderAccount;
