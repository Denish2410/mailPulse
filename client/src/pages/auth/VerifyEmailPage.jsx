import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { verifyEmail } from '../../api/auth.js';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * VerifyEmailPage: consumes the emailed verification token (?token=...) on load.
 */
export const VerifyEmailPage = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const hasValidToken = TOKEN_PATTERN.test(token);
  const [status, setStatus] = useState(hasValidToken ? 'verifying' : 'invalid');

  useEffect(() => {
    if (!hasValidToken) return undefined;
    let active = true;
    verifyEmail({ token })
      .then(() => active && setStatus('success'))
      .catch(() => active && setStatus('invalid'));
    return () => {
      active = false;
    };
  }, [token, hasValidToken]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl text-center space-y-4">
          <h1 className="text-xl font-bold text-white">Email verification</h1>
          {status === 'verifying' && <p className="text-sm text-slate-300" role="status">Verifying your email…</p>}
          {status === 'success' && (
            <p className="text-sm text-emerald-300" role="status">Your email address is verified. Thank you!</p>
          )}
          {status === 'invalid' && (
            <p className="text-sm text-rose-300" role="alert">
              This verification link is invalid or has expired. Sign in and choose “Resend email” to get a new one.
            </p>
          )}
          {status !== 'verifying' && (
            <Link to="/dashboard" className="inline-block text-sm text-indigo-300 hover:text-indigo-200 underline">
              Go to MailPulse
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

export default VerifyEmailPage;
