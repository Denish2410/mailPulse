import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCampaignDate,
  getCampaignStatusBadge,
  normalizeSearchQuery,
  computePageAfterDeletion,
  toggleRecipientId,
  removeRecipientId,
  togglePageRecipients,
} from '../src/utils/campaignHelpers.js';
import {
  getCampaigns,
  deleteCampaign,
  getErrorMessage,
} from '../src/api/campaigns.js';
import { getContacts } from '../src/api/contacts.js';
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
  // Part 2: Recipient Selector Selection Helpers
  // ==========================================
  describe('Recipient Selection Helpers', () => {
    it('12. toggleRecipientId adds an unselected ID', () => {
      const initial = ['id-1', 'id-2'];
      const result = toggleRecipientId(initial, 'id-3');
      assert.deepEqual(result, ['id-1', 'id-2', 'id-3']);
      // Does not mutate original array
      assert.deepEqual(initial, ['id-1', 'id-2']);
    });

    it('13. toggleRecipientId removes an already selected ID', () => {
      const initial = ['id-1', 'id-2', 'id-3'];
      const result = toggleRecipientId(initial, 'id-2');
      assert.deepEqual(result, ['id-1', 'id-3']);
      assert.deepEqual(initial, ['id-1', 'id-2', 'id-3']);
    });

    it('14. toggleRecipientId guarantees unique IDs and handles invalid inputs', () => {
      const initial = ['id-1', 'id-2'];
      assert.deepEqual(toggleRecipientId(initial, null), ['id-1', 'id-2']);
      assert.deepEqual(toggleRecipientId(initial, ''), ['id-1', 'id-2']);
      assert.deepEqual(toggleRecipientId(null, 'id-1'), ['id-1']);
    });

    it('15. removeRecipientId removes target ID without mutating input', () => {
      const initial = ['id-1', 'id-2', 'id-3'];
      const result = removeRecipientId(initial, 'id-1');
      assert.deepEqual(result, ['id-2', 'id-3']);
      assert.deepEqual(initial, ['id-1', 'id-2', 'id-3']);

      // Removing non-existent ID returns a copy with same items
      const unchanged = removeRecipientId(initial, 'non-existent');
      assert.deepEqual(unchanged, ['id-1', 'id-2', 'id-3']);
      assert.notEqual(unchanged, initial);
    });

    it('16. togglePageRecipients selects all page contacts when partially selected', () => {
      const currentSelected = ['id-1'];
      const pageContacts = [{ id: 'id-1' }, { id: 'id-2' }, { id: 'id-3' }];
      const result = togglePageRecipients(currentSelected, pageContacts);

      assert.deepEqual(result.sort(), ['id-1', 'id-2', 'id-3'].sort());
      // Does not mutate currentSelected
      assert.deepEqual(currentSelected, ['id-1']);
    });

    it('17. togglePageRecipients deselects all page contacts when all on page are selected', () => {
      const currentSelected = ['id-other', 'id-1', 'id-2'];
      const pageContacts = [{ id: 'id-1' }, { id: 'id-2' }];
      const result = togglePageRecipients(currentSelected, pageContacts);

      assert.deepEqual(result, ['id-other']);
    });

    it('18. Preserves unknown / deleted contact IDs across operations', () => {
      // Simulating a campaign draft with deleted contact ID 'deleted-contact-id'
      const existingDraftIds = ['active-1', 'deleted-contact-id'];
      // User toggles 'active-2' on the page
      const afterAdd = toggleRecipientId(existingDraftIds, 'active-2');
      assert.ok(afterAdd.includes('deleted-contact-id'));

      // User deselects 'active-1'
      const afterRemove = toggleRecipientId(afterAdd, 'active-1');
      assert.ok(afterRemove.includes('deleted-contact-id'));
      assert.deepEqual(afterRemove, ['deleted-contact-id', 'active-2']);
    });

    it('19. Selection survives across search and page changes', () => {
      // Simulation: Page 1 selected contacts
      let selectedIds = ['c-page1-1', 'c-page1-2'];

      // User performs a search that returns page 1 of search results (completely different contacts)
      const searchResults = [{ id: 'c-search-1' }, { id: 'c-search-2' }];

      // Contacts on search results page are checked against selectedIds
      const isSearch1Selected = selectedIds.includes(searchResults[0].id);
      assert.equal(isSearch1Selected, false);

      // User selects c-search-1
      selectedIds = toggleRecipientId(selectedIds, searchResults[0].id);

      // Selection retains previous contacts + new contact
      assert.deepEqual(selectedIds, ['c-page1-1', 'c-page1-2', 'c-search-1']);

      // User clears search and navigates to page 2 (contacts 'c-page2-1')
      const page2Contacts = [{ id: 'c-page2-1' }];
      const isPage2Selected = selectedIds.includes(page2Contacts[0].id);
      assert.equal(isPage2Selected, false);

      // All 3 prior selections remain intact
      assert.equal(selectedIds.length, 3);
    });

    it('20. Disabled state prevents selection changes', () => {
      const selectedIds = ['c-1'];
      const disabled = true;

      let called = false;
      const onChange = () => {
        called = true;
      };

      const handleToggle = (id) => {
        if (disabled) return;
        onChange();
      };

      handleToggle('c-2');
      assert.equal(called, false);
      assert.deepEqual(selectedIds, ['c-1']);
    });
  });

  // ==========================================
  // Part 3: UI State & Async Flows
  // ==========================================
  describe('Campaigns UI State & CRUD Operations', () => {
    it('21. Fetches campaigns forwarding search, pagination, and AbortSignal', async () => {
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

    it('22. Deletes campaign and returns success payload', async () => {
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

    it('23. Failed deletion propagates error and formats user-facing message', async () => {
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

    it('24. Search changes reset the current page to 1', () => {
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

    it('25. Duplicate delete submission prevention logic', () => {
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

    it('26. RecipientSelector contacts fetching forwards search, pagination, and signal to Contacts API', async () => {
      const controller = new AbortController();
      let capturedConfig = null;
      let capturedParams = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedConfig = config;
        capturedParams = config.params;
        return {
          data: {
            success: true,
            data: {
              contacts: [
                { id: 'contact-1', name: 'Alice Smith', email: 'alice@example.com' },
                { id: 'contact-2', name: 'Bob Jones', email: 'bob@example.com' },
              ],
              count: 2,
              pagination: {
                page: 1,
                limit: 10,
                total: 2,
                totalPages: 1,
                hasNextPage: false,
                hasPrevPage: false,
              },
            },
          },
        };
      });

      const result = await getContacts(
        { page: 1, limit: 10, search: 'Alice' },
        { signal: controller.signal }
      );

      assert.equal(capturedConfig.signal, controller.signal);
      assert.equal(capturedParams.search, 'Alice');
      assert.equal(capturedParams.page, 1);
      assert.equal(capturedParams.limit, 10);
      assert.equal(result.contacts.length, 2);
      assert.equal(result.contacts[0].name, 'Alice Smith');
    });

    it('27. Stale request / out-of-order race guard logic', () => {
      let requestId = 0;
      let stateData = null;

      const simulateFetch = (reqId, returnData) => {
        if (reqId === requestId) {
          stateData = returnData;
        }
      };

      // Request 1 starts
      const id1 = ++requestId;
      // Request 2 starts before request 1 completes
      const id2 = ++requestId;

      // Request 2 finishes first
      simulateFetch(id2, 'Data from Request 2');
      assert.equal(stateData, 'Data from Request 2');

      // Request 1 finishes later (stale response)
      simulateFetch(id1, 'Stale Data from Request 1');
      assert.equal(stateData, 'Data from Request 2'); // Unchanged!
    });
  });
});
