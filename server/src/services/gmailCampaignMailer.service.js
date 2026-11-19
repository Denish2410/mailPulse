import { createEmailService } from './email.service.js';
import { createGmailTransport } from './gmailTransport.service.js';
import { getSenderAccessToken } from './senderToken.service.js';

/**
 * The email service used for CAMPAIGN mail (campaign sends and campaign test emails): the Gmail
 * API, as one specific customer-owned sender account, and nothing else.
 *
 * - It is built for exactly one (owner, sender account) pair and never looks at any other
 *   account. The platform SMTP service (getDefaultEmailService) is reserved for transactional
 *   mail (password reset, email verification) and is never reached from here, not as a default
 *   and not as a fallback.
 * - It has the same `sendEmail` / `assertConfigured` shape as the SMTP service, so the dispatcher
 *   and the controllers treat both the same way. Failures keep the send outcome the Gmail
 *   transport classified ('rejected' = provably not sent, 'uncertain' = possibly sent).
 * - `kind: 'gmail'` tells the dispatcher to leave out ESP-specific headers (Gmail has no
 *   webhooks and does not use SendGrid/Mailgun/SES tags).
 *
 * @param {object} params
 * @param {string} params.userId owner of the sender account
 * @param {{ id: any, email: string, displayName?: string }} params.account
 * @param {Function} [params.fetchImpl] Gmail API fetch (tests inject a simulated Gmail)
 * @param {Function} [params.oauthFetchImpl] token refresh fetch (tests inject a simulated Google)
 * @param {object} [params.env]
 */
export const createGmailCampaignEmailService = ({ userId, account, fetchImpl, oauthFetchImpl, env = process.env }) => {
  const senderAccountId = String(account.id ?? account._id);
  const readAccessToken = async () =>
    (await getSenderAccessToken({ userId, senderAccountId, env, fetchImpl: oauthFetchImpl })).accessToken;
  const transport = createGmailTransport({
    account: { id: senderAccountId, email: account.email, displayName: account.displayName ?? '' },
    getAccessToken: readAccessToken,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const service = createEmailService({
    transport,
    from: account.displayName ? { name: account.displayName, address: account.email } : account.email,
    env,
  });
  return Object.assign(service, {
    kind: 'gmail',
    senderAccountId,
    /**
     * Obtains (and caches) a valid access token WITHOUT sending anything. The dispatcher calls it
     * before it claims a delivery, so a token refresh that fails can only ever happen while no
     * message exists, never after a possible submission.
     */
    async ensureReady() {
      await readAccessToken();
    },
  });
};

export default { createGmailCampaignEmailService };
