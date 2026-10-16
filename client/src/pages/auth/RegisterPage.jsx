import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';
import { validateRegisterForm } from '../../utils/validation.js';

export const RegisterPage = () => {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));

    // Clear inline error on change
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: null }));
    }
    if (serverError) {
      setServerError(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Prevent duplicate submissions
    if (isSubmitting) return;

    // Validate form inputs
    const { isValid, errors: validationErrors } = validateRegisterForm(formData);
    if (!isValid) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    setServerError(null);
    setIsSubmitting(true);

    try {
      await register({
        name: formData.name,
        email: formData.email,
        password: formData.password,
      });

      // Navigate to authenticated dashboard on success
      navigate('/dashboard', { replace: true });
    } catch (err) {
      // Never log raw passwords
      setServerError(err.message || 'Registration failed. Please check your information and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8 selection:bg-indigo-500 selection:text-white">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center mb-6">
        <Link to="/" className="inline-flex items-center gap-2 group">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 group-hover:scale-105 transition-transform duration-200">
            <svg
              className="w-5 h-5 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <span className="text-2xl font-bold tracking-tight text-white">MailPulse</span>
        </Link>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
          Create your account
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Get started with high-deliverability email campaign management
        </p>
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl py-8 px-6 sm:px-10 shadow-2xl backdrop-blur-sm">
          {serverError && (
            <div
              className="mb-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm flex items-start gap-3"
              role="alert"
            >
              <svg
                className="w-5 h-5 text-rose-400 shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <span>{serverError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            {/* Name */}
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-slate-300">
                Full Name
              </label>
              <div className="mt-1">
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  required
                  disabled={isSubmitting}
                  value={formData.name}
                  onChange={handleChange}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'name-error' : undefined}
                  className={`block w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-800/80 text-white placeholder-slate-500 border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    errors.name
                      ? 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/30'
                      : 'border-slate-700 hover:border-slate-600 focus:border-indigo-500'
                  }`}
                  placeholder="e.g. Jane Developer"
                />
                {errors.name && (
                  <p id="name-error" className="mt-1.5 text-xs text-rose-400">
                    {errors.name}
                  </p>
                )}
              </div>
            </div>

            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-300">
                Email address
              </label>
              <div className="mt-1">
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  disabled={isSubmitting}
                  value={formData.email}
                  onChange={handleChange}
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? 'email-error' : undefined}
                  className={`block w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-800/80 text-white placeholder-slate-500 border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    errors.email
                      ? 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/30'
                      : 'border-slate-700 hover:border-slate-600 focus:border-indigo-500'
                  }`}
                  placeholder="jane@example.com"
                />
                {errors.email && (
                  <p id="email-error" className="mt-1.5 text-xs text-rose-400">
                    {errors.email}
                  </p>
                )}
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-300">
                Password
              </label>
              <div className="mt-1">
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  disabled={isSubmitting}
                  value={formData.password}
                  onChange={handleChange}
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? 'password-error' : undefined}
                  className={`block w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-800/80 text-white placeholder-slate-500 border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    errors.password
                      ? 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/30'
                      : 'border-slate-700 hover:border-slate-600 focus:border-indigo-500'
                  }`}
                  placeholder="Minimum 8 characters"
                />
                {errors.password && (
                  <p id="password-error" className="mt-1.5 text-xs text-rose-400">
                    {errors.password}
                  </p>
                )}
              </div>
            </div>

            {/* Confirm Password */}
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-300">
                Confirm Password
              </label>
              <div className="mt-1">
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  disabled={isSubmitting}
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  aria-invalid={Boolean(errors.confirmPassword)}
                  aria-describedby={errors.confirmPassword ? 'confirm-password-error' : undefined}
                  className={`block w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-800/80 text-white placeholder-slate-500 border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    errors.confirmPassword
                      ? 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/30'
                      : 'border-slate-700 hover:border-slate-600 focus:border-indigo-500'
                  }`}
                  placeholder="Repeat your password"
                />
                {errors.confirmPassword && (
                  <p id="confirm-password-error" className="mt-1.5 text-xs text-rose-400">
                    {errors.confirmPassword}
                  </p>
                )}
              </div>
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900 focus:ring-indigo-500 transition-colors shadow-lg shadow-indigo-600/25 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Creating account...</span>
                  </>
                ) : (
                  <span>Create account</span>
                )}
              </button>
            </div>
          </form>

          <div className="mt-6 pt-6 border-t border-slate-800 text-center">
            <p className="text-sm text-slate-400">
              Already have an account?{' '}
              <Link
                to="/login"
                className="font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RegisterPage;
