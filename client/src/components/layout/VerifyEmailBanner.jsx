import { useState } from 'react';
import { useAuth } from '../../hooks/useAuth.js';
import { resendVerificationEmail } from '../../api/auth.js';

/**
 * Slim banner shown to signed-in users whose email address is not verified yet.
 * Renders nothing for verified users (or when the server does not report the flag).
 */
export const VerifyEmailBanner = () => {
  const { user } = useAuth();
  const [state, setState] = useState({ status: 'idle', message: '' });

  if (!user || user.emailVerified !== false) return null;

  const handleResend = async () => {
    if (state.status === 'sending') return;
    setState({ status: 'sending', message: '' });
    try {
      const data = await resendVerificationEmail();
      setState({
        status: 'done',
        message: data?.emailVerified ? 'Your email is already verified.' : 'Verification email sent. Check your inbox.',
      });
    } catch (err) {
      setState({
        status: 'error',
        message: err?.response?.status === 429 ? 'Too many requests. Try again later.' : 'Could not send the email. Try again.',
      });
    }
  };

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 text-amber-200 text-xs sm:text-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>Please verify your email address. We sent a link to {user.email}.</span>
        <button
          type="button"
          onClick={handleResend}
          disabled={state.status === 'sending'}
          className="font-semibold underline underline-offset-2 hover:text-amber-100 disabled:opacity-50 cursor-pointer"
        >
          {state.status === 'sending' ? 'Sending…' : 'Resend email'}
        </button>
        {state.message && (
          <span role={state.status === 'error' ? 'alert' : 'status'} className={state.status === 'error' ? 'text-rose-300' : 'text-emerald-300'}>
            {state.message}
          </span>
        )}
      </div>
    </div>
  );
};

export default VerifyEmailBanner;
