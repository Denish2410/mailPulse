import { useState, useEffect } from 'react';
import { getErrorMessage } from '../../lib/api.js';

/**
 * DeleteContactDialog Component
 *
 * Accessible confirmation modal before deleting an authenticated contact.
 * Clearly displays contact name and email, prevents duplicate clicks,
 * and handles deletion errors gracefully.
 */
export const DeleteContactDialog = ({
  isOpen = false,
  contact = null,
  onClose,
  onConfirm, // async (contactId) => void
}) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isDeleting) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isDeleting, onClose]);

  if (!isOpen || !contact) return null;

  const handleConfirm = async () => {
    if (isDeleting) return;

    setIsDeleting(true);
    setError(null);

    try {
      await onConfirm(contact.id);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete contact. Please try again.'));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      aria-describedby="delete-dialog-desc"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity"
        onClick={() => {
          if (!isDeleting) onClose();
        }}
        aria-hidden="true"
      />

      {/* Dialog Card */}
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8 z-10 text-slate-100">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center shrink-0">
            <svg
              className="w-6 h-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </div>

          <div className="flex-1">
            <h2 id="delete-dialog-title" className="text-lg font-bold text-white tracking-tight">
              Delete Contact
            </h2>
            <p id="delete-dialog-desc" className="text-xs text-slate-400 mt-1">
              Are you sure you want to permanently delete this contact? This action cannot be undone.
            </p>
          </div>
        </div>

        {/* Contact details card */}
        <div className="mt-5 p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 text-xs text-slate-300">
          <div className="font-semibold text-slate-100 text-sm">{contact.name}</div>
          <div className="font-mono text-slate-400 text-xs mt-0.5">{contact.email}</div>
        </div>

        {/* Error message */}
        {error && (
          <div
            className="mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2"
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
            <span>{error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-6 border-t border-slate-800 mt-6">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isDeleting}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 shadow-md shadow-rose-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:opacity-50 cursor-pointer"
          >
            {isDeleting && (
              <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            <span>{isDeleting ? 'Deleting...' : 'Delete Contact'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteContactDialog;
