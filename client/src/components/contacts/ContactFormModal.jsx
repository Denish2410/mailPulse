import { useState, useEffect } from 'react';
import { validateContactForm } from '../../utils/validation.js';
import { getErrorMessage } from '../../lib/api.js';

/**
 * ContactFormModal Component
 *
 * Accessible modal dialog supporting both Contact Creation and Contact Editing.
 * Handles client validation, 409 conflict email display, and submission states.
 */
export const ContactFormModal = ({
  isOpen = false,
  contact = null, // null for create, object for edit
  onClose,
  onSubmit, // async ({ name, email }) => void
}) => {
  const isEditing = Boolean(contact?.id);

  const [formData, setFormData] = useState({
    name: contact?.name || '',
    email: contact?.email || '',
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen) return null;

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
    if (isSubmitting) return;

    // 1. Client-Side Validation
    const validation = validateContactForm(formData);
    if (!validation.isValid) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setServerError(null);
    setIsSubmitting(true);

    try {
      await onSubmit({
        name: formData.name.trim(),
        email: formData.email.trim(),
      });
      onClose();
    } catch (err) {
      const status = err?.response?.status;
      const message = getErrorMessage(err, 'Failed to save contact. Please try again.');

      if (status === 409) {
        // Position conflict error directly under the email field
        setErrors((prev) => ({
          ...prev,
          email: message || 'A contact with this email already exists.',
        }));
      } else {
        setServerError(message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="contact-modal-title"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity"
        onClick={() => {
          if (!isSubmitting) onClose();
        }}
        aria-hidden="true"
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8 z-10 text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-md shadow-indigo-500/20">
              <svg
                className="w-5 h-5 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                {isEditing ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
                  />
                )}
              </svg>
            </div>
            <div>
              <h2 id="contact-modal-title" className="text-lg font-bold text-white tracking-tight">
                {isEditing ? 'Edit Contact' : 'Add New Contact'}
              </h2>
              <p className="text-xs text-slate-400">
                {isEditing ? 'Update contact details in your workspace' : 'Enter contact information to add to your list'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Server-level error */}
        {serverError && (
          <div
            className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2"
            role="alert"
          >
            <svg className="w-4 h-4 shrink-0 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <span>{serverError}</span>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {/* Name Field */}
          <div>
            <label htmlFor="contact-name" className="block text-xs font-medium text-slate-300 mb-1.5">
              Full Name <span className="text-rose-400">*</span>
            </label>
            <input
              id="contact-name"
              name="name"
              type="text"
              required
              autoFocus
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
              placeholder="e.g. Sarah Connor"
              className={`w-full px-3.5 py-2.5 bg-slate-950/80 border rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 transition-colors disabled:opacity-60 ${
                errors.name
                  ? 'border-rose-500/60 focus:ring-rose-500/40'
                  : 'border-slate-800 focus:border-indigo-500 focus:ring-indigo-500/40'
              }`}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-rose-400 font-medium">{errors.name}</p>
            )}
          </div>

          {/* Email Field */}
          <div>
            <label htmlFor="contact-email" className="block text-xs font-medium text-slate-300 mb-1.5">
              Email Address <span className="text-rose-400">*</span>
            </label>
            <input
              id="contact-email"
              name="email"
              type="email"
              required
              value={formData.email}
              onChange={handleChange}
              disabled={isSubmitting}
              placeholder="e.g. sarah@example.com"
              className={`w-full px-3.5 py-2.5 bg-slate-950/80 border rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 transition-colors disabled:opacity-60 ${
                errors.email
                  ? 'border-rose-500/60 focus:ring-rose-500/40'
                  : 'border-slate-800 focus:border-indigo-500 focus:ring-indigo-500/40'
              }`}
            />
            {errors.email && (
              <p className="mt-1 text-xs text-rose-400 font-medium">{errors.email}</p>
            )}
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800 mt-6">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting && (
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              <span>{isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Contact'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ContactFormModal;
