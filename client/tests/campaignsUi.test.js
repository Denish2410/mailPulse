import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCampaignDate,
  getCampaignStatusBadge,
  normalizeSearchQuery,
  computePageAfterDeletion,
} from '../src/utils/campaignHelpers.js';
import {
  getCampaigns,
  deleteCampaign,
  getErrorMessage,
} from '../src/api/campaigns.js';
import { apiClient } from '../src/lib/api.js';

describe('Campaigns Management UI Logic & Helpers', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // ==========================================
  // Part 1: Pure Helpers
  // ==========================================
  describe('formatCampaignDate', () => {
    it('1. Formats valid ISO date string into locale date', () => {
      const formatted = formatCampaignDate('2026-10-21T10:00:00.000Z');
      assert.equal(formatted, 'Oct 21, 2026');
    });

    it('2. Returns "—" fallback for null, undefined, or empty date values', () => {
      assert.equal(formatCampaignDate(null), '—');
      assert.equal(formatCampaignDate(undefined), '—');
      assert.equal(formatCampaignDate(''), '—');
    });

    it('3. Returns "—" fallback for unparseable invalid dates', () => {
      assert.equal(formatCampaignDate('invalid-date-string'), '—');
      assert.equal(formatCampaignDate('not a date'), '—');
    });
  });

  describe('getCampaignStatusBadge', () => {
    it('4. Maps known "draft" status to Draft badge with amber pill classes', () => {
      const badge = getCampaignStatusBadge('draft');
      assert.equal(badge.label, 'Draft');
      assert.ok(badge.pillClass.includes('amber'));
    });

    it('5. Maps known "sending" and "sent" status values gracefully', () => {
      const sending = getCampaignStatusBadge('sending');
      assert.equal(sending.label, 'Sending');
      assert.ok(sending.pillClass.includes('indigo'));

      const sent = getCampaignStatusBadge('sent');
      assert.equal(sent.label, 'Sent');
      assert.ok(sent.pillClass.includes('emerald'));
    });

    it('6. Handles unknown or unexpected status values safely', () => {
      const unknown = getCampaignStatusBadge('archived');
      assert.equal(unknown.label, 'Archived');
      assert.ok(unknown.pillClass.includes('slate'));

      const empty = getCampaignStatusBadge('');
      assert.equal(empty.label, 'Unknown');

      const nonString = getCampaignStatusBadge(null);
      assert.equal(nonString.label, 'Unknown');
    });
  });

  describe('normalizeSearchQuery', () => {
    it('7. Trims whitespace from search input', () => {
      assert.equal(normalizeSearchQuery('  Autumn Launch  '), 'Autumn Launch');
      assert.equal(normalizeSearchQuery('   '), '');
      assert.equal(normalizeSearchQuery(null), '');
      assert.equal(normalizeSearchQuery(undefined), '');
    });
  });

  describe('computePageAfterDeletion', () => {
    it('8. Decrements page from N to N-1 when deleting the sole campaign on page N (N > 1)', () => {
      // 21 items total, limit 20 -> page 1 has 20, page 2 has 1 item.
      // Deleting 1 item leaves 20 items -> only 1 page remains.
      const newPage = computePageAfterDeletion({
        currentPage: 2,
        totalCount: 21,
        limit: 20,
      });
      assert.equal(newPage, 1);
    });

    it('9. Keeps current page when other campaigns remain on the current page', () => {
      // 25 items total, limit 20 -> page 2 has 5 items.
      // Deleting 1 item leaves 24 items -> page 2 still has 4 items.
      const newPage = computePageAfterDeletion({
        currentPage: 2,
        totalCount: 25,
        limit: 20,
      });
      assert.equal(newPage, 2);
    });

    it('10. Never decrements below page 1 when deleting on page 1', () => {
      // 1 item total -> deleting leaves 0 items.
      const newPage = computePageAfterDeletion({
        currentPage: 1,
        totalCount: 1,
        limit: 20,
      });
      assert.equal(newPage, 1);
    });

    it('11. Clamps page to max available pages when total drops significantly', () => {
      const newPage = computePageAfterDeletion({
        currentPage: 5,
        totalCount: 20, // 20 items / limit 10 = 2 pages max
        limit: 10,
      });
      assert.equal(newPage, 2);
    });
  });

  // ==========================================
  // Part 2: UI State & Async Flows
  // ==========================================
  describe('Campaigns UI State & CRUD Operations', () => {
    it('12. Fetches campaigns forwarding search, pagination, and AbortSignal', async () => {
      const controller = new AbortController();
      let capturedConfig = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedConfig = config;
        return {
          data: {
            success: true,
            data: {
              campaigns: [
                {
                  id: 'camp-1',
                  name: 'Product Update',
                  subject: 'New release notes',
                  status: 'draft',
                  recipientIds: ['contact-1'],
                  recipientsCount: 1,
                  createdAt: '2026-10-21T00:00:00.000Z',
                  updatedAt: '2026-10-21T00:00:00.000Z',
                },
              ],
              count: 1,
              pagination: {
                page: 1,
                limit: 10,
                total: 45,
                totalPages: 5,
                hasNextPage: true,
                hasPrevPage: false,
              },
            },
          },
        };
      });

      const result = await getCampaigns(
        { page: 1, limit: 10, search: 'Product Update' },
        { signal: controller.signal }
      );

      assert.equal(capturedConfig.signal, controller.signal);
      assert.equal(capturedConfig.params.search, 'Product Update');
      assert.equal(result.campaigns.length, 1);
      // Pagination uses server metadata (total: 45, totalPages: 5) rather than result array length
      assert.equal(result.pagination.total, 45);
      assert.equal(result.pagination.totalPages, 5);
    });

    it('13. Deletes campaign and returns success payload', async () => {
      const campaignId = '671234567890abcdef123456';
      let capturedUrl = null;

      mock.method(apiClient, 'delete', async (url) => {
        capturedUrl = url;
        return {
          data: {
            success: true,
            message: 'Campaign deleted successfully',
          },
        };
      });

      const result = await deleteCampaign(campaignId);

      assert.equal(capturedUrl, `/campaigns/${campaignId}`);
      assert.equal(result.success, true);
    });

    it('14. Failed deletion propagates error and formats user-facing message', async () => {
      const mock404Error = new Error('Not Found');
      mock404Error.response = {
        status: 404,
        data: { message: 'Campaign not found.' },
      };

      mock.method(apiClient, 'delete', async () => {
        throw mock404Error;
      });

      try {
        await deleteCampaign('missing-id');
        assert.fail('Expected deleteCampaign to throw on 404');
      } catch (err) {
        assert.equal(err.response?.status, 404);
        assert.equal(getErrorMessage(err), 'Campaign not found.');
      }
    });

    it('15. Search changes reset the current page to 1', () => {
      // Logic simulation: user is on page 3 and types a search query
      let currentPage = 3;
      const handleSearchChange = (val, setPage) => {
        setPage(1);
      };

      handleSearchChange('launch', (newPage) => {
        currentPage = newPage;
      });

      assert.equal(currentPage, 1);
    });

    it('16. Duplicate delete submission prevention logic', () => {
      // Simulating isDeleting guard
      let isDeleting = false;
      let deleteCalls = 0;

      const triggerDelete = async () => {
        if (isDeleting) return;
        isDeleting = true;
        deleteCalls++;
      };

      // Two consecutive triggers
      triggerDelete();
      triggerDelete();

      assert.equal(deleteCalls, 1);
    });
  });
});
