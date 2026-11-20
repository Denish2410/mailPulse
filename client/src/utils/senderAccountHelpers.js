/**
 * Helpers for connecting and managing Gmail sender accounts. Pure functions: no tokens are
 * ever stored, logged or returned from here.
 */

export const SENDER_ACCOUNTS_PATH = '/settings/sender-accounts';
export const OAUTH_CALLBACK_PATH = '/settings/sender-accounts/callback';

/** Same bounds and character set the API accepts for the values Google sends back. */
const OAUTH_VALUE = /^[\x21-\x7e]+$/;
const MAX_STATE_LENGTH = 512;
const MAX_CODE_LENGTH = 2048;

/**
 * Reads what Google appended to the redirect URL.
 *
 * @param {string} search - location.search
 * @returns {{ kind: 'empty' } | { kind: 'denied' } | { kind: 'google_error' } | { kind: 'invalid' } | { kind: 'ready', code: string, state: string }}
 */
export const parseOAuthCallback = (search) => {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const error = params.get('error');
  const code = params.get('code');
  const state = params.get('state');

  if (error) return error === 'access_denied' ? { kind: 'denied' } : { kind: 'google_error' };
  if (!code && !state) return { kind: 'empty' };
  if (
    !code ||
    !state ||
    code.length > MAX_CODE_LENGTH ||
    state.length > MAX_STATE_LENGTH ||
    !OAUTH_VALUE.test(code) ||
    !OAUTH_VALUE.test(state)
  ) {
    return { kind: 'invalid' };
  }
  return { kind: 'ready', code, state };
};

/**
 * The browser is only ever sent to Google's own consent screen over https; anything else the
 * server might return (a bug, a tampered response) is refused.
 */
export const isGoogleAuthorizationUrl = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const getConnectErrorMessage = (error) => {
  const status = error?.response?.status;
  if (status === 503) return 'Connecting Gmail accounts is not set up on this server yet. Please contact your administrator.';
  if (status === 429) return 'Too many connection attempts. Please wait a few minutes and try again.';
  const message = error?.response?.data?.message;
  if (typeof message === 'string' && message) return message;
  if (error?.code === 'ECONNABORTED' || error?.code === 'ERR_NETWORK') return 'Unable to reach the server. Please try again.';
  return 'Could not start the Gmail connection. Please try again.';
};

export const getCallbackErrorMessage = (error) => {
  const status = error?.response?.status;
  if (status === 503) return 'Connecting Gmail accounts is not set up on this server yet. Please contact your administrator.';
  const message = error?.response?.data?.message;
  if (typeof message === 'string' && message) return message;
  if (error?.code === 'ECONNABORTED' || error?.code === 'ERR_NETWORK') return 'Unable to reach the server. Please try connecting again.';
  return 'Could not connect your Gmail account. Please try again.';
};

export const CALLBACK_MESSAGES = Object.freeze({
  denied: 'Access was not granted, so no account was connected. Connect again and allow MailPulse to send email on your behalf.',
  google_error: 'Google could not complete the authorization. Please try connecting again.',
  invalid: 'This connection link is invalid. Please start connecting your Gmail account again.',
  empty: 'There is no connection in progress. Start from the Gmail accounts page.',
});

/**
 * Badge, explanation and available actions for an account, from the safe API fields only.
 *
 * @param {{ status?: string, statusReason?: string|null, canSend?: boolean }} account
 * @returns {{ label: string, tone: 'ok'|'warn'|'muted', explanation: string, needsReconnect: boolean, canDisconnect: boolean }}
 */
export const getSenderStatusInfo = (account) => {
  switch (account?.status) {
    case 'active':
      return {
        label: 'Connected',
        tone: 'ok',
        explanation: 'Ready to send campaigns.',
        needsReconnect: false,
        canDisconnect: true,
      };
    case 'reauth_required': {
      const revoked = account.statusReason === 'TOKEN_REVOKED';
      return {
        label: 'Reconnect required',
        tone: 'warn',
        explanation: revoked
          ? 'Google access was removed or expired. Campaigns from this account are paused until you reconnect it with the same Google account.'
          : 'Google needs you to sign in again. Reconnect with the same Google account; campaigns from this account stay paused until you do and then resume them yourself.',
        needsReconnect: true,
        canDisconnect: true,
      };
    }
    case 'disconnected':
      return {
        label: 'Disconnected',
        tone: 'muted',
        explanation: 'MailPulse no longer has access to this account. Connect it again to use it as a sender.',
        needsReconnect: true,
        canDisconnect: false,
      };
    default:
      return { label: 'Unknown', tone: 'muted', explanation: 'The status of this account is unknown.', needsReconnect: false, canDisconnect: false };
  }
};

export const STATUS_TONE_CLASSES = Object.freeze({
  ok: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  warn: 'bg-amber-100 text-amber-700 border-amber-300',
  muted: 'bg-slate-800 text-slate-300 border-slate-700',
});

export const DISCONNECT_WARNING =
  'MailPulse will delete its access to this Gmail account. Campaigns that send from it will pause, and you will need to reconnect the same account before resuming them. Emails already sent are not affected.';

export const getDisconnectSuccessMessage = (email, revoked) =>
  `${email || 'The account'} was disconnected.${revoked ? '' : ' Google access may still be listed in your Google account permissions.'}`;

export const getDisconnectErrorMessage = (error) => {
  if (error?.response?.status === 404) return 'This account no longer exists. The list has been refreshed.';
  const message = error?.response?.data?.message;
  if (typeof message === 'string' && message) return message;
  return 'Could not disconnect this account. Please try again.';
};

/** Accounts a campaign could be sent from right now. */
export const countUsableSenders = (accounts) => (Array.isArray(accounts) ? accounts.filter((a) => a?.canSend).length : 0);
