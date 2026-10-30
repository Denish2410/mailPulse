import { useAuth } from '../../hooks/useAuth.js';
import Navbar from '../../components/layout/Navbar.jsx';
import ConnectivityCheck from '../../components/common/ConnectivityCheck.jsx';
import { Link } from 'react-router-dom';
import { useAnalyticsOverview } from '../../hooks/useAnalyticsOverview.js';
import { formatCount, formatRate } from '../../utils/analyticsHelpers.js';

const SummaryRow = ({ label, value, last = false }) => (
  <div className={`flex items-center justify-between py-1.5 ${last ? '' : 'border-b border-slate-800'}`}>
    <span>{label}</span>
    <span className="font-medium text-slate-300 tabular-nums">{value}</span>
  </div>
);

export const DashboardPage = () => {
  const { user } = useAuth();
  const { data, isLoading, error } = useAnalyticsOverview(30);
  const show = (fn) => (data ? fn(data) : isLoading ? '…' : '—');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-indigo-500 selection:text-white">
      <Navbar />


      {/* Main Dashboard Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome Banner */}
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 mb-8 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-semibold tracking-wide uppercase mb-3 border border-indigo-500/20">
                Active Session
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
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-base font-semibold text-white">Last 30 days</h2>
              <Link to="/analytics" className="text-xs font-medium text-indigo-300 hover:text-indigo-200">
                View analytics →
              </Link>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              {error ? `Could not load summary: ${error}` : 'Live summary of your audience and sending.'}
            </p>
            <div className="space-y-2 text-xs text-slate-400">
              <SummaryRow label="Contacts" value={show((d) => formatCount(d.contacts.total))} />
              <SummaryRow label="Draft campaigns" value={show((d) => formatCount(d.campaigns.byStatus.draft))} />
              <SummaryRow label="Sent campaigns" value={show((d) => formatCount(d.campaigns.byStatus.sent))} />
              <SummaryRow label="Emails accepted" value={show((d) => formatCount(d.period.sent))} />
              <SummaryRow label="Acceptance rate" value={show((d) => formatRate(d.period.acceptanceRate))} last />
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
