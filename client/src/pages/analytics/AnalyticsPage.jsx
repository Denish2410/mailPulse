import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import Navbar from '../../components/layout/Navbar.jsx';
import { ANALYTICS_RANGES } from '../../api/analytics.js';
import { useAnalyticsOverview } from '../../hooks/useAnalyticsOverview.js';
import { getCampaignStatusBadge } from '../../utils/campaignHelpers.js';
import {
  formatRate,
  formatCount,
  toChartData,
  hasDeliveryActivity,
  describeFailureReasons,
  getRateTone,
} from '../../utils/analyticsHelpers.js';

const card = 'bg-slate-900/60 border border-slate-800 rounded-2xl p-5';

const StatCard = ({ label, value, hint, valueClass = 'text-white' }) => (
  <div className={card}>
    <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`mt-2 text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div>
    {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
  </div>
);

/**
 * AnalyticsPage (Phase 6)
 *
 * Owner-scoped campaign and delivery analytics. "Accepted" means the SMTP provider accepted
 * the message; opens, clicks and bounces are not tracked yet, and the page says so.
 */
export const AnalyticsPage = () => {
  const [days, setDays] = useState(30);
  const [reloadKey, setReloadKey] = useState(0);
  const { data, isLoading, error } = useAnalyticsOverview(days, reloadKey);

  const chartData = toChartData(data?.daily);
  const failures = describeFailureReasons(data?.failureReasons);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-white">Analytics</h1>
            <p className="mt-1 text-sm text-slate-400">
              Delivery performance across your campaigns. Times are grouped by UTC day.
            </p>
          </div>
          <div role="group" aria-label="Date range" className="inline-flex rounded-xl border border-slate-800 bg-slate-900/60 p-1">
            {ANALYTICS_RANGES.map((range) => (
              <button
                key={range}
                type="button"
                aria-pressed={days === range}
                onClick={() => setDays(range)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                  days === range ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Last {range} days
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            <span>{error}</span>
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="font-semibold underline cursor-pointer">
              Retry
            </button>
          </div>
        )}

        {isLoading && !data && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`${card} h-24 animate-pulse`} />
            ))}
          </div>
        )}

        {data && (
          <div className={`space-y-6 transition-opacity ${isLoading ? 'opacity-60' : ''}`}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Contacts" value={formatCount(data.contacts.total)} />
              <StatCard
                label="Campaigns"
                value={formatCount(data.campaigns.total)}
                hint={`${data.campaigns.byStatus.sent} sent · ${data.campaigns.byStatus.draft} drafts`}
              />
              <StatCard
                label={`Accepted (${days}d)`}
                value={formatCount(data.period.sent)}
                hint={`${formatCount(data.period.failed)} failed`}
              />
              <StatCard
                label={`Acceptance rate (${days}d)`}
                value={formatRate(data.period.acceptanceRate)}
                valueClass={getRateTone(data.period.acceptanceRate)}
                hint={`All time: ${formatRate(data.deliveries.acceptanceRate)}`}
              />
            </div>

            <section className={card} aria-labelledby="trend-heading">
              <h2 id="trend-heading" className="text-base font-semibold text-white mb-4">
                Daily deliveries
              </h2>
              {hasDeliveryActivity(data.daily) ? (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="label" stroke="#64748b" fontSize={11} tickLine={false} minTickGap={16} />
                      <YAxis stroke="#64748b" fontSize={11} tickLine={false} allowDecimals={false} />
                      <Tooltip
                        cursor={{ fill: 'rgba(99,102,241,0.08)' }}
                        contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 12, fontSize: 12 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="sent" name="Accepted" stackId="d" fill="#34d399" />
                      <Bar dataKey="failed" name="Failed" stackId="d" fill="#fb7185" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-slate-400">
                  No deliveries in the last {days} days.{' '}
                  <Link to="/campaigns" className="text-indigo-300 underline">Send a campaign</Link> to see activity here.
                </p>
              )}
            </section>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <section className={`${card} lg:col-span-2`} aria-labelledby="recent-heading">
                <h2 id="recent-heading" className="text-base font-semibold text-white mb-4">Recent campaigns</h2>
                {data.recentCampaigns.length === 0 ? (
                  <p className="text-sm text-slate-400">No campaigns have been sent yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="text-left font-medium pb-2">Campaign</th>
                          <th className="text-left font-medium pb-2">Status</th>
                          <th className="text-right font-medium pb-2">Accepted</th>
                          <th className="text-right font-medium pb-2">Failed</th>
                          <th className="text-right font-medium pb-2">Rate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {data.recentCampaigns.map((c) => {
                          const badge = getCampaignStatusBadge(c.status);
                          return (
                            <tr key={c.id}>
                              <td className="py-2.5 pr-4">
                                <div className="font-medium text-slate-200">{c.name}</div>
                                <div className="text-xs text-slate-500 truncate max-w-xs">{c.subject}</div>
                              </td>
                              <td className="py-2.5 pr-4">
                                <span className={`px-2 py-0.5 rounded-full text-xs ${badge.pillClass}`}>{badge.label}</span>
                              </td>
                              <td className="py-2.5 text-right tabular-nums">{formatCount(c.stats.sent)}</td>
                              <td className="py-2.5 text-right tabular-nums">{formatCount(c.stats.failed)}</td>
                              <td className={`py-2.5 text-right tabular-nums ${getRateTone(c.acceptanceRate)}`}>
                                {formatRate(c.acceptanceRate)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className={card} aria-labelledby="failures-heading">
                <h2 id="failures-heading" className="text-base font-semibold text-white mb-4">Failure reasons</h2>
                {failures.length === 0 ? (
                  <p className="text-sm text-slate-400">No failed deliveries.</p>
                ) : (
                  <ul className="space-y-3">
                    {failures.map((f) => (
                      <li key={f.code}>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-300">{f.label}</span>
                          <span className="tabular-nums text-slate-400">{formatCount(f.count)}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-slate-800">
                          <div className="h-1.5 rounded-full bg-rose-400" style={{ width: `${f.share}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <p className="text-xs text-slate-500">
              “Accepted” means the email provider accepted the message. Opens, clicks and bounces are not tracked yet.
            </p>
          </div>
        )}
      </main>
    </div>
  );
};

export default AnalyticsPage;
