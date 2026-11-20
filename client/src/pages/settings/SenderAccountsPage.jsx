import { useState } from 'react';
import Navbar from '../../components/layout/Navbar.jsx';
import { startGoogleConnection } from '../../api/senderAccounts.js';
import { getConnectErrorMessage, isGoogleAuthorizationUrl } from '../../utils/senderAccountHelpers.js';

const cardClass = 'p-5 sm:p-6 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col gap-4';

/**
 * SenderAccountsPage: connect the Gmail accounts campaigns are sent from.
 */
export const SenderAccountsPage = () => {
  const [connectState, setConnectState] = useState({ status: 'idle', message: '' });

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
      </main>
    </div>
  );
};

export default SenderAccountsPage;
