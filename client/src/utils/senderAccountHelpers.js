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
