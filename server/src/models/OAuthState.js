import mongoose from 'mongoose';

/**
 * A pending "connect Gmail" request (OAuth state + PKCE verifier), valid for a few minutes.
 *
 * - Bound to the user who started it: the callback must come from the same authenticated user.
 * - Only the SHA-256 hash of the state is stored; the PKCE verifier is stored encrypted.
 * - Single use: the callback consumes it atomically, so a replayed callback is refused.
 * - MongoDB's TTL monitor deletes expired records (expiry is also checked on use).
 */
const oauthStateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, enum: ['google'], required: true },
    stateHash: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    encryptedCodeVerifier: { type: String, required: true, select: false, match: /^mpt1\./ },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

oauthStateSchema.index({ stateHash: 1 }, { unique: true });
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OAuthState = mongoose.models.OAuthState || mongoose.model('OAuthState', oauthStateSchema);

export { oauthStateSchema };
export default OAuthState;
