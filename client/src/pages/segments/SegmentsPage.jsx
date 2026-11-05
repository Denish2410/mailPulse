import { useState, useEffect, useCallback } from 'react';
import Navbar from '../../components/layout/Navbar.jsx';
import SegmentFormDialog from '../../components/segments/SegmentFormDialog.jsx';
import {
  getSegments,
  createSegment,
  updateSegment,
  deleteSegment,
  previewSegment,
  getErrorMessage,
} from '../../api/segments.js';
import { describeCriteria, getSegmentErrorMessage } from '../../utils/segmentHelpers.js';

/**
 * SegmentsPage: saved audience rules (Phase 11).
 */
export const SegmentsPage = () => {
  const [segments, setSegments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [notification, setNotification] = useState(null);
  const [dialog, setDialog] = useState(null); // { segment } | null
  const [pendingDelete, setPendingDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [counts, setCounts] = useState({}); // id -> { status, total }

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    (async () => {
      setIsLoading(true);
      try {
        const data = await getSegments({ limit: 100 }, { signal: controller.signal });
        if (!active) return;
        setSegments(data?.segments ?? []);
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

  const handleCount = async (segment) => {
    setCounts((prev) => ({ ...prev, [segment.id]: { status: 'loading', total: 0 } }));
    try {
      const preview = await previewSegment(segment.id);
      setCounts((prev) => ({ ...prev, [segment.id]: { status: 'ready', total: preview?.total ?? 0 } }));
    } catch {
      setCounts((prev) => ({ ...prev, [segment.id]: { status: 'error', total: 0 } }));
    }
  };

  const handleSubmit = async (payload) => {
    if (dialog?.segment) {
      await updateSegment(dialog.segment.id, payload);
      notify('success', 'Segment updated.');
    } else {
      await createSegment(payload);
      notify('success', 'Segment created.');
    }
    setDialog(null);
    setCounts({});
    setRefresh((n) => n + 1);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteSegment(pendingDelete.id);
      notify('success', 'Segment deleted.');
      setRefresh((n) => n + 1);
    } catch (err) {
      notify('error', getSegmentErrorMessage(err));
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
              Phase 11 — Segmentation &amp; Tagging
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Segments</h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Save audience rules built from tags and engagement, then target campaigns with them.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDialog({ segment: null })}
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/30 cursor-pointer"
          >
            New Segment
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

        {isLoading ? (
          <p className="text-sm text-slate-400" role="status">Loading segments…</p>
        ) : loadError ? (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => setRefresh((n) => n + 1)} className="underline cursor-pointer">Retry</button>
          </div>
        ) : segments.length === 0 ? (
          <div className="p-10 text-center rounded-2xl border border-dashed border-slate-800 text-sm text-slate-400">
            No segments yet. Tag your contacts, then save rules like “VIPs who opened in the last 30 days”.
          </div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {segments.map((segment) => {
              const count = counts[segment.id];
              return (
                <li key={segment.id} className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col gap-3">
                  <div>
                    <h2 className="font-semibold text-white truncate">{segment.name}</h2>
                    {segment.description && <p className="text-xs text-slate-400 mt-0.5">{segment.description}</p>}
                  </div>
                  <p className="text-xs text-slate-300">{describeCriteria(segment.criteria)}</p>
                  <div className="flex items-center justify-between mt-auto pt-2 border-t border-slate-800">
                    <button
                      type="button"
                      onClick={() => handleCount(segment)}
                      disabled={count?.status === 'loading'}
                      className="text-xs font-semibold text-indigo-300 hover:text-indigo-200 cursor-pointer disabled:opacity-50"
                    >
                      {count?.status === 'loading'
                        ? 'Counting…'
                        : count?.status === 'ready'
                        ? `${count.total} matching ${count.total === 1 ? 'contact' : 'contacts'} (refresh)`
                        : count?.status === 'error'
                        ? 'Count failed — retry'
                        : 'Count matching contacts'}
                    </button>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setDialog({ segment })} aria-label={`Edit segment ${segment.name}`} className="px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 cursor-pointer">
                        Edit
                      </button>
                      <button type="button" onClick={() => setPendingDelete(segment)} aria-label={`Delete segment ${segment.name}`} className="px-2.5 py-1 rounded-lg text-xs font-semibold text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 cursor-pointer">
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {dialog && (
        <SegmentFormDialog
          key={dialog.segment?.id ?? 'new'}
          segment={dialog.segment}
          onClose={() => setDialog(null)}
          onSubmit={handleSubmit}
        />
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-label="Confirm segment deletion">
          <div className="fixed inset-0 bg-slate-950/80" aria-hidden="true" />
          <div className="relative z-10 w-full max-w-sm p-6 rounded-2xl bg-slate-900 border border-slate-800">
            <p className="text-sm text-slate-200">
              Delete segment <strong>{pendingDelete.name}</strong>? Campaigns that already used it keep their recipients.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setPendingDelete(null)} disabled={isDeleting} className="px-3 py-1.5 rounded-lg text-sm text-slate-200 bg-slate-800 cursor-pointer">Cancel</button>
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

export default SegmentsPage;
