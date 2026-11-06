import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import { getCampaignBounces } from '../src/api/campaigns.js';
import { getBounceTypeInfo, extractBounceData, formatBounceRate } from '../src/utils/bounceHelpers.js';

describe('Bounce client', () => {
  afterEach(() => mock.restoreAll());

  it('calls GET /campaigns/:id/bounces and returns the payload', async () => {
    let captured;
    mock.method(apiClient, 'get', async (url, config) => {
      captured = { url, config };
      return { data: { data: { summary: { hardBounces: 1 }, events: [] } } };
    });
    const result = await getCampaignBounces('c1', { signal: 'sig' });
    assert.equal(captured.url, '/campaigns/c1/bounces');
    assert.equal(captured.config.signal, 'sig');
    assert.equal(result.summary.hardBounces, 1);
  });

  it('describes event types', () => {
    assert.equal(getBounceTypeInfo('hard_bounce').label, 'Hard bounce');
    assert.equal(getBounceTypeInfo('soft_bounce').label, 'Soft bounce');
    assert.equal(getBounceTypeInfo('complaint').label, 'Spam complaint');
    assert.equal(getBounceTypeInfo('nope').label, 'Unknown');
    assert.equal(getBounceTypeInfo(undefined).note, '');
  });

  it('normalizes malformed payloads', () => {
    assert.deepEqual(extractBounceData(null), {
      summary: { hardBounces: 0, softBounces: 0, complaints: 0, total: 0 },
      events: [],
    });
    const data = extractBounceData({
      summary: { hardBounces: 2, softBounces: -5, complaints: 1.9 },
      events: [{ id: '1', email: 'a@b.co', eventType: 'hard_bounce' }, { email: 5 }, null, 'x'],
    });
    assert.deepEqual(data.summary, { hardBounces: 2, softBounces: 0, complaints: 1, total: 3 });
    assert.equal(data.events.length, 1);
  });

  it('computes the bounce rate excluding complaints', () => {
    const summary = { hardBounces: 1, softBounces: 2, complaints: 5 };
    assert.equal(formatBounceRate(summary, 100), '3%');
    assert.equal(formatBounceRate({ hardBounces: 1, softBounces: 0 }, 8), '12.5%');
    assert.equal(formatBounceRate(summary, 0), '—');
    assert.equal(formatBounceRate(summary, undefined), '—');
    assert.equal(formatBounceRate({ hardBounces: 9, softBounces: 9 }, 5), '100%');
  });
});
