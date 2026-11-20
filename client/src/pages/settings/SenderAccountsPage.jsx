import { useState, useEffect } from 'react';
import Navbar from '../../components/layout/Navbar.jsx';
import {
  getSenderAccounts,
  startGoogleConnection,
  disconnectSenderAccount,
  getErrorMessage,
} from '../../api/senderAccounts.js';
import {
  getConnectErrorMessage,
  isGoogleAuthorizationUrl,
  getSenderStatusInfo,
  STATUS_TONE_CLASSES,
  DISCONNECT_WARNING,
  getDisconnectSuccessMessage,
  getDisconnectErrorMessage,
} from '../../utils/senderAccountHelpers.js';
import { formatCampaignDate } from '../../utils/campaignHelpers.js';

const cardClass = 'p-5 sm:p-6 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col gap-4';

/**
 * SenderAccountsPage: connect the Gmail accounts campaigns are sent from.
 */
export const SenderAccountsPage = () => {
  const [connectState, setConnectState] = useState({ status: 'idle', message: '' });
  const [accounts, setAccounts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pendingDisconnect, setPendingDisconnect] = useState(null);
  const [disconnectState, setDisconnectState] = useState({ status: 'idle', message: '' });

  const [refresh, setRefresh] = useState(0);
  const reload = () => setRefresh((n) => n + 1);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    (async () => {
      try {
        const list = await getSenderAccounts({ signal: controller.signal });
        if (!active) return;
        setAccounts(Array.isArray(list) ? list : []);
        setLoadError(null);
      } catch (err) {
        if (!active || err?.code === 'ERR_CANCELED') return;
        setLoadError(getErrorMessage(err, 'Could not load your Gmail accounts.'));
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [refresh]);

  const handleDisconnect = async () => {
    if (!pendingDisconnect || disconnectState.status === 'working') return;
    setDisconnectState({ status: 'working', message: '' });
    try {
      const { revoked } = await disconnectSenderAccount(pendingDisconnect.id);
      setNotice(getDisconnectSuccessMessage(pendingDisconnect.email, revoked));
      setPendingDisconnect(null);
      setDisconnectState({ status: 'idle', message: '' });
      reload();
    } catch (err) {
      setDisconnectState({ status: 'error', message: getDisconnectErrorMessage(err) });
      if (err?.response?.status === 404) reload();
    }
  };

  const handleConnect = async () => {
    if (connectState.status === 'working') return;
    setConnectState({ status: 'working', message: '' });
    try {
      const { authorizationUrl } = await startGoogleConnection();
      if (!isGoogleAuthorizationUrl(authorizationUrl)) {
        setConnectState({ status: 'error', message: 'The server returned an unexpected address. Please try again.' });
        return;
      }
      window.location.assign(authorizationUrl);
    } catch (err) {
      setConnectState({ status: 'error', message: getConnectErrorMessage(err) });
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-6">
        <header>
          <h1 className="text-2xl font-bold text-slate-50">Gmail accounts</h1>
          <p className="text-sm text-slate-400 mt-1">
            Campaigns are sent from a Gmail account you connect here. MailPulse asks Google only for permission to
            send email on your behalf; you can disconnect at any time.
          </p>
        </header>

        <section className={cardClass} aria-labelledby="connect-heading">
          <h2 id="connect-heading" className="text-sm font-semibold text-slate-100">Connect a Gmail account</h2>
          <p className="text-xs text-slate-400">
            You will be taken to Google to approve access, then returned here.
          </p>
          <div>
            <button
              type="button"
              onClick={handleConnect}
              disabled={connectState.status === 'working'}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 cursor-pointer"
            >
              {connectState.status === 'working' ? 'Opening Google…' : 'Connect Gmail'}
            </button>
          </div>
          {connectState.status === 'error' && (
            <p className="text-sm text-rose-300" role="alert">{connectState.message}</p>
          )}
        </section>

        {notice && (
          <p className="text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3" role="status">
            {notice}
          </p>
        )}

        <section className={cardClass} aria-labelledby="accounts-heading">
          <h2 id="accounts-heading" className="text-sm font-semibold text-slate-100">Your Gmail accounts</h2>

          {isLoading && <p className="text-sm text-slate-400" role="status">Loading your accounts…</p>}

          {!isLoading && loadError && (
            <div className="flex flex-col gap-2" role="alert">
              <p className="text-sm text-rose-300">{loadError}</p>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setIsLoading(true);
                    reload();
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 cursor-pointer"
                >
                  Try again
                </button>
              </div>
            </div>
          )}

          {!isLoading && !loadError && accounts.length === 0 && (
            <p className="text-sm text-slate-400">
              No Gmail account is connected yet. Connect one above to start sending campaigns.
            </p>
          )}

          {!isLoading && !loadError && accounts.length > 0 && (
            <ul className="flex flex-col gap-3">
              {accounts.map((account) => {
                const info = getSenderStatusInfo(account);
                return (
                  <li key={account.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-100 break-all">{account.email}</p>
                        {account.displayName && <p className="text-xs text-slate-400">{account.displayName}</p>}
                      </div>
                      <span className={`inline-flex px-2.5 py-0.5 rounded-full border text-xs font-medium ${STATUS_TONE_CLASSES[info.tone]}`}>
                        {info.label}
                      </span>
                    </div>
                    <p className={`text-xs ${info.tone === 'warn' ? 'text-amber-400' : 'text-slate-400'}`}>{info.explanation}</p>
                    {account.connectedAt && (
                      <p className="text-xs text-slate-500">Connected {formatCampaignDate(account.connectedAt)}</p>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {info.needsReconnect && (
                        <button
                          type="button"
                          onClick={handleConnect}
                          disabled={connectState.status === 'working'}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 cursor-pointer"
                        >
                          Reconnect
                        </button>
                      )}
                      {info.canDisconnect && (
                        <button
                          type="button"
                          onClick={() => {
                            setPendingDisconnect(account);
                            setDisconnectState({ status: 'idle', message: '' });
                          }}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-rose-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 cursor-pointer"
                        >
                          Disconnect
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {pendingDisconnect && (
          <div
            className="fixed inset-0 z-30 flex items-center justify-center p-4 bg-slate-950/60"
            role="dialog"
            aria-modal="true"
            aria-labelledby="disconnect-heading"
          >
            <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-xl flex flex-col gap-4">
              <h2 id="disconnect-heading" className="text-base font-semibold text-slate-50">
                Disconnect {pendingDisconnect.email}?
              </h2>
              <p className="text-sm text-slate-300">{DISCONNECT_WARNING}</p>
              {disconnectState.status === 'error' && (
                <p className="text-sm text-rose-300" role="alert">{disconnectState.message}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingDisconnect(null)}
                  disabled={disconnectState.status === 'working'}
                  className="px-3.5 py-2 rounded-xl text-sm text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-60 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={disconnectState.status === 'working'}
                  className="px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-60 cursor-pointer"
                >
                  {disconnectState.status === 'working' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default SenderAccountsPage;
