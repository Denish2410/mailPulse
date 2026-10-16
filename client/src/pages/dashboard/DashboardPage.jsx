import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';
import ConnectivityCheck from '../../components/common/ConnectivityCheck.jsx';

export const DashboardPage = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-indigo-500 selection:text-white">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-md shadow-indigo-500/20">
              <svg
                className="w-4 h-4 text-white"
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
            <span className="text-lg font-bold tracking-tight text-white">MailPulse</span>
            <span className="ml-2 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Authenticated
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden sm:flex flex-col items-end text-right">
              <span className="text-sm font-medium text-slate-200">{user?.name || 'User'}</span>
              <span className="text-xs text-slate-400">{user?.email || ''}</span>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-700/80 hover:text-white border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              <svg
                className="w-4 h-4 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                />
              </svg>
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Dashboard Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome Banner */}
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 mb-8 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-semibold tracking-wide uppercase mb-3 border border-indigo-500/20">
                Phase 2 — Active Session
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white">
                Welcome back, {user?.name || 'User'}!
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                Your authenticated session is active. Current account status:{' '}
                <span className="font-semibold text-emerald-400 uppercase text-xs tracking-wider">
                  {user?.status || 'active'}
                </span>
              </p>
            </div>
            <div className="p-3 bg-slate-800/60 rounded-xl border border-slate-700 text-xs text-slate-300">
              <div><span className="text-slate-400">Account ID:</span> <span className="font-mono">{user?.id || '—'}</span></div>
              <div className="mt-1"><span className="text-slate-400">Email:</span> <span className="font-mono">{user?.email || '—'}</span></div>
            </div>
          </div>
        </div>

        {/* Workspace Diagnostics & Status */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <div className="lg:col-span-1 bg-slate-900/60 border border-slate-800 rounded-2xl p-6">
            <h2 className="text-base font-semibold text-white mb-2">Campaign Manager</h2>
            <p className="text-xs text-slate-400 mb-4">
              Campaign orchestration, analytics pipelines, and audience segmentation will be enabled in future Phase 2 steps.
            </p>
            <div className="space-y-2 text-xs text-slate-400">
              <div className="flex items-center justify-between py-1.5 border-b border-slate-800">
                <span>Campaigns</span>
                <span className="font-medium text-slate-300">0 Active</span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-slate-800">
                <span>Contact Lists</span>
                <span className="font-medium text-slate-300">0 Lists</span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span>Email Sending API</span>
                <span className="font-medium text-slate-300">Ready for Step 6</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 bg-slate-900/60 border border-slate-800 rounded-2xl p-6">
            <h2 className="text-base font-semibold text-white mb-2">Live Backend Connectivity</h2>
            <p className="text-xs text-slate-400 mb-4">
              Diagnostic verification of the Express API and MongoDB database health.
            </p>
            <ConnectivityCheck />
          </div>
        </div>
      </main>
    </div>
  );
};

export default DashboardPage;
