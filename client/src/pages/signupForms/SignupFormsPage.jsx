import { useState, useEffect, useCallback } from 'react';
import Navbar from '../../components/layout/Navbar.jsx';
import {
  getSignupForms,
  createSignupForm,
  updateSignupForm,
  deleteSignupForm,
  getErrorMessage,
} from '../../api/signupForms.js';
import { buildPublicFormUrl, buildEmbedSnippet, validateSignupFormInput } from '../../utils/signupFormHelpers.js';

const inputClass =
  'w-full px-3.5 py-2.5 bg-slate-950/80 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60';

/**
 * SignupFormsPage: public subscribe forms with double opt-in.
 */
export const SignupFormsPage = () => {
  const [forms, setForms] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [notification, setNotification] = useState(null);
  const [draft, setDraft] = useState({ name: '', description: '', tags: '' });
  const [errors, setErrors] = useState({});
  const [isCreating, setIsCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    (async () => {
      setIsLoading(true);
      try {
        const list = await getSignupForms({ signal: controller.signal });
        if (!active) return;
        setForms(list);
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
  }, [refresh]);

  const notify = useCallback((type, message) => setNotification({ type, message }), []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (isCreating) return;
    const { errors: found, tags } = validateSignupFormInput(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setIsCreating(true);
    try {
      await createSignupForm({ name: draft.name.trim(), description: draft.description.trim(), tags });
      setDraft({ name: '', description: '', tags: '' });
      notify('success', 'Signup form created.');
      setRefresh((n) => n + 1);
    } catch (err) {
      notify('error', err?.response?.status === 409 ? err.response.data?.message || 'Form limit reached.' : getErrorMessage(err));
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggle = async (form) => {
    setBusyId(form.id);
    try {
      await updateSignupForm(form.id, { enabled: !form.enabled });
      setRefresh((n) => n + 1);
    } catch (err) {
      notify('error', getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (form) => {
    setBusyId(form.id);
    try {
      await deleteSignupForm(form.id);
      notify('success', 'Signup form deleted.');
      setRefresh((n) => n + 1);
    } catch (err) {
      notify('error', getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('success', `${label} copied.`);
    } catch {
      notify('error', 'Could not copy. Select the text and copy it manually.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Signup forms</h1>
        <p className="mt-1 mb-6 text-sm text-slate-400 max-w-2xl">
          Share a public link where people can subscribe. They must confirm by email (double opt-in) before they
          become contacts, and new contacts get the form&apos;s tags.
        </p>

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
            <button type="button" onClick={() => setNotification(null)} aria-label="Dismiss" className="ml-3 cursor-pointer">&times;</button>
          </div>
        )}

        <form onSubmit={handleCreate} noValidate className="mb-8 p-4 rounded-2xl bg-slate-900/60 border border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="form-name" className="block text-xs font-semibold text-slate-300 mb-1.5">Form name *</label>
            <input id="form-name" type="text" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} disabled={isCreating} placeholder="e.g. Weekly newsletter" className={inputClass} />
            {errors.name && <p className="mt-1 text-xs text-rose-400" role="alert">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor="form-tags" className="block text-xs font-semibold text-slate-300 mb-1.5">Tags for new subscribers</label>
            <input id="form-tags" type="text" value={draft.tags} onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))} disabled={isCreating} placeholder="newsletter, web" className={inputClass} />
            {errors.tags && <p className="mt-1 text-xs text-rose-400" role="alert">{errors.tags}</p>}
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="form-description" className="block text-xs font-semibold text-slate-300 mb-1.5">Description shown on the page</label>
            <input id="form-description" type="text" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} disabled={isCreating} placeholder="Product news, once a week." className={inputClass} />
            {errors.description && <p className="mt-1 text-xs text-rose-400" role="alert">{errors.description}</p>}
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button type="submit" disabled={isCreating} className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 cursor-pointer disabled:opacity-50">
              {isCreating ? 'Creating…' : 'Create form'}
            </button>
          </div>
        </form>

        {isLoading ? (
          <p className="text-sm text-slate-400" role="status">Loading forms…</p>
        ) : loadError ? (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => setRefresh((n) => n + 1)} className="underline cursor-pointer">Retry</button>
          </div>
        ) : forms.length === 0 ? (
          <div className="p-10 text-center rounded-2xl border border-dashed border-slate-800 text-sm text-slate-400">No signup forms yet.</div>
        ) : (
          <ul className="space-y-4">
            {forms.map((form) => {
              const url = buildPublicFormUrl(window.location.origin, form.slug);
              return (
                <li key={form.id} className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="font-semibold text-white">{form.name}</h2>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${form.enabled ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' : 'bg-slate-800/80 text-slate-400 border-slate-700'}`}>
                      {form.enabled ? 'Live' : 'Disabled'}
                    </span>
                    {form.tags.map((tag) => (
                      <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">{tag}</span>
                    ))}
                  </div>
                  {form.description && <p className="text-xs text-slate-400">{form.description}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-300 break-all">{url}</code>
                    <button type="button" onClick={() => handleCopy(url, 'Link')} className="px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 cursor-pointer">Copy link</button>
                    <button type="button" onClick={() => handleCopy(buildEmbedSnippet(url), 'HTML snippet')} className="px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 cursor-pointer">Copy HTML</button>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button type="button" onClick={() => handleToggle(form)} disabled={busyId === form.id} className="px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 cursor-pointer disabled:opacity-50">
                      {form.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button type="button" onClick={() => handleDelete(form)} disabled={busyId === form.id} aria-label={`Delete form ${form.name}`} className="px-2.5 py-1 rounded-lg text-xs font-semibold text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 cursor-pointer disabled:opacity-50">
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
};

export default SignupFormsPage;
