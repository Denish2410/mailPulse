import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiClient } from '../src/lib/api.js';
import { getAnalyticsOverview } from '../src/api/analytics.js';
import {
  formatRate,
  formatCount,
  formatDayLabel,
  toChartData,
  hasDeliveryActivity,
  describeFailureReasons,
  getRateTone,
} from '../src/utils/analyticsHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => fs.readFileSync(path.resolve(__dirname, relative), 'utf-8');

describe('Analytics (Phase 6)', () => {
  afterEach(() => mock.restoreAll());

  describe('getAnalyticsOverview API client', () => {
    it('GETs /analytics/overview with the requested range and unwraps data', async () => {
      let captured;
      mock.method(apiClient, 'get', async (url, config) => {
        captured = { url, config };
        return { data: { success: true, data: { range: { days: 7 } } } };
      });
      const data = await getAnalyticsOverview({ days: 7 });
      assert.equal(captured.url, '/analytics/overview');
      assert.deepEqual(captured.config.params, { days: 7 });
      assert.deepEqual(data, { range: { days: 7 } });
    });

    it('falls back to 30 days for unsupported ranges', async () => {
      const seen = [];
      mock.method(apiClient, 'get', async (url, config) => {
        seen.push(config.params.days);
        return { data: { data: {} } };
      });
      await getAnalyticsOverview({ days: 45 });
      await getAnalyticsOverview({ days: 'abc' });
      await getAnalyticsOverview();
      await getAnalyticsOverview({ days: '90' });
      assert.deepEqual(seen, [30, 30, 30, 90]);
    });

    it('forwards an abort signal', async () => {
      const controller = new AbortController();
      let signal;
      mock.method(apiClient, 'get', async (url, config) => {
        signal = config.signal;
        return { data: { data: {} } };
      });
      await getAnalyticsOverview({ days: 7 }, { signal: controller.signal });
      assert.equal(signal, controller.signal);
    });
  });

  describe('analytics helpers', () => {
    it('formats rates and counts', () => {
      assert.equal(formatRate(97.5), '97.5%');
      assert.equal(formatRate(null), '—');
      assert.equal(formatRate(NaN), '—');
      assert.equal(formatCount(1234567), '1,234,567');
      assert.equal(formatCount(undefined), '0');
      assert.equal(formatCount(-5), '0');
    });

    it('formats UTC day keys without timezone shifts', () => {
      assert.equal(formatDayLabel('2026-10-30'), 'Oct 30');
      assert.equal(formatDayLabel('2026-01-01'), 'Jan 1');
      assert.equal(formatDayLabel('bad'), '');
    });

    it('builds chart rows and detects activity', () => {
      const daily = [
        { date: '2026-10-29', sent: 0, failed: 0 },
        { date: '2026-10-30', sent: 2, failed: 1 },
      ];
      assert.equal(toChartData(daily)[1].label, 'Oct 30');
      assert.deepEqual(toChartData(null), []);
      assert.equal(hasDeliveryActivity(daily), true);
      assert.equal(hasDeliveryActivity([daily[0]]), false);
    });

    it('describes failure reasons with their share', () => {
      const result = describeFailureReasons([
        { code: 'TRANSPORT_ERROR', count: 3 },
        { code: 'UNKNOWN_ERROR', count: 1 },
      ]);
      assert.equal(result[0].label, 'Rejected by the email provider');
      assert.equal(result[0].share, 75);
      assert.equal(result[1].label, 'Unknown error');
      assert.deepEqual(describeFailureReasons(undefined), []);
    });

    it('picks a tone for acceptance rates', () => {
      assert.equal(getRateTone(99), 'text-emerald-300');
      assert.equal(getRateTone(85), 'text-amber-300');
      assert.equal(getRateTone(10), 'text-rose-300');
      assert.equal(getRateTone(null), 'text-slate-300');
    });
  });

  describe('wiring', () => {
    it('registers the protected /analytics route and nav link', () => {
      assert.match(readSource('../src/App.jsx'), /path="\/analytics" element={<AnalyticsPage \/>}/);
      assert.match(readSource('../src/components/layout/Navbar.jsx'), /to="\/analytics"/);
    });

    it('dashboard shows live data instead of placeholders', () => {
      const dashboard = readSource('../src/pages/dashboard/DashboardPage.jsx');
      assert.match(dashboard, /useAnalyticsOverview\(30\)/);
      assert.doesNotMatch(dashboard, /Ready for Step 6/);
    });

    it('page discloses that opens/clicks are not tracked', () => {
      assert.match(readSource('../src/pages/analytics/AnalyticsPage.jsx'), /not tracked yet/);
    });
  });
});
