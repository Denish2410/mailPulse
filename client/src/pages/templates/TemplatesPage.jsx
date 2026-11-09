import { useState, useEffect, useCallback } from 'react';
import Navbar from '../../components/layout/Navbar.jsx';
import TemplateFormDialog from '../../components/templates/TemplateFormDialog.jsx';
import {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getErrorMessage,
} from '../../api/templates.js';
import { formatCampaignDate } from '../../utils/campaignHelpers.js';
import { getTemplateErrorMessage } from '../../utils/templateHelpers.js';

/**
 * TemplatesPage: reusable email template library (Phase 10).
 */
export const TemplatesPage = () => {
  const [templates, setTemplates] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [notification, setNotification] = useState(null);
  const [dialog, setDialog] = useState(null); // { template } | null
  const [pendingDelete, setPendingDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    (async () => {
      setIsLoading(true);
      try {
        const data = await getTemplates({ limit: 100, search: debouncedSearch }, { signal: controller.signal });
        if (!active) return;
        setTemplates(data?.templates ?? []);
        setLoadError(null);
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setLoadError(getErrorMessage(err));
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [debouncedSearch, refresh]);

  const notify = useCallback((type, message) => setNotification({ type, message }), []);

  const handleSubmit = async (payload) => {
    if (dialog?.template) {
      await updateTemplate(dialog.template.id, payload);
      notify('success', 'Template updated.');
    } else {
      await createTemplate(payload);
      notify('success', 'Template created.');
    }
    setDialog(null);
    setRefresh((n) => n + 1);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteTemplate(pendingDelete.id);
      notify('success', 'Template deleted.');
      setRefresh((n) => n + 1);
    } catch (err) {
      notify('error', getTemplateErrorMessage(err));
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <div className="inline-flex px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-semibold tracking-wide uppercase mb-2 border border-indigo-500/20">
              Templates
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-50 tracking-tight">Templates</h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Save reusable designs and personalize them with merge tags.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDialog({ template: null })}
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/30 cursor-pointer"
          >
            New Template
          </button>
        </div>

        {notification && (
          <div
            role={notification.type === 'error' ? 'alert' : 'status'}
            className={`mb-6 p-4 rounded-xl text-sm flex items-center justify-between ${
              notification.type === 'error'
                ? 'bg-rose-500/10 border border-rose-500/20 text-rose-300'
                : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
            }`}
          >
            <span>{notification.message}</span>
            <button type="button" onClick={() => setNotification(null)} aria-label="Dismiss" className="ml-3 cursor-pointer">
              &times;
            </button>
          </div>
        )}

        <label htmlFor="template-search" className="sr-only">
          Search templates
        </label>
        <input
          id="template-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates by name..."
          className="mb-6 w-full sm:max-w-sm px-3.5 py-2.5 bg-slate-900/70 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {isLoading ? (
          <p className="text-sm text-slate-400" role="status">Loading templates…</p>
        ) : loadError ? (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => setRefresh((n) => n + 1)} className="underline cursor-pointer">
              Retry
            </button>
          </div>
        ) : templates.length === 0 ? (
          <div className="p-10 text-center rounded-2xl border border-dashed border-slate-800 text-sm text-slate-400">
            {debouncedSearch ? 'No templates match your search.' : 'No templates yet. Create your first reusable design.'}
          </div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {templates.map((tpl) => (
              <li key={tpl.id} className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col gap-3">
                <div>
                  <h2 className="font-semibold text-slate-50 truncate">{tpl.name}</h2>
                  <p className="text-xs text-slate-400 truncate mt-0.5">{tpl.subject || 'No subject'}</p>
                </div>
                <div className="flex flex-wrap gap-1.5 min-h-6">
                  {tpl.mergeTags?.length ? (
                    tpl.mergeTags.map((tag) => (
                      <span key={tag} className="px-2 py-0.5 rounded-md text-[11px] font-mono text-indigo-300 bg-indigo-500/10 border border-indigo-500/20">
                        {`{{${tag}}}`}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-slate-500">No merge tags</span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-auto pt-2 border-t border-slate-800">
                  <span className="text-[11px] text-slate-500">Updated {formatCampaignDate(tpl.updatedAt)}</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setDialog({ template: tpl })}
                      aria-label={`Edit template ${tpl.name}`}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(tpl)}
                      aria-label={`Delete template ${tpl.name}`}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      {dialog && (
        <TemplateFormDialog
          key={dialog.template?.id ?? 'new'}
          template={dialog.template}
          onClose={() => setDialog(null)}
          onSubmit={handleSubmit}
        />
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-label="Confirm template deletion">
          <div className="fixed inset-0 bg-slate-950/80" aria-hidden="true" />
          <div className="relative z-10 w-full max-w-sm p-6 rounded-2xl bg-slate-900 border border-slate-800">
            <p className="text-sm text-slate-200">
              Delete template <strong>{pendingDelete.name}</strong>? Campaigns already created from it are not affected.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setPendingDelete(null)} disabled={isDeleting} className="px-3 py-1.5 rounded-lg text-sm text-slate-200 bg-slate-800 cursor-pointer">
                Cancel
              </button>
              <button type="button" onClick={handleConfirmDelete} disabled={isDeleting} className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 cursor-pointer disabled:opacity-50">
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TemplatesPage;
