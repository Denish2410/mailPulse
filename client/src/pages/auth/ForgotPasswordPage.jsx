import AuthLayout from '../../components/layout/AuthLayout.jsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../../api/auth.js';
import { validateForgotPasswordForm } from '../../utils/validation.js';

/**
 * ForgotPasswordPage: asks for an email and requests a reset link.
 * Shows the same confirmation whether or not the account exists.
 */
export const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSent, setIsSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    const validation = validateForgotPasswordForm({ email });
    if (!validation.isValid) {
      setError(validation.errors.email);
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await requestPasswordReset({ email });
      setIsSent(true);
    } catch (err) {
      setError(
        err?.response?.status === 429
          ? 'Too many attempts. Please try again later.'
          : 'Something went wrong. Please try again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-50">Reset your password</h1>
        <p className="mt-2 text-sm text-slate-400">
          Enter your account email and we will send you a reset link.
        </p>
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl">
          {isSent ? (
            <div role="status" className="space-y-4 text-sm">
              <p className="text-emerald-300">
                If an account exists for that email, a password reset link is on its way. The link expires in 1 hour.
              </p>
              <Link to="/login" className="inline-block text-indigo-300 hover:text-indigo-200 underline">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-5">
              <div>
                <label htmlFor="forgot-email" className="block text-sm font-medium text-slate-300">
                  Email address
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                  disabled={isSubmitting}
                  aria-invalid={Boolean(error)}
                  placeholder="name@company.com"
                  className="mt-1 block w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-800/80 text-slate-50 placeholder-slate-500 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                {error && (
                  <p className="mt-1.5 text-xs text-rose-400" role="alert">{error}</p>
                )}
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 px-4 rounded-xl font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? 'Sending…' : 'Send reset link'}
              </button>
              <p className="text-center text-sm text-slate-400">
                <Link to="/login" className="text-indigo-300 hover:text-indigo-200">Back to sign in</Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </AuthLayout>
  );
};

export default ForgotPasswordPage;
