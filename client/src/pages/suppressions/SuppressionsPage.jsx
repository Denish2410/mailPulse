import { useState, useEffect, useCallback } from 'react';
import Navbar from '../../components/layout/Navbar.jsx';
import {
  getSuppressions,
  createSuppression,
  deleteSuppression,
  getErrorMessage,
} from '../../api/suppressions.js';
import {
  SOURCE_FILTER_OPTIONS,
  getSuppressionSourceInfo,
  validateSuppressionForm,
  getSuppressionErrorMessage,
} from '../../utils/suppressionHelpers.js';
import { formatCampaignDate } from '../../utils/campaignHelpers.js';

const inputClass =
  'px-3.5 py-2.5 bg-slate-900/80 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60';

/**
 * SuppressionsPage: addresses that will never be emailed (unsubscribes, bounces, complaints).
 */
export const SuppressionsPage = () => {
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 0, total: 0 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [source, setSource] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [notification, setNotification] = useState(null);

  const [form, setForm] = useState({ email: '', reason: '' });
  const [formErrors, setFormErrors] = useState({});
  const [isAdding, setIsAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(null);
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    (async () => {
      setIsLoading(true);
      try {
        const data = await getSuppressions({ page, limit: 20, search: debouncedSearch, source }, { signal: controller.signal });
        if (!active) return;
        setItems(data?.suppressions ?? []);
        setPagination(data?.pagination ?? { page: 1, totalPages: 0, total: 0 });
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
  }, [page, debouncedSearch, source, refresh]);

  const notify = useCallback((type, message) => setNotification({ type, message }), []);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (isAdding) return;
    const found = validateSuppressionForm(form);
    setFormErrors(found);
    if (Object.keys(found).length > 0) return;
    setIsAdding(true);
    try {
      await createSuppression(form);
      setForm({ email: '', reason: '' });
      notify('success', 'Address suppressed. It will not receive future campaigns.');
      setPage(1);
      setRefresh((n) => n + 1);
    } catch (err) {
      notify('error', err?.response?.status === 409 ? 'This address is already suppressed.' : getSuppressionErrorMessage(err));
    } finally {
      setIsAdding(false);
    }
  };

  const handleConfirmRemove = async () => {
    if (!pendingRemove || isRemoving) return;
    setIsRemoving(true);
    try {
      await deleteSuppression(pendingRemove.id);
      notify('success', 'Suppression removed.');
      setRefresh((n) => n + 1);
    } catch (err) {
      notify('error', getSuppressionErrorMessage(err));
    } finally {
      setIsRemoving(false);
      setPendingRemove(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Suppressions</h1>
          <p className="mt-1 text-sm text-slate-400 max-w-2xl">
            Addresses that will never be emailed: unsubscribes, bounces, spam complaints and manual entries.
            Recipient opt-outs and spam complaints are permanent.
          </p>
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
            <button type="button" onClick={() => setNotification(null)} aria-label="Dismiss" className="ml-3 cursor-pointer">&times;</button>
          </div>
        )}

        <form onSubmit={handleAdd} noValidate className="mb-6 p-4 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col sm:flex-row gap-3 sm:items-start">
          <div className="flex-1">
            <label htmlFor="suppression-email" className="sr-only">Email to suppress</label>
            <input id="suppression-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="Email to suppress" disabled={isAdding} className={`${inputClass} w-full`} />
            {formErrors.email && <p className="mt-1 text-xs text-rose-400" role="alert">{formErrors.email}</p>}
          </div>
          <div className="flex-1">
            <label htmlFor="suppression-reason" className="sr-only">Reason</label>
            <input id="suppression-reason" type="text" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Reason (optional)" disabled={isAdding} className={`${inputClass} w-full`} />
            {formErrors.reason && <p className="mt-1 text-xs text-rose-400" role="alert">{formErrors.reason}</p>}
          </div>
          <button type="submit" disabled={isAdding} className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 cursor-pointer disabled:opacity-50">
            {isAdding ? 'Adding…' : 'Suppress address'}
          </button>
        </form>

        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <label htmlFor="suppression-search" className="sr-only">Search suppressions</label>
          <input id="suppression-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by email..." className={`${inputClass} flex-1`} />
          <label htmlFor="suppression-source" className="sr-only">Filter by source</label>
          <select id="suppression-source" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} className={inputClass}>
            {SOURCE_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {isLoading ? (
          <p className="text-sm text-slate-400" role="status">Loading suppressions…</p>
        ) : loadError ? (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => setRefresh((n) => n + 1)} className="underline cursor-pointer">Retry</button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center rounded-2xl border border-dashed border-slate-800 text-sm text-slate-400">
            {debouncedSearch || source ? 'No suppressions match your filters.' : 'No suppressed addresses yet.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/80 rounded-2xl border border-slate-800 bg-slate-900/40">
            {items.map((item) => {
              const info = getSuppressionSourceInfo(item.source);
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
                  <span className="font-mono text-slate-100 break-all">{item.email}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${info.pillClass}`}>{info.label}</span>
                  {item.reason && <span className="text-xs text-slate-500 truncate max-w-xs">{item.reason}</span>}
                  <span className="ml-auto text-xs text-slate-500">{formatCampaignDate(item.createdAt)}</span>
                  {item.removable ? (
                    <button type="button" onClick={() => setPendingRemove(item)} aria-label={`Remove suppression for ${item.email}`} className="px-2.5 py-1 rounded-lg text-xs font-semibold text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 cursor-pointer">
                      Remove
                    </button>
                  ) : (
                    <span className="text-[11px] text-slate-600" title="Opt-outs and complaints are permanent">Permanent</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 text-xs text-slate-400">
            <span>Page {pagination.page} of {pagination.totalPages} · {pagination.total} total</span>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1.5 rounded-lg bg-slate-800 disabled:opacity-40 cursor-pointer">Previous</button>
              <button type="button" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 rounded-lg bg-slate-800 disabled:opacity-40 cursor-pointer">Next</button>
            </div>
          </div>
        )}
      </main>

      {pendingRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-label="Confirm removing suppression">
          <div className="fixed inset-0 bg-slate-950/80" aria-hidden="true" />
          <div className="relative z-10 w-full max-w-sm p-6 rounded-2xl bg-slate-900 border border-slate-800">
            <p className="text-sm text-slate-200">
              Allow emailing <strong className="font-mono break-all">{pendingRemove.email}</strong> again? Future campaigns can include this address.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setPendingRemove(null)} disabled={isRemoving} className="px-3 py-1.5 rounded-lg text-sm text-slate-200 bg-slate-800 cursor-pointer">Cancel</button>
              <button type="button" onClick={handleConfirmRemove} disabled={isRemoving} className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 cursor-pointer disabled:opacity-50">
                {isRemoving ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SuppressionsPage;
