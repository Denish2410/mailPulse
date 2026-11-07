import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeVariantStats, extractAnalyticsData } from '../src/utils/campaignHelpers.js';
import { validateCampaignForm } from '../src/utils/validation.js';

const arm = (variant, extra = {}) => ({
  variant,
  subject: `Subject ${variant}`,
  sent: 10,
  uniqueOpens: 4,
  uniqueClicks: 1,
  openRate: 40,
  clickRate: 10,
  ...extra,
});

describe('A/B test client helpers', () => {
  it('normalizes a valid variants block', () => {
    const result = normalizeVariantStats({ arms: [arm('A'), arm('B', { openRate: 55 })], leader: 'B' });
    assert.equal(result.arms.length, 2);
    assert.equal(result.arms[1].openRate, 55);
    assert.equal(result.leader, 'B');
  });

  it('returns null for missing or malformed variants', () => {
    assert.equal(normalizeVariantStats(null), null);
    assert.equal(normalizeVariantStats({}), null);
    assert.equal(normalizeVariantStats({ arms: [arm('A')] }), null);
  });

  it('clamps bad numbers and drops an unknown leader', () => {
    const result = normalizeVariantStats({ arms: [arm('A', { sent: -3, openRate: 'x' }), arm('B')], leader: 'C' });
    assert.equal(result.arms[0].sent, 0);
    assert.equal(result.arms[0].openRate, 0);
    assert.equal(result.leader, null);
  });

  it('exposes variants from the analytics payload, null when absent', () => {
    const withTest = extractAnalyticsData({ data: { analytics: undefined, campaignId: 'c1', metrics: {}, variants: { arms: [arm('A'), arm('B')], leader: null } } });
    assert.equal(withTest.variants.arms.length, 2);
    assert.equal(extractAnalyticsData({ campaignId: 'c1', metrics: {} }).variants, null);
    assert.equal(extractAnalyticsData(null).variants, null);
  });

  it('validates the variant B subject length', () => {
    const base = { name: 'Campaign', subject: 'Hello', textContent: 'Body', htmlContent: '', recipientIds: [] };
    assert.equal(validateCampaignForm({ ...base, subjectB: 'Other' }).isValid, true);
    assert.equal(validateCampaignForm({ ...base, subjectB: '' }).isValid, true);
    const tooLong = validateCampaignForm({ ...base, subjectB: 'x'.repeat(201) });
    assert.equal(tooLong.isValid, false);
    assert.ok(tooLong.errors.subjectB);
  });
});
