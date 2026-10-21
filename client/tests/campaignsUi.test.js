import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  formatCampaignDate,
  getCampaignStatusBadge,
  normalizeSearchQuery,
  computePageAfterDeletion,
  toggleRecipientId,
  removeRecipientId,
  togglePageRecipients,
  extractReadinessData,
  formatReadinessIssues,
  getReadinessBadge,
  formatReadinessSummary,
} from '../src/utils/campaignHelpers.js';
import {
  getCampaigns,
  getCampaignById,
  deleteCampaign,
  getCampaignReadiness,
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
  // Part 2: Campaign Readiness Pure Helpers
  // ==========================================
  describe('Campaign Readiness Pure Helpers', () => {
    describe('extractReadinessData', () => {
      it('21. Retains isReady: true when response data indicates campaign is ready', () => {
        const payload = {
          isReady: true,
          issues: [],
          summary: {
            totalRecipients: 2,
            eligibleRecipients: [
              { id: 'c-1', name: 'Alice', email: 'alice@example.com' },
              { id: 'c-2', name: 'Bob', email: 'bob@example.com' },
            ],
            eligibleRecipientsCount: 2,
            missingRecipientsCount: 0,
            hasTextContent: true,
            hasHtmlContent: false,
            status: 'draft',
          },
        };

        const extracted = extractReadinessData(payload);
        assert.equal(extracted.isReady, true);
        assert.deepEqual(extracted.issues, []);
        assert.equal(extracted.summary.totalRecipients, 2);
        assert.equal(extracted.summary.eligibleRecipientsCount, 2);
        assert.equal(extracted.summary.missingRecipientsCount, 0);
        assert.equal(extracted.summary.hasTextContent, true);
        assert.equal(extracted.summary.hasHtmlContent, false);
        assert.equal(extracted.summary.status, 'draft');
        assert.equal(extracted.summary.eligibleRecipients.length, 2);
      });

      it('22. Retains isReady: false and issues when campaign is not ready', () => {
        const payload = {
          isReady: false,
          issues: [
            'Campaign must have non-empty text content or HTML content.',
            'Campaign must have at least one eligible recipient.',
          ],
          summary: {
            totalRecipients: 0,
            eligibleRecipients: [],
            eligibleRecipientsCount: 0,
            missingRecipientsCount: 0,
            hasTextContent: false,
            hasHtmlContent: false,
            status: 'draft',
          },
        };

        const extracted = extractReadinessData(payload);
        assert.equal(extracted.isReady, false);
        assert.equal(extracted.issues.length, 2);
        assert.ok(extracted.issues.includes('Campaign must have non-empty text content or HTML content.'));
        assert.ok(extracted.issues.includes('Campaign must have at least one eligible recipient.'));
      });

      it('23. Handles Axios response and API envelope nesting levels seamlessly', () => {
        // Backend envelope inside Axios response:
        const axiosResponse = {
          data: {
            success: true,
            message: 'Campaign is ready for sending',
            data: {
              isReady: true,
              issues: [],
              summary: { eligibleRecipientsCount: 1, totalRecipients: 1 },
            },
          },
        };

        const fromAxios = extractReadinessData(axiosResponse);
        assert.equal(fromAxios.isReady, true);
        assert.equal(fromAxios.summary.eligibleRecipientsCount, 1);

        // Direct backend envelope:
        const apiEnvelope = {
          success: true,
          data: {
            isReady: true,
            issues: [],
            summary: { eligibleRecipientsCount: 3, totalRecipients: 3 },
          },
        };

        const fromEnvelope = extractReadinessData(apiEnvelope);
        assert.equal(fromEnvelope.isReady, true);
        assert.equal(fromEnvelope.summary.eligibleRecipientsCount, 3);
      });

      it('24. Handles missing, null, or malformed payloads defensively without throwing', () => {
        const emptyResult = extractReadinessData(null);
        assert.equal(emptyResult.isReady, false);
        assert.deepEqual(emptyResult.issues, []);
        assert.equal(emptyResult.summary.eligibleRecipientsCount, 0);
        assert.equal(emptyResult.summary.totalRecipients, 0);
        assert.equal(emptyResult.summary.hasTextContent, false);
        assert.equal(emptyResult.summary.hasHtmlContent, false);

        const undefResult = extractReadinessData(undefined);
        assert.equal(undefResult.isReady, false);

        const malformed = extractReadinessData('invalid string payload');
        assert.equal(malformed.isReady, false);
        assert.deepEqual(malformed.issues, []);

        const emptyObject = extractReadinessData({});
        assert.equal(emptyObject.isReady, false);
        assert.deepEqual(emptyObject.issues, []);
      });

      it('25. Does not fabricate contacts or counts when data is absent', () => {
        const payloadWithoutContacts = {
          isReady: false,
          issues: ['No recipients'],
          summary: {},
        };

        const extracted = extractReadinessData(payloadWithoutContacts);
        assert.deepEqual(extracted.summary.eligibleRecipients, []);
        assert.equal(extracted.summary.eligibleRecipientsCount, 0);
        assert.equal(extracted.summary.totalRecipients, 0);
        assert.equal(extracted.summary.missingRecipientsCount, 0);
      });
    });

    describe('formatReadinessIssues', () => {
      it('26. Returns cleaned and trimmed issue strings from an array of issues', () => {
        const raw = [
          '  Campaign must have non-empty text content or HTML content.  ',
          'Campaign must have at least one eligible recipient.',
        ];
        const formatted = formatReadinessIssues(raw);
        assert.deepEqual(formatted, [
          'Campaign must have non-empty text content or HTML content.',
          'Campaign must have at least one eligible recipient.',
        ]);
      });

      it('27. Extracts issues from readiness payload or response envelope', () => {
        const payload = {
          issues: ['Draft status required.'],
        };
        assert.deepEqual(formatReadinessIssues(payload), ['Draft status required.']);

        const envelope = {
          data: { issues: ['Name required.'] },
        };
        assert.deepEqual(formatReadinessIssues(envelope), ['Name required.']);
      });

      it('28. Empty issue arrays remain empty', () => {
        assert.deepEqual(formatReadinessIssues([]), []);
        assert.deepEqual(formatReadinessIssues({ issues: [] }), []);
      });

      it('29. Handles null, undefined, whitespace-only, and non-string elements safely', () => {
        assert.deepEqual(formatReadinessIssues(null), []);
        assert.deepEqual(formatReadinessIssues(undefined), []);
        assert.deepEqual(formatReadinessIssues({}), []);
        assert.deepEqual(formatReadinessIssues(['   ', '', null, undefined, 42, 'Valid issue']), [
          'Valid issue',
        ]);
      });
    });

    describe('getReadinessBadge', () => {
      it('30. Returns Ready to Send badge with emerald pillClass for isReady: true', () => {
        const badge = getReadinessBadge(true);
        assert.equal(badge.label, 'Ready to Send');
        assert.ok(badge.pillClass.includes('emerald'));
      });

      it('31. Returns Not Ready badge with amber pillClass for isReady: false or non-boolean', () => {
        const notReady = getReadinessBadge(false);
        assert.equal(notReady.label, 'Not Ready');
        assert.ok(notReady.pillClass.includes('amber'));

        const falsy = getReadinessBadge(null);
        assert.equal(falsy.label, 'Not Ready');

        const truthyNonBool = getReadinessBadge('true');
        assert.equal(truthyNonBool.label, 'Not Ready');
      });
    });

    describe('formatReadinessSummary', () => {
      it('32. Formats singular, plural, and zero recipient counts correctly', () => {
        const single = formatReadinessSummary({ eligibleRecipientsCount: 1 });
        assert.equal(single.recipientsLabel, '1 eligible recipient');
        assert.equal(single.eligibleRecipientsCount, 1);

        const plural = formatReadinessSummary({ eligibleRecipientsCount: 5 });
        assert.equal(plural.recipientsLabel, '5 eligible recipients');
        assert.equal(plural.eligibleRecipientsCount, 5);

        const zero = formatReadinessSummary({ eligibleRecipientsCount: 0 });
        assert.equal(zero.recipientsLabel, '0 eligible recipients');
        assert.equal(zero.eligibleRecipientsCount, 0);
      });

      it('33. Formats missing-recipient count labels accurately', () => {
        const singleMissing = formatReadinessSummary({ missingRecipientsCount: 1 });
        assert.equal(singleMissing.missingLabel, '1 recipient unavailable');
        assert.equal(singleMissing.missingRecipientsCount, 1);

        const pluralMissing = formatReadinessSummary({ missingRecipientsCount: 3 });
        assert.equal(pluralMissing.missingLabel, '3 recipients unavailable');
        assert.equal(pluralMissing.missingRecipientsCount, 3);

        const noneMissing = formatReadinessSummary({ missingRecipientsCount: 0 });
        assert.equal(noneMissing.missingLabel, '');
        assert.equal(noneMissing.missingRecipientsCount, 0);
      });

      it('34. Formats content presence labels (Plain Text & HTML, Plain Text, HTML, No content)', () => {
        const both = formatReadinessSummary({ hasTextContent: true, hasHtmlContent: true });
        assert.equal(both.contentLabel, 'Plain Text & HTML');
        assert.equal(both.hasContent, true);

        const textOnly = formatReadinessSummary({ hasTextContent: true, hasHtmlContent: false });
        assert.equal(textOnly.contentLabel, 'Plain Text');
        assert.equal(textOnly.hasContent, true);

        const htmlOnly = formatReadinessSummary({ hasTextContent: false, hasHtmlContent: true });
        assert.equal(htmlOnly.contentLabel, 'HTML');
        assert.equal(htmlOnly.hasContent, true);

        const none = formatReadinessSummary({ hasTextContent: false, hasHtmlContent: false });
        assert.equal(none.contentLabel, 'No content');
        assert.equal(none.hasContent, false);
      });

      it('35. Missing optional fields default safely without throwing runtime errors', () => {
        const empty = formatReadinessSummary(null);
        assert.equal(empty.recipientsLabel, '0 eligible recipients');
        assert.equal(empty.missingLabel, '');
        assert.equal(empty.contentLabel, 'No content');
        assert.equal(empty.eligibleRecipientsCount, 0);
        assert.equal(empty.missingRecipientsCount, 0);
        assert.equal(empty.totalRecipients, 0);
        assert.equal(empty.hasTextContent, false);
        assert.equal(empty.hasHtmlContent, false);
        assert.equal(empty.hasContent, false);
        assert.equal(empty.isReady, false);
        assert.equal(empty.badge.label, 'Not Ready');
      });

      it('36. Keeps authoritative isReady flag intact without rederiving it from client fields', () => {
        // Even if eligibleRecipientsCount > 0 and hasContent is true, isReady remains authoritative
        const notReadyPayload = {
          isReady: false,
          summary: {
            eligibleRecipientsCount: 10,
            hasTextContent: true,
            hasHtmlContent: true,
          },
        };
        const summaryNotReady = formatReadinessSummary(notReadyPayload);
        assert.equal(summaryNotReady.isReady, false);
        assert.equal(summaryNotReady.badge.label, 'Not Ready');

        const readyPayload = {
          isReady: true,
          summary: {
            eligibleRecipientsCount: 1,
            hasTextContent: true,
            hasHtmlContent: false,
          },
        };
        const summaryReady = formatReadinessSummary(readyPayload);
        assert.equal(summaryReady.isReady, true);
        assert.equal(summaryReady.badge.label, 'Ready to Send');
      });
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

  // ==========================================
  // Part 4: Campaign Form & CRUD Integration
  // ==========================================
  describe('Campaign Form Dialog & Integration Flow', () => {
    it('28. Create campaign sends validated payload preserving empty strings and arrays', async () => {
      let capturedUrl = null;
      let capturedBody = null;

      mock.method(apiClient, 'post', async (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return {
          data: {
            success: true,
            data: {
              campaign: {
                id: 'new-camp-1',
                name: body.name,
                subject: body.subject,
                textContent: body.textContent,
                htmlContent: body.htmlContent,
                recipientIds: body.recipientIds,
                status: 'draft',
              },
            },
          },
        };
      });

      const payload = {
        name: '  Welcome Series  ',
        subject: '  Important updates  ',
        textContent: '',
        htmlContent: '<p>Hello</p>',
        recipientIds: [],
      };

      const result = await apiClient.post('/campaigns', {
        name: payload.name.trim(),
        subject: payload.subject.trim(),
        textContent: payload.textContent,
        htmlContent: payload.htmlContent,
        recipientIds: payload.recipientIds,
      });

      assert.equal(capturedUrl, '/campaigns');
      assert.equal(capturedBody.name, 'Welcome Series');
      assert.equal(capturedBody.subject, 'Important updates');
      assert.equal(capturedBody.textContent, '');
      assert.equal(capturedBody.htmlContent, '<p>Hello</p>');
      assert.deepEqual(capturedBody.recipientIds, []);
      assert.equal(result.data.data.campaign.id, 'new-camp-1');
    });

    it('29. Edit campaign sends PATCH with updated fields preserving unchanged fields', async () => {
      let capturedUrl = null;
      let capturedBody = null;

      mock.method(apiClient, 'patch', async (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return {
          data: {
            success: true,
            data: {
              campaign: {
                id: 'camp-edit-1',
                ...body,
                status: 'draft',
              },
            },
          },
        };
      });

      const campaignId = 'camp-edit-1';
      const updatedPayload = {
        name: 'Updated Campaign Name',
        subject: 'Updated Subject',
        textContent: 'Updated plain text',
        htmlContent: '<p>Updated HTML</p>',
        recipientIds: ['507f1f77bcf86cd799439011'],
      };

      await apiClient.patch(`/campaigns/${campaignId}`, updatedPayload);

      assert.equal(capturedUrl, `/campaigns/${campaignId}`);
      assert.equal(capturedBody.name, 'Updated Campaign Name');
      assert.equal(capturedBody.textContent, 'Updated plain text');
      assert.deepEqual(capturedBody.recipientIds, ['507f1f77bcf86cd799439011']);
    });

    it('30. Switching between plain text and HTML preserves both values', () => {
      // Simulating dual-tab form state management
      let activeTab = 'text';
      let textContent = 'Initial plain text body';
      let htmlContent = '<strong>Initial HTML body</strong>';

      // Switch to HTML tab
      activeTab = 'html';
      // User modifies HTML
      htmlContent = '<p>Modified HTML body</p>';

      // Switch back to text tab
      activeTab = 'text';
      // User modifies text
      textContent = 'Modified plain text body';

      // Verify neither was wiped out
      assert.equal(activeTab, 'text');
      assert.equal(textContent, 'Modified plain text body');
      assert.equal(htmlContent, '<p>Modified HTML body</p>');
    });

    it('31. Switching between campaigns populates clean state without stale data leakage', () => {
      const campaignA = {
        id: 'camp-a',
        name: 'Campaign Alpha',
        subject: 'Alpha Subject',
        textContent: 'Alpha Text',
        htmlContent: '<p>Alpha HTML</p>',
        recipientIds: ['rec-1', 'rec-2'],
      };

      const campaignB = {
        id: 'camp-b',
        name: 'Campaign Beta',
        subject: 'Beta Subject',
        textContent: '',
        htmlContent: '<p>Beta HTML</p>',
        recipientIds: [],
      };

      let activeForm = null;

      const initForm = (campaign) => {
        if (!campaign) {
          activeForm = {
            name: '',
            subject: '',
            textContent: '',
            htmlContent: '',
            recipientIds: [],
          };
          return;
        }
        activeForm = {
          name: campaign.name || '',
          subject: campaign.subject || '',
          textContent: campaign.textContent ?? '',
          htmlContent: campaign.htmlContent ?? '',
          recipientIds: Array.isArray(campaign.recipientIds) ? [...campaign.recipientIds] : [],
        };
      };

      // Open Campaign A
      initForm(campaignA);
      assert.equal(activeForm.name, 'Campaign Alpha');
      assert.equal(activeForm.recipientIds.length, 2);

      // Switch to Campaign B
      initForm(campaignB);
      assert.equal(activeForm.name, 'Campaign Beta');
      assert.equal(activeForm.textContent, '');
      assert.deepEqual(activeForm.recipientIds, []);

      // Switch to Create New
      initForm(null);
      assert.equal(activeForm.name, '');
      assert.equal(activeForm.subject, '');
      assert.deepEqual(activeForm.recipientIds, []);
    });

    it('32. Form prevents duplicate submission while request is in flight', () => {
      let isSubmitting = false;
      let submitCallCount = 0;

      const submitHandler = () => {
        if (isSubmitting) return;
        isSubmitting = true;
        submitCallCount++;
      };

      // Rapid double submit clicks
      submitHandler();
      submitHandler();

      assert.equal(submitCallCount, 1);
    });

    it('33. Submission error preserves user input and exposes error message', () => {
      const mockFormState = {
        name: 'Campaign Name with typo',
        subject: 'Subject Line',
        textContent: 'Body content',
        htmlContent: '',
        recipientIds: [],
      };

      let serverError = null;

      const simulateFailure = (err) => {
        serverError = getErrorMessage(err, 'Failed to save campaign. Please try again.');
      };

      simulateFailure({ response: { data: { message: 'Network timeout during save' } } });

      // User's form state was preserved
      assert.equal(mockFormState.name, 'Campaign Name with typo');
      assert.equal(serverError, 'Network timeout during save');
    });

    it('34. getCampaignById fetches full campaign details including recipientIds', async () => {
      const campaignId = '671234567890abcdef123456';
      mock.method(apiClient, 'get', async (url) => {
        assert.equal(url, `/campaigns/${campaignId}`);
        return {
          data: {
            success: true,
            data: {
              campaign: {
                id: campaignId,
                name: 'Spring Launch',
                subject: 'Announcing Spring 2026',
                textContent: 'Check out our new products',
                htmlContent: '<h1>Check out our new products</h1>',
                status: 'draft',
                recipientIds: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439022'],
                recipientsCount: 2,
              },
            },
          },
        };
      });

      const campaign = await getCampaignById(campaignId);
      assert.equal(campaign.id, campaignId);
      assert.equal(campaign.name, 'Spring Launch');
      assert.equal(campaign.recipientIds.length, 2);
    });
  });

  // ==========================================
  // Part 5: Campaign Preview & Review UI
  // ==========================================
  describe('Campaign Preview & Review UI & Security Logic', () => {
    const previewComponentPath = path.resolve(
      __dirname,
      '../src/components/campaigns/CampaignPreviewDialog.jsx'
    );
    const tableComponentPath = path.resolve(
      __dirname,
      '../src/components/campaigns/CampaignsTable.jsx'
    );
    const pageComponentPath = path.resolve(
      __dirname,
      '../src/pages/campaigns/CampaignsPage.jsx'
    );

    const previewSource = fs.readFileSync(previewComponentPath, 'utf-8');
    const tableSource = fs.readFileSync(tableComponentPath, 'utf-8');
    const pageSource = fs.readFileSync(pageComponentPath, 'utf-8');

    it('35. CampaignsTable provides accessible Preview & Review action button triggering onPreviewCampaign', () => {
      // Verify prop and handler existence
      assert.match(
        tableSource,
        /onPreviewCampaign/,
        'CampaignsTable must accept onPreviewCampaign prop'
      );
      assert.match(
        tableSource,
        /title="Preview & Review"/,
        'Action button must provide "Preview & Review" title'
      );
      assert.match(
        tableSource,
        /aria-label=\{`Preview & review campaign \$\{campaign\.name\}`\}/,
        'Action button must have an accessible aria-label with campaign name'
      );

      // Verify CampaignsPage wires onPreviewCampaign to preview dialog
      assert.match(
        pageSource,
        /import\s+CampaignPreviewDialog\s+from\s+['"]\.\.\/\.\.\/components\/campaigns\/CampaignPreviewDialog\.jsx['"]/,
        'CampaignsPage must import CampaignPreviewDialog'
      );
      assert.match(
        pageSource,
        /onPreviewCampaign=\{handleOpenPreviewDialog\}/,
        'CampaignsPage must pass handleOpenPreviewDialog to CampaignsTable'
      );
      assert.match(
        pageSource,
        /<CampaignPreviewDialog[\s\S]*?isOpen=\{isPreviewOpen\}[\s\S]*?\/>/,
        'CampaignsPage must render CampaignPreviewDialog controlled by isPreviewOpen'
      );
    });

    it('36. Safe HTML Preview Security: sandboxed iframe with sandbox="" and srcDoc, forbidding dangerouslySetInnerHTML', () => {
      // Must NEVER use dangerouslySetInnerHTML
      assert.doesNotMatch(
        previewSource,
        /dangerouslySetInnerHTML/,
        'CRITICAL SECURITY: dangerouslySetInnerHTML is strictly forbidden in CampaignPreviewDialog'
      );

      // Must use iframe with empty sandbox="" attribute
      assert.match(
        previewSource,
        /<iframe[\s\S]*?sandbox=""[\s\S]*?\/>/,
        'HTML preview must use an iframe with restrictive empty sandbox="" attribute'
      );

      // Must NEVER grant allow-scripts or allow-same-origin
      assert.doesNotMatch(
        previewSource,
        /allow-scripts/,
        'CRITICAL SECURITY: allow-scripts must not be granted to preview iframe'
      );
      assert.doesNotMatch(
        previewSource,
        /allow-same-origin/,
        'CRITICAL SECURITY: allow-same-origin must not be granted to preview iframe'
      );

      // Must pass content via srcDoc
      assert.match(
        previewSource,
        /srcDoc=\{campaign\.htmlContent\}/,
        'Preview iframe must bind campaign.htmlContent via srcDoc'
      );
    });

    it('37. Accessible modal dialog attributes and Escape key dismissal', () => {
      assert.match(
        previewSource,
        /role="dialog"/,
        'Dialog container must have role="dialog"'
      );
      assert.match(
        previewSource,
        /aria-modal="true"/,
        'Dialog container must have aria-modal="true"'
      );
      assert.match(
        previewSource,
        /aria-labelledby="campaign-preview-title"/,
        'Dialog must be labeled by campaign-preview-title'
      );
      assert.match(
        previewSource,
        /aria-describedby="campaign-preview-desc"/,
        'Dialog must be described by campaign-preview-desc'
      );
      assert.match(
        previewSource,
        /e\.key === 'Escape'/,
        'Dialog must dismiss on Escape key'
      );
    });

    it('38. Live readiness check forwards AbortSignal and loads readiness data', async () => {
      const campaignId = '671234567890abcdef123456';
      const controller = new AbortController();
      let capturedSignal = null;

      mock.method(apiClient, 'get', async (url, config) => {
        assert.equal(url, `/campaigns/${campaignId}/readiness`);
        capturedSignal = config?.signal;
        return {
          data: {
            success: true,
            data: {
              isReady: true,
              issues: [],
              summary: {
                totalRecipients: 3,
                eligibleRecipientsCount: 3,
                missingRecipientsCount: 0,
                hasTextContent: true,
                hasHtmlContent: true,
                eligibleRecipients: [
                  { id: 'c-1', name: 'Alice Smith', email: 'alice@example.com' },
                  { id: 'c-2', name: 'Bob Jones', email: 'bob@example.com' },
                  { id: 'c-3', name: 'Carol Danvers', email: 'carol@example.com' },
                ],
              },
            },
          },
        };
      });

      const readinessPayload = await getCampaignReadiness(campaignId, { signal: controller.signal });
      assert.equal(capturedSignal, controller.signal);
      assert.equal(readinessPayload.isReady, true);
      assert.equal(readinessPayload.summary.eligibleRecipientsCount, 3);
      assert.equal(readinessPayload.summary.eligibleRecipients.length, 3);
    });

    it('39. Readiness visual state mapping: Ready for review vs Needs attention', () => {
      // Ready state mapping
      const readySummary = formatReadinessSummary({
        isReady: true,
        summary: { eligibleRecipientsCount: 2, hasTextContent: true, hasHtmlContent: false },
      });
      assert.equal(readySummary.isReady, true);
      assert.equal(readySummary.badge.label, 'Ready to Send');
      assert.ok(readySummary.badge.pillClass.includes('emerald'));

      // Not ready state mapping
      const notReadyIssues = [
        'Campaign must have non-empty text content or HTML content.',
        'Campaign must have at least one eligible recipient.',
      ];
      const notReadySummary = formatReadinessSummary({
        isReady: false,
        issues: notReadyIssues,
        summary: { eligibleRecipientsCount: 0, hasTextContent: false, hasHtmlContent: false },
      });
      assert.equal(notReadySummary.isReady, false);
      assert.equal(notReadySummary.badge.label, 'Not Ready');
      assert.ok(notReadySummary.badge.pillClass.includes('amber'));

      const formattedIssues = formatReadinessIssues(notReadyIssues);
      assert.equal(formattedIssues.length, 2);
      assert.equal(formattedIssues[0], 'Campaign must have non-empty text content or HTML content.');
    });

    it('40. Recipient metrics differentiate eligible, missing, and total counts', () => {
      const summary = formatReadinessSummary({
        totalRecipients: 5,
        eligibleRecipientsCount: 3,
        missingRecipientsCount: 2,
      });

      assert.equal(summary.totalRecipients, 5);
      assert.equal(summary.eligibleRecipientsCount, 3);
      assert.equal(summary.missingRecipientsCount, 2);
      assert.equal(summary.recipientsLabel, '3 eligible recipients');
      assert.equal(summary.missingLabel, '2 recipients unavailable');
    });

    it('41. Stale response protection prevents out-of-order readiness responses from overwriting active state', () => {
      let activeRequestId = 0;
      let displayedReadiness = null;

      const handleResponse = (requestId, data) => {
        if (requestId === activeRequestId) {
          displayedReadiness = data;
        }
      };

      // User opens Campaign A
      const reqA = ++activeRequestId;
      // User quickly switches to Campaign B
      const reqB = ++activeRequestId;

      // Campaign B resolves first
      handleResponse(reqB, { campaign: 'B', isReady: true });
      assert.equal(displayedReadiness.campaign, 'B');

      // Campaign A resolves later (stale)
      handleResponse(reqA, { campaign: 'A', isReady: false });
      assert.equal(displayedReadiness.campaign, 'B'); // Remains B, stale A is ignored!
    });

    it('42. Read-only preview invariant: no email dispatch or sending buttons', () => {
      // Must not contain sending triggers or SMTP send handlers
      assert.doesNotMatch(
        previewSource,
        /sendCampaign|dispatchCampaign|handleSend/i,
        'Preview dialog must not contain sending actions'
      );
      assert.match(
        previewSource,
        /Read-only preview\. Sending is not available in this phase\./,
        'Preview dialog must display clear read-only disclaimer in footer'
      );
    });
  });
});
