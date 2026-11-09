import AuthLayout from '../../components/layout/AuthLayout.jsx';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { resetPassword } from '../../api/auth.js';
import { validateResetPasswordForm } from '../../utils/validation.js';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * ResetPasswordPage: sets a new password using the token from the emailed link (?token=...).
 */
export const ResetPasswordPage = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const hasValidToken = TOKEN_PATTERN.test(token);

  const [form, setForm] = useState({ password: '', confirmPassword: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: null }));
    setServerError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    const validation = validateResetPasswordForm(form);
    if (!validation.isValid) {
      setErrors(validation.errors);
      return;
    }
    setIsSubmitting(true);
    try {
      await resetPassword({ token, password: form.password });
      setIsDone(true);
    } catch (err) {
      setServerError(
        err?.response?.status === 400
          ? 'This reset link is invalid or has expired. Request a new one.'
          : 'Something went wrong. Please try again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const field = (name, label, autoComplete) => (
    <div>
      <label htmlFor={`reset-${name}`} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      <input
        id={`reset-${name}`}
        name={name}
        type="password"
        autoComplete={autoComplete}
        value={form[name]}
        onChange={handleChange}
        disabled={isSubmitting}
        aria-invalid={Boolean(errors[name])}
        className="mt-1 block w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-800/80 text-slate-50 placeholder-slate-500 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      {errors[name] && <p className="mt-1.5 text-xs text-rose-400" role="alert">{errors[name]}</p>}
    </div>
  );

  return (
    <AuthLayout>
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-50">Choose a new password</h1>
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl">
          {isDone ? (
            <div role="status" className="space-y-4 text-sm">
              <p className="text-emerald-300">Your password has been updated.</p>
              <Link to="/login" className="inline-block text-indigo-300 hover:text-indigo-200 underline">
                Sign in
              </Link>
            </div>
          ) : !hasValidToken ? (
            <div role="alert" className="space-y-4 text-sm">
              <p className="text-rose-300">This reset link is invalid. Request a new one.</p>
              <Link to="/forgot-password" className="inline-block text-indigo-300 hover:text-indigo-200 underline">
                Request a new link
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-5">
              {serverError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs" role="alert">
                  {serverError}{' '}
                  <Link to="/forgot-password" className="underline">Request a new link</Link>
                </div>
              )}
              {field('password', 'New password', 'new-password')}
              {field('confirmPassword', 'Confirm new password', 'new-password')}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 px-4 rounded-xl font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? 'Saving…' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </AuthLayout>
  );
};

export default ResetPasswordPage;
