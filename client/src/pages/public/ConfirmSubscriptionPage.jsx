import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { confirmSubscription } from '../../api/signupForms.js';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * ConfirmSubscriptionPage: public page that consumes the emailed double opt-in token.
 */
export const ConfirmSubscriptionPage = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const hasValidToken = TOKEN_PATTERN.test(token);
  const [status, setStatus] = useState(hasValidToken ? 'confirming' : 'invalid');
  const [formName, setFormName] = useState('');

  useEffect(() => {
    if (!hasValidToken) return undefined;
    let active = true;
    confirmSubscription(token)
      .then((data) => {
        if (!active) return;
        setFormName(data?.formName ?? '');
        setStatus('success');
      })
      .catch(() => active && setStatus('invalid'));
    return () => {
      active = false;
    };
  }, [token, hasValidToken]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl text-center space-y-3">
          <h1 className="text-xl font-bold text-white">Confirm subscription</h1>
          {status === 'confirming' && <p className="text-sm text-slate-300" role="status">Confirming…</p>}
          {status === 'success' && (
            <p className="text-sm text-emerald-300" role="status">
              You&apos;re subscribed{formName ? ` to ${formName}` : ''}. Thank you!
            </p>
          )}
          {status === 'invalid' && (
            <p className="text-sm text-rose-300" role="alert">
              This confirmation link is invalid or has expired. Please subscribe again to get a new one.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ConfirmSubscriptionPage;
