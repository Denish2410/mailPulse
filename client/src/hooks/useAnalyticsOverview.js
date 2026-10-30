import { useEffect, useState } from 'react';
import { getAnalyticsOverview, getErrorMessage } from '../api/analytics.js';

/**
 * Loads the analytics overview for a range and re-fetches when `days` or `reloadKey` change.
 *
 * Loading is derived (the stored result belongs to an older request) instead of being set
 * inside the effect, and in-flight requests are aborted so stale responses never win.
 * The previous data stays visible while a new range loads.
 */
export const useAnalyticsOverview = (days, reloadKey = 0) => {
  const requestKey = `${days}:${reloadKey}`;
  const [state, setState] = useState({ key: null, data: null, error: null });

  useEffect(() => {
    const controller = new AbortController();

    getAnalyticsOverview({ days }, { signal: controller.signal })
      .then((data) => setState({ key: requestKey, data, error: null }))
      .catch((err) => {
        if (controller.signal.aborted || err?.code === 'ERR_CANCELED') return;
        setState((prev) => ({ key: requestKey, data: prev.data, error: getErrorMessage(err) }));
      });

    return () => controller.abort();
  }, [days, requestKey]);

  const isCurrent = state.key === requestKey;
  return {
    data: state.data,
    isLoading: !isCurrent,
    error: isCurrent ? state.error : null,
  };
};

export default useAnalyticsOverview;
