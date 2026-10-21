import { useState, useEffect, useRef } from 'react';
import { validateCampaignForm } from '../../utils/validation.js';
import { getErrorMessage } from '../../lib/api.js';
import { RecipientSelector } from './RecipientSelector.jsx';

/**
 * CampaignFormDialog Component
 *
 * An accessible modal dialog supporting both Campaign Creation and Campaign Editing.
 * Integrates:
 * - Campaign Name (required, 2-120 chars)
 * - Email Subject (required, 1-200 chars)
 * - Dual-tab Body Editor (Plain text vs. HTML) preserving both values on tab switch
 * - RecipientSelector for selecting and managing contact recipients
 * - Client validation with inline field errors and top-level server error banner
 * - Duplicate submission prevention
 * - Escape key and backdrop dismissal with cleanup
 *
 * @param {object} props
 * @param {boolean} [props.isOpen=false] - Dialog visibility
 * @param {object|null} [props.campaign=null] - Campaign to edit, or null for creation
 * @param {boolean} [props.isLoadingDetails=false] - Indicates campaign details are being fetched
 * @param {function(): void} props.onClose - Dismiss callback
 * @param {function(object): Promise<void>} props.onSubmit - Submission callback receiving safe payload
 */
export const CampaignFormDialog = ({
  isOpen = false,
  campaign = null,
  isLoadingDetails = false,
  onClose,
  onSubmit,
}) => {
  const isEditing = Boolean(campaign?.id);

  // Form input states
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [textContent, setTextContent] = useState('');
  const [htmlContent, setHtmlContent] = useState('');
  const [recipientIds, setRecipientIds] = useState([]);

  // Active body editor tab ('text' | 'html')
  const [activeTab, setActiveTab] = useState('text');

  // Validation and request states
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Synchronize form fields whenever isOpen or campaign changes
  const lastCampaignIdRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      setErrors({});
      setServerError(null);
      setIsSubmitting(false);
      lastCampaignIdRef.current = null;
      return;
    }

    // Initialize or switch campaign
    if (campaign && campaign.id) {
      lastCampaignIdRef.current = campaign.id;
      setName(campaign.name || '');
      setSubject(campaign.subject || '');
      setTextContent(campaign.textContent ?? '');
      setHtmlContent(campaign.htmlContent ?? '');
      setRecipientIds(Array.isArray(campaign.recipientIds) ? [...campaign.recipientIds] : []);
      // If HTML has content but text does not, default to HTML tab
      if (campaign.htmlContent && !campaign.textContent) {
        setActiveTab('html');
      } else {
        setActiveTab('text');
      }
    } else {
      // Create mode defaults
      lastCampaignIdRef.current = null;
      setName('');
      setSubject('');
      setTextContent('');
      setHtmlContent('');
      setRecipientIds([]);
      setActiveTab('text');
    }

    setErrors({});
    setServerError(null);
    setIsSubmitting(false);
  }, [isOpen, campaign]);

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

  // Field change handlers that clear corresponding error
  const handleNameChange = (e) => {
    setName(e.target.value);
    if (errors.name) {
      setErrors((prev) => ({ ...prev, name: null }));
    }
    if (serverError) setServerError(null);
  };

  const handleSubjectChange = (e) => {
    setSubject(e.target.value);
    if (errors.subject) {
      setErrors((prev) => ({ ...prev, subject: null }));
    }
    if (serverError) setServerError(null);
  };

  const handleTextContentChange = (e) => {
    setTextContent(e.target.value);
    if (errors.textContent) {
      setErrors((prev) => ({ ...prev, textContent: null }));
    }
    if (serverError) setServerError(null);
  };

  const handleHtmlContentChange = (e) => {
    setHtmlContent(e.target.value);
    if (errors.htmlContent) {
      setErrors((prev) => ({ ...prev, htmlContent: null }));
    }
    if (serverError) setServerError(null);
  };

  const handleRecipientsChange = (updatedIds) => {
    setRecipientIds(updatedIds);
    if (errors.recipientIds) {
      setErrors((prev) => ({ ...prev, recipientIds: null }));
    }
    if (serverError) setServerError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting || isLoadingDetails) return;

    // Build payload preserving explicit empty strings and arrays
    const payload = {
      name: name.trim(),
      subject: subject.trim(),
      textContent,
      htmlContent,
      recipientIds,
    };

    // Client-side validation
    const validation = validateCampaignForm(payload, { isUpdate: isEditing });
    if (!validation.isValid) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setServerError(null);
    setIsSubmitting(true);

    try {
      await onSubmit(payload);
      onClose();
    } catch (err) {
      const message = getErrorMessage(
        err,
        `Failed to ${isEditing ? 'update' : 'create'} campaign. Please try again.`
      );
      setServerError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-dialog-title"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity"
        onClick={() => !isSubmitting && onClose()}
        aria-hidden="true"
      />

      {/* Modal Dialog Container */}
      <div className="relative w-full max-w-3xl max-h-[90vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden z-10 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90">
          <div>
            <h2 id="campaign-dialog-title" className="text-lg font-bold text-white">
              {isEditing ? 'Edit Campaign Draft' : 'Create New Campaign Draft'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isEditing
                ? 'Update campaign information, message content, and recipients.'
                : 'Define campaign details, compose email content, and choose recipients.'}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
          {/* Top-Level Server Error Banner */}
          {serverError && (
            <div
              className="p-3.5 bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs sm:text-sm rounded-xl flex items-center justify-between"
              role="alert"
            >
              <span>{serverError}</span>
              <button
                type="button"
                onClick={() => setServerError(null)}
                className="text-rose-400 hover:text-rose-200 ml-3 focus:outline-none cursor-pointer"
                aria-label="Dismiss error"
              >
                &times;
              </button>
            </div>
          )}

          {/* Form-level validation error */}
          {errors._form && (
            <div
              className="p-3.5 bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs sm:text-sm rounded-xl"
              role="alert"
            >
              {errors._form}
            </div>
          )}

          {isLoadingDetails ? (
            <div className="py-16 flex flex-col items-center justify-center" role="status" aria-live="polite">
              <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm text-slate-400">Loading campaign details...</p>
            </div>
          ) : (
            <>
              {/* Campaign Name & Subject Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Campaign Name */}
                <div>
                  <label htmlFor="campaign-form-name" className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Campaign Name <span className="text-rose-400">*</span>
                  </label>
                  <input
                    id="campaign-form-name"
                    name="name"
                    type="text"
                    value={name}
                    onChange={handleNameChange}
                    placeholder="e.g. Autumn Product Launch"
                    disabled={isSubmitting}
                    className={`w-full px-3.5 py-2.5 bg-slate-950/80 border rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors disabled:opacity-60 ${
                      errors.name ? 'border-rose-500/80 focus:border-rose-500' : 'border-slate-800'
                    }`}
                  />
                  {errors.name && (
                    <p className="mt-1 text-xs text-rose-400 font-medium" role="alert">
                      {errors.name}
                    </p>
                  )}
                </div>

                {/* Email Subject Line */}
                <div>
                  <label htmlFor="campaign-form-subject" className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Email Subject Line <span className="text-rose-400">*</span>
                  </label>
                  <input
                    id="campaign-form-subject"
                    name="subject"
                    type="text"
                    value={subject}
                    onChange={handleSubjectChange}
                    placeholder="e.g. Exclusive Early Access Inside"
                    disabled={isSubmitting}
                    className={`w-full px-3.5 py-2.5 bg-slate-950/80 border rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors disabled:opacity-60 ${
                      errors.subject ? 'border-rose-500/80 focus:border-rose-500' : 'border-slate-800'
                    }`}
                  />
                  {errors.subject && (
                    <p className="mt-1 text-xs text-rose-400 font-medium" role="alert">
                      {errors.subject}
                    </p>
                  )}
                </div>
              </div>

              {/* Message Content Tabs (Plain Text vs HTML) */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-300">Message Content:</span>
                    <div className="inline-flex rounded-lg bg-slate-950 p-0.5 border border-slate-800" role="tablist">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'text'}
                        aria-controls="panel-text-content"
                        id="tab-text-content"
                        onClick={() => setActiveTab('text')}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                          activeTab === 'text'
                            ? 'bg-indigo-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Plain Text
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'html'}
                        aria-controls="panel-html-content"
                        id="tab-html-content"
                        onClick={() => setActiveTab('html')}
                        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                          activeTab === 'html'
                            ? 'bg-indigo-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        HTML
                      </button>
                    </div>
                  </div>

                  <span className="text-[11px] text-slate-500 hidden sm:inline">
                    {activeTab === 'text'
                      ? `${textContent.length} characters`
                      : `${htmlContent.length} characters`}
                  </span>
                </div>

                {/* Plain Text Editor */}
                <div
                  id="panel-text-content"
                  role="tabpanel"
                  aria-labelledby="tab-text-content"
                  className={activeTab === 'text' ? 'block' : 'hidden'}
                >
                  <label htmlFor="campaign-form-text" className="sr-only">
                    Plain Text Email Body
                  </label>
                  <textarea
                    id="campaign-form-text"
                    name="textContent"
                    rows={6}
                    value={textContent}
                    onChange={handleTextContentChange}
                    placeholder="Compose plain text email message..."
                    disabled={isSubmitting}
                    className={`w-full px-3.5 py-2.5 bg-slate-950/80 border rounded-xl text-sm font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors disabled:opacity-60 resize-y min-h-[140px] ${
                      errors.textContent ? 'border-rose-500/80 focus:border-rose-500' : 'border-slate-800'
                    }`}
                  />
                  {errors.textContent && (
                    <p className="mt-1 text-xs text-rose-400 font-medium" role="alert">
                      {errors.textContent}
                    </p>
                  )}
                </div>

                {/* HTML Editor */}
                <div
                  id="panel-html-content"
                  role="tabpanel"
                  aria-labelledby="tab-html-content"
                  className={activeTab === 'html' ? 'block' : 'hidden'}
                >
                  <label htmlFor="campaign-form-html" className="sr-only">
                    HTML Email Body
                  </label>
                  <textarea
                    id="campaign-form-html"
                    name="htmlContent"
                    rows={6}
                    value={htmlContent}
                    onChange={handleHtmlContentChange}
                    placeholder="<p>Compose rich HTML email message...</p>"
                    disabled={isSubmitting}
                    className={`w-full px-3.5 py-2.5 bg-slate-950/80 border rounded-xl text-sm font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors disabled:opacity-60 resize-y min-h-[140px] ${
                      errors.htmlContent ? 'border-rose-500/80 focus:border-rose-500' : 'border-slate-800'
                    }`}
                  />
                  {errors.htmlContent && (
                    <p className="mt-1 text-xs text-rose-400 font-medium" role="alert">
                      {errors.htmlContent}
                    </p>
                  )}
                </div>
              </div>

              {/* Recipients Section */}
              <div className="flex flex-col gap-1.5 pt-2 border-t border-slate-800">
                <span className="text-xs font-semibold text-slate-300">
                  Select Recipients
                </span>
                <RecipientSelector
                  selectedIds={recipientIds}
                  onChange={handleRecipientsChange}
                  disabled={isSubmitting}
                  idPrefix="campaign-form-recipients"
                />
                {errors.recipientIds && (
                  <p className="mt-1 text-xs text-rose-400 font-medium" role="alert">
                    {errors.recipientIds}
                  </p>
                )}
              </div>
            </>
          )}

          {/* Dialog Action Buttons */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800 mt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs sm:text-sm font-semibold text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isSubmitting || isLoadingDetails}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs sm:text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl shadow-md shadow-indigo-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting && (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              <span>{isEditing ? 'Save Changes' : 'Create Draft'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CampaignFormDialog;
