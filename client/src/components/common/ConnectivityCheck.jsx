import { useState, useEffect, useCallback, useRef } from 'react';
import { getLiveness, getReadiness } from '../../api/health.js';
import { API_BASE_URL } from '../../lib/api.js';

/**
 * ConnectivityCheck component.
 * Minimal, development-friendly connectivity widget that checks and displays:
 * - Backend API liveness (process uptime)
 * - Database readiness (Mongoose connection & ping)
 *
 * Implements proper cleanup and request cancellation to prevent state updates after unmount.
 */
export default function ConnectivityCheck() {
  const [loading, setLoading] = useState(true);
  const [liveness, setLiveness] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [error, setError] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);

  const abortControllerRef = useRef(null);

  const checkConnection = useCallback(async () => {
    // Abort any ongoing request before starting a new check
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const [liveData, readyData] = await Promise.all([
        getLiveness({ signal: controller.signal }),
        getReadiness({ signal: controller.signal }),
      ]);

      setLiveness(liveData);
      setReadiness(readyData);
      setLastChecked(new Date().toLocaleTimeString());
    } catch (err) {
      // Ignore cancellations caused by unmounting or manual refresh
      if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
        return;
      }

      setLiveness(null);
      setReadiness(null);

      // Provide user-friendly error message without exposing stacks or secrets
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        setError('Connection timed out. The backend server did not respond within 10 seconds.');
      } else if (err.code === 'ERR_NETWORK' || !err.response) {
        setError('Backend server not detected. Verify the Express server is running on port 5000.');
      } else {
        const status = err.response?.status;
        setError(`Backend responded with HTTP ${status || 'unknown'}. Check server logs for details.`);
      }

      setLastChecked(new Date().toLocaleTimeString());
    } finally {
      if (abortControllerRef.current === controller) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    checkConnection();

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [checkConnection]);

  return (
    <div className="w-full rounded-xl bg-slate-950/70 border border-slate-800 p-4 text-xs font-sans transition-all">
      <div className="flex items-center justify-between gap-3 mb-3 pb-2 border-b border-slate-850">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-300 uppercase tracking-wider text-[11px]">
            API Connectivity
          </span>
          <span className="font-mono text-slate-500 text-[10px] hidden sm:inline">
            ({API_BASE_URL})
          </span>
        </div>

        <button
          type="button"
          onClick={checkConnection}
          disabled={loading}
          aria-label="Refresh connection check"
          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50 transition-colors text-[11px] font-medium flex items-center gap-1.5 cursor-pointer"
        >
          <span className={loading ? 'inline-block animate-spin' : ''}>↻</span>
          {loading ? 'Checking...' : 'Re-check'}
        </button>
      </div>

      {loading && !liveness && !error ? (
        <div className="flex items-center justify-center gap-2.5 py-3 text-slate-400">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_8px_#fbbf24]" />
          <span>Verifying connection to MailPulse API...</span>
        </div>
      ) : error ? (
        <div className="space-y-2 py-1">
          <div className="flex items-start gap-2.5 text-rose-400">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 shrink-0 mt-0.5 shadow-[0_0_8px_#f43f5e]" />
            <div className="flex-1 text-left">
              <p className="font-medium">{error}</p>
              <p className="text-[11px] text-slate-400 mt-1">
                Run <code className="bg-slate-800 px-1 py-0.5 rounded text-slate-300 font-mono">npm run dev:server</code> in the project root to start the backend.
              </p>
            </div>
          </div>
          {lastChecked && (
            <div className="text-right text-[10px] text-slate-500">
              Last checked at {lastChecked}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-left">
            {/* Liveness Status Card */}
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-900/60 border border-slate-800/80">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                <span className="text-slate-300 font-medium">Liveness (API)</span>
              </div>
              <span className="font-mono text-emerald-400 font-semibold">
                Online {liveness?.uptime ? `(${liveness.uptime})` : ''}
              </span>
            </div>

            {/* Readiness Status Card */}
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-900/60 border border-slate-800/80">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    readiness?.status === 'ready'
                      ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
                      : 'bg-amber-400 shadow-[0_0_6px_#fbbf24]'
                  }`}
                />
                <span className="text-slate-300 font-medium">Readiness (Database)</span>
              </div>
              <span
                className={`font-mono font-semibold ${
                  readiness?.status === 'ready' ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {readiness?.status === 'ready'
                  ? `Connected${readiness.database?.responseTimeMs != null ? ` (${readiness.database.responseTimeMs}ms)` : ''}`
                  : `Not Ready (${readiness?.database?.status || 'disconnected'})`}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between text-[10px] text-slate-500 pt-1">
            <span>
              Service: <span className="text-slate-400">{liveness?.service || 'MailPulse API'}</span> v{liveness?.version || '1.0.0'}
            </span>
            {lastChecked && <span>Last checked at {lastChecked}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
