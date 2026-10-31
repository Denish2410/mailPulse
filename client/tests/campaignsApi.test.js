import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient, getErrorMessage } from '../src/lib/api.js';
import {
  getCampaigns,
  getCampaignById,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaignReadiness,
  getCampaignAnalytics,
} from '../src/api/campaigns.js';
import {
  validateCampaignName,
  validateCampaignSubject,
  validateCampaignTextContent,
  validateCampaignHtmlContent,
  validateCampaignContent,
  validateCampaignRecipients,
  deduplicateRecipientIds,
  validateCampaignForm,
} from '../src/utils/validation.js';

describe('Campaigns API Client & Campaign Validation', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // ==========================================
  // Part 1: Campaigns API Service Tests
  // ==========================================
  describe('Campaigns API Service', () => {
    describe('getCampaigns', () => {
      it('1. Calls GET /campaigns with default query parameters and returns data with pagination metadata', async () => {
        const mockBackendResponse = {
          data: {
            success: true,
            message: 'Campaigns retrieved successfully',
            data: {
              campaigns: [
                {
                  id: '671234567890abcdef123456',
                  name: 'Fall Product Announcement',
                  subject: 'Check out our new features',
                  textContent: 'Hello world',
                  htmlContent: '<p>Hello world</p>',
                  status: 'draft',
                  recipientIds: ['671234567890abcdef123457'],
                  recipientsCount: 1,
                  createdAt: '2026-10-21T00:00:00.000Z',
                  updatedAt: '2026-10-21T00:00:00.000Z',
                },
              ],
              count: 1,
              pagination: {
                page: 1,
                limit: 20,
                total: 1,
                totalPages: 1,
                hasNextPage: false,
                hasPrevPage: false,
              },
            },
          },
        };

        let capturedUrl = null;
        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedUrl = url;
          capturedConfig = config;
          return mockBackendResponse;
        });

        const result = await getCampaigns();

        assert.equal(capturedUrl, '/campaigns');
        assert.deepEqual(capturedConfig.params, {});
        assert.deepEqual(result.campaigns, mockBackendResponse.data.data.campaigns);
        assert.deepEqual(result.pagination, mockBackendResponse.data.data.pagination);
        assert.equal(result.count, 1);
      });

      it('2. Serializes valid pagination numbers, trimmed search, and status filters', async () => {
        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedConfig = config;
          return { data: { success: true, data: { campaigns: [], pagination: {} } } };
        });

        await getCampaigns({
          page: 2,
          limit: 50,
          search: '  Special Announcement  ',
          status: '  draft  ',
        });

        assert.deepEqual(capturedConfig.params, {
          page: 2,
          limit: 50,
          search: 'Special Announcement',
          status: 'draft',
        });
      });

      it('3. Converts numeric string pagination values to integers and omits invalid filters', async () => {
        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedConfig = config;
          return { data: { success: true, data: { campaigns: [] } } };
        });

        await getCampaigns({
          page: '3',
          limit: '25',
          search: '   ',
          status: '',
        });

        assert.equal(capturedConfig.params.page, 3);
        assert.equal(capturedConfig.params.limit, 25);
        assert.equal('search' in capturedConfig.params, false);
        assert.equal('status' in capturedConfig.params, false);
      });

      it('4. Passes request configuration and cancellation signals', async () => {
        const controller = new AbortController();
        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedConfig = config;
          return { data: { success: true, data: { campaigns: [] } } };
        });

        await getCampaigns({}, { signal: controller.signal, headers: { 'X-Custom': 'test' } });

        assert.equal(capturedConfig.signal, controller.signal);
        assert.equal(capturedConfig.headers['X-Custom'], 'test');
      });
    });

    describe('getCampaignById', () => {
      it('5. Calls GET /campaigns/:id and returns safe campaign object', async () => {
        const campaignId = '671234567890abcdef123456';
        const mockCampaign = {
          id: campaignId,
          name: 'Spring Launch',
          subject: 'Welcome to Spring',
          textContent: 'Launch details',
          htmlContent: '<p>Launch details</p>',
          status: 'draft',
          recipientIds: [],
          recipientsCount: 0,
          createdAt: '2026-10-21T00:00:00.000Z',
          updatedAt: '2026-10-21T00:00:00.000Z',
        };

        let capturedUrl = null;
        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedUrl = url;
          capturedConfig = config;
          return {
            data: {
              success: true,
              message: 'Campaign retrieved successfully',
              data: { campaign: mockCampaign },
            },
          };
        });

        const result = await getCampaignById(campaignId, { headers: { 'X-Test': '1' } });

        assert.equal(capturedUrl, `/campaigns/${campaignId}`);
        assert.equal(capturedConfig.headers['X-Test'], '1');
        assert.deepEqual(result, mockCampaign);
      });
    });

    describe('createCampaign', () => {
      it('6. Calls POST /campaigns sending supported fields with whitespace trimmed and recipientIds deduplicated', async () => {
        const mockCreated = {
          id: '671234567890abcdef123456',
          name: 'Summer Promo',
          subject: 'Exclusive Deals',
          textContent: '50% off everything',
          htmlContent: '<h1>50% off</h1>',
          status: 'draft',
          recipientIds: ['671234567890abcdef123457'],
          recipientsCount: 1,
          createdAt: '2026-10-21T00:00:00.000Z',
          updatedAt: '2026-10-21T00:00:00.000Z',
        };

        let capturedUrl = null;
        let capturedBody = null;

        mock.method(apiClient, 'post', async (url, body) => {
          capturedUrl = url;
          capturedBody = body;
          return {
            data: {
              success: true,
              message: 'Campaign draft created successfully',
              data: { campaign: mockCreated },
            },
          };
        });

        const result = await createCampaign({
          name: '  Summer Promo  ',
          subject: '  Exclusive Deals  ',
          textContent: '50% off everything',
          htmlContent: '<h1>50% off</h1>',
          recipientIds: [
            '671234567890abcdef123457',
            '671234567890abcdef123457', // duplicate
          ],
          // Protected fields that must be stripped:
          _id: 'tampered-id',
          userId: 'tampered-user',
          status: 'sent',
          createdAt: 'tampered-date',
          updatedAt: 'tampered-date',
          recipientsCount: 999,
        });

        assert.equal(capturedUrl, '/campaigns');
        assert.deepEqual(capturedBody, {
          name: 'Summer Promo',
          subject: 'Exclusive Deals',
          textContent: '50% off everything',
          htmlContent: '<h1>50% off</h1>',
          recipientIds: ['671234567890abcdef123457'],
        });
        assert.equal('status' in capturedBody, false);
        assert.equal('userId' in capturedBody, false);
        assert.equal('_id' in capturedBody, false);
        assert.equal('createdAt' in capturedBody, false);
        assert.equal('updatedAt' in capturedBody, false);
        assert.equal('recipientsCount' in capturedBody, false);
        assert.deepEqual(result, mockCreated);
      });
    });

    describe('updateCampaign', () => {
      it('7. Calls PATCH /campaigns/:id preserving omitted properties and explicit empty values', async () => {
        const campaignId = '671234567890abcdef123456';
        let capturedUrl = null;
        let capturedBody = null;

        mock.method(apiClient, 'patch', async (url, body) => {
          capturedUrl = url;
          capturedBody = body;
          return {
            data: {
              success: true,
              message: 'Campaign updated successfully',
              data: {
                campaign: {
                  id: campaignId,
                  name: 'Updated Name',
                  subject: 'Original Subject',
                  textContent: '',
                  htmlContent: '',
                  status: 'draft',
                  recipientIds: [],
                  recipientsCount: 0,
                },
              },
            },
          };
        });

        await updateCampaign(campaignId, {
          name: '  Updated Name  ',
          textContent: '', // explicitly clearing text
          htmlContent: '', // explicitly clearing html
          recipientIds: [], // explicitly clearing recipients
          // Protected fields:
          status: 'sent',
          userId: 'hacker',
          _id: 'tampered',
        });

        assert.equal(capturedUrl, `/campaigns/${campaignId}`);
        assert.deepEqual(capturedBody, {
          name: 'Updated Name',
          textContent: '',
          htmlContent: '',
          recipientIds: [],
        });
        // subject was omitted and must remain omitted
        assert.equal('subject' in capturedBody, false);
        // Protected fields must not be present
        assert.equal('status' in capturedBody, false);
        assert.equal('userId' in capturedBody, false);
      });

      it('8. Supports partial update with only name or only subject', async () => {
        let capturedBody = null;

        mock.method(apiClient, 'patch', async (url, body) => {
          capturedBody = body;
          return { data: { success: true, data: { campaign: {} } } };
        });

        await updateCampaign('camp-1', { name: 'Only Name Changed' });
        assert.deepEqual(capturedBody, { name: 'Only Name Changed' });

        await updateCampaign('camp-1', { subject: 'Only Subject Changed' });
        assert.deepEqual(capturedBody, { subject: 'Only Subject Changed' });
      });
    });

    describe('deleteCampaign', () => {
      it('9. Calls DELETE /campaigns/:id and returns deletion response', async () => {
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
        assert.equal(result.message, 'Campaign deleted successfully');
      });
    });

    describe('getCampaignReadiness', () => {
      it('10. Calls GET /campaigns/:id/readiness and returns readiness data payload', async () => {
        const campaignId = '671234567890abcdef123456';
        const mockReadinessData = {
          isReady: true,
          issues: [],
          summary: {
            totalRecipients: 2,
            eligibleRecipients: [
              { id: '671234567890abcdef123457', name: 'Alice Smith', email: 'alice@example.com' },
              { id: '671234567890abcdef123458', name: 'Bob Jones', email: 'bob@example.com' },
            ],
            eligibleRecipientsCount: 2,
            missingRecipientsCount: 0,
            hasTextContent: true,
            hasHtmlContent: false,
            status: 'draft',
          },
        };

        let capturedUrl = null;
        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedUrl = url;
          capturedConfig = config;
          return {
            data: {
              success: true,
              message: 'Campaign is ready for sending',
              data: mockReadinessData,
            },
          };
        });

        const result = await getCampaignReadiness(campaignId);

        assert.equal(capturedUrl, `/campaigns/${campaignId}/readiness`);
        assert.deepEqual(capturedConfig, {});
        assert.deepEqual(result, mockReadinessData);
        assert.equal(result.isReady, true);
        assert.equal(result.summary.eligibleRecipientsCount, 2);
      });

      it('11. Forwards optional Axios request configuration (AbortSignal, headers) without mutating config', async () => {
        const controller = new AbortController();
        const customConfig = {
          signal: controller.signal,
          headers: { 'X-Custom-Header': 'ReadinessCheck' },
        };
        const configCopy = { ...customConfig, headers: { ...customConfig.headers } };

        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedConfig = config;
          return {
            data: {
              success: true,
              data: { isReady: false, issues: ['Draft only'], summary: {} },
            },
          };
        });

        const result = await getCampaignReadiness('camp-123', customConfig);

        assert.equal(capturedConfig.signal, controller.signal);
        assert.equal(capturedConfig.headers['X-Custom-Header'], 'ReadinessCheck');
        assert.deepEqual(customConfig, configCopy);
        assert.equal(result.isReady, false);
      });

      it('12. Propagates rejected API errors (e.g. 404, 401, 500) to the caller', async () => {
        const mockError = new Error('Campaign not found.');
        mockError.response = {
          status: 404,
          data: { success: false, message: 'Campaign not found.' },
        };

        mock.method(apiClient, 'get', async () => {
          throw mockError;
        });

        await assert.rejects(
          async () => {
            await getCampaignReadiness('missing-camp-id');
          },
          (err) => {
            assert.equal(err.response?.status, 404);
            assert.equal(getErrorMessage(err), 'Campaign not found.');
            return true;
          }
        );
      });
    });

    describe('getCampaignAnalytics', () => {
      it('13. Calls GET /campaigns/:id/analytics and returns tracking summary data', async () => {
        const campaignId = '671234567890abcdef123456';
        const mockAnalyticsData = {
          campaignId,
          campaignName: 'Test Campaign',
          campaignSubject: 'Test Subject',
          status: 'sent',
          totalRecipients: 50,
          metrics: {
            totalOpens: 25,
            uniqueOpens: 20,
            openRate: 40.0,
            totalClicks: 10,
            uniqueClicks: 8,
            clickThroughRate: 40.0,
            clickToDeliveredRate: 16.0,
          },
          linkBreakdown: [
            { url: 'https://example.com/deal', totalClicks: 10, uniqueClicks: 8 },
          ],
          recentActivity: [
            {
              id: 'evt-1',
              eventType: 'open',
              recipientEmail: 'user@example.com',
              timestamp: '2026-10-31T12:00:00.000Z',
            },
          ],
        };

        let capturedUrl = null;
        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedUrl = url;
          capturedConfig = config;
          return {
            data: {
              success: true,
              message: 'Campaign analytics retrieved successfully',
              data: mockAnalyticsData,
            },
          };
        });

        const result = await getCampaignAnalytics(campaignId);

        assert.equal(capturedUrl, `/campaigns/${campaignId}/analytics`);
        assert.deepEqual(capturedConfig, {});
        assert.deepEqual(result, mockAnalyticsData);
        assert.equal(result.metrics.openRate, 40.0);
        assert.equal(result.metrics.uniqueOpens, 20);
        assert.equal(result.linkBreakdown.length, 1);
      });

      it('14. Forwards optional Axios configuration (signal, custom headers)', async () => {
        const controller = new AbortController();
        const customConfig = {
          signal: controller.signal,
          headers: { 'X-Tracking-Request': 'true' },
        };

        let capturedConfig = null;

        mock.method(apiClient, 'get', async (url, config) => {
          capturedConfig = config;
          return {
            data: {
              success: true,
              data: { metrics: {} },
            },
          };
        });

        await getCampaignAnalytics('camp-xyz', customConfig);

        assert.equal(capturedConfig.signal, controller.signal);
        assert.equal(capturedConfig.headers['X-Tracking-Request'], 'true');
      });

      it('15. Propagates rejected API errors to caller', async () => {
        const mockError = new Error('Forbidden');
        mockError.response = {
          status: 403,
          data: { success: false, message: 'You do not have permission to view this campaign analytics.' },
        };

        mock.method(apiClient, 'get', async () => {
          throw mockError;
        });

        await assert.rejects(
          async () => {
            await getCampaignAnalytics('forbidden-camp-id');
          },
          (err) => {
            assert.equal(err.response?.status, 403);
            assert.equal(getErrorMessage(err), 'You do not have permission to view this campaign analytics.');
            return true;
          }
        );
      });
    });

    describe('Error Propagation', () => {
      it('13. Propagates API errors (e.g. 404, 400) without swallowing them', async () => {
        const mock404Error = new Error('Not Found');
        mock404Error.response = {
          status: 404,
          data: { success: false, message: 'Campaign not found.' },
        };

        mock.method(apiClient, 'get', async () => {
          throw mock404Error;
        });

        await assert.rejects(
          async () => {
            await getCampaignById('nonexistent-id');
          },
          (err) => {
            assert.equal(err.response?.status, 404);
            assert.equal(getErrorMessage(err), 'Campaign not found.');
            return true;
          }
        );
      });
    });
  });

  // ==========================================
  // Part 2: Campaign Validation Helpers Tests
  // ==========================================
  describe('Campaign Validation Helpers', () => {
    describe('validateCampaignName', () => {
      it('11. Accepts valid names between 2 and 120 characters', () => {
        assert.equal(validateCampaignName('AB'), null);
        assert.equal(validateCampaignName('  November Newsletter  '), null);
        assert.equal(validateCampaignName('A'.repeat(120)), null);
      });

      it('12. Rejects missing, empty, or whitespace-only name', () => {
        assert.equal(validateCampaignName(''), 'Campaign name is required.');
        assert.equal(validateCampaignName('   '), 'Campaign name is required.');
        assert.equal(validateCampaignName(null), 'Campaign name is required.');
        assert.equal(validateCampaignName(undefined), 'Campaign name is required.');
      });

      it('13. Rejects name shorter than 2 characters after trimming', () => {
        assert.equal(validateCampaignName('A'), 'Campaign name must be at least 2 characters long.');
        assert.equal(validateCampaignName('  X  '), 'Campaign name must be at least 2 characters long.');
      });

      it('14. Rejects name longer than 120 characters', () => {
        const tooLong = 'A'.repeat(121);
        assert.equal(validateCampaignName(tooLong), 'Campaign name cannot exceed 120 characters.');
      });
    });

    describe('validateCampaignSubject', () => {
      it('15. Accepts valid subjects between 1 and 200 characters', () => {
        assert.equal(validateCampaignSubject('A'), null);
        assert.equal(validateCampaignSubject('  Weekly Digest: Top Stories  '), null);
        assert.equal(validateCampaignSubject('S'.repeat(200)), null);
      });

      it('16. Rejects missing, empty, or whitespace-only subject', () => {
        assert.equal(validateCampaignSubject(''), 'Email subject is required.');
        assert.equal(validateCampaignSubject('   '), 'Email subject is required.');
        assert.equal(validateCampaignSubject(null), 'Email subject is required.');
        assert.equal(validateCampaignSubject(undefined), 'Email subject is required.');
      });

      it('17. Rejects subject longer than 200 characters', () => {
        const tooLong = 'S'.repeat(201);
        assert.equal(validateCampaignSubject(tooLong), 'Email subject cannot exceed 200 characters.');
      });
    });

    describe('validateCampaignContent & Individual Content Validators', () => {
      it('18. Accepts content at exact maximum limits (100k for text, 500k for HTML)', () => {
        const maxText = 'T'.repeat(100000);
        const maxHtml = '<p>' + 'H'.repeat(499993) + '</p>';

        assert.equal(validateCampaignTextContent(maxText), null);
        assert.equal(validateCampaignHtmlContent(maxHtml), null);

        const contentResult = validateCampaignContent({
          textContent: maxText,
          htmlContent: maxHtml,
        });
        assert.equal(contentResult.isValid, true);
        assert.deepEqual(contentResult.errors, {});
      });

      it('19. Rejects content exceeding maximum lengths (100,001 for text, 500,001 for HTML)', () => {
        const overText = 'T'.repeat(100001);
        const overHtml = 'H'.repeat(500001);

        assert.equal(
          validateCampaignTextContent(overText),
          'Plain text content cannot exceed 100,000 characters.'
        );
        assert.equal(
          validateCampaignHtmlContent(overHtml),
          'HTML content cannot exceed 500,000 characters.'
        );

        const contentResult = validateCampaignContent({
          textContent: overText,
          htmlContent: overHtml,
        });
        assert.equal(contentResult.isValid, false);
        assert.equal(
          contentResult.errors.textContent,
          'Plain text content cannot exceed 100,000 characters.'
        );
        assert.equal(
          contentResult.errors.htmlContent,
          'HTML content cannot exceed 500,000 characters.'
        );
      });

      it('20. Explicit empty content strings pass validation for draft flexibility', () => {
        assert.equal(validateCampaignTextContent(''), null);
        assert.equal(validateCampaignHtmlContent(''), null);

        const contentResult = validateCampaignContent({
          textContent: '',
          htmlContent: '',
        });
        assert.equal(contentResult.isValid, true);
        assert.deepEqual(contentResult.errors, {});
      });

      it('21. Rejects non-string content values when provided', () => {
        assert.equal(validateCampaignTextContent(12345), 'Plain text content must be a string.');
        assert.equal(validateCampaignHtmlContent({ html: true }), 'HTML content must be a string.');
      });
    });

    describe('validateCampaignRecipients & deduplicateRecipientIds', () => {
      it('22. Accepts valid 24-hex MongoDB ObjectId strings', () => {
        const validIds = [
          '671234567890abcdef123456',
          '507f1f77bcf86cd799439011',
          '000000000000000000000000',
        ];
        assert.equal(validateCampaignRecipients(validIds), null);
      });

      it('23. Accepts empty recipient array (drafts do not require recipients)', () => {
        assert.equal(validateCampaignRecipients([]), null);
        assert.equal(validateCampaignRecipients(undefined), null);
      });

      it('24. Rejects malformed recipient IDs and non-array values', () => {
        assert.equal(
          validateCampaignRecipients('not-an-array'),
          'Recipients must be an array of contact IDs.'
        );
        assert.equal(
          validateCampaignRecipients(['validId1234567890abcdef', 'too-short']),
          'One or more recipient IDs are invalid.'
        );
        assert.equal(
          validateCampaignRecipients(['671234567890abcdef12345z']), // 'z' is not hex
          'One or more recipient IDs are invalid.'
        );
        assert.equal(
          validateCampaignRecipients([null]),
          'One or more recipient IDs are invalid.'
        );
      });

      it('25. deduplicateRecipientIds removes duplicates while preserving order', () => {
        const input = [
          '671234567890abcdef123451',
          '671234567890abcdef123452',
          '671234567890abcdef123451', // duplicate
          '  671234567890abcdef123453  ',
        ];
        const result = deduplicateRecipientIds(input);
        assert.deepEqual(result, [
          '671234567890abcdef123451',
          '671234567890abcdef123452',
          '671234567890abcdef123453',
        ]);
        assert.deepEqual(deduplicateRecipientIds(null), []);
      });
    });

    describe('validateCampaignForm', () => {
      it('26. Validates a correct campaign creation payload', () => {
        const result = validateCampaignForm({
          name: 'Spring Promotional Blast',
          subject: 'Spring is here! Enjoy 20% off',
          textContent: 'Visit our store today.',
          htmlContent: '<p>Visit our store today.</p>',
          recipientIds: ['671234567890abcdef123456'],
        });

        assert.equal(result.isValid, true);
        assert.deepEqual(result.errors, {});
      });

      it('27. Rejects invalid form inputs on campaign creation', () => {
        const result = validateCampaignForm({
          name: '',
          subject: '   ',
          textContent: 'A'.repeat(100001),
          recipientIds: ['invalid-id'],
        });

        assert.equal(result.isValid, false);
        assert.equal(result.errors.name, 'Campaign name is required.');
        assert.equal(result.errors.subject, 'Email subject is required.');
        assert.equal(result.errors.textContent, 'Plain text content cannot exceed 100,000 characters.');
        assert.equal(result.errors.recipientIds, 'One or more recipient IDs are invalid.');
      });

      it('28. Rejects protected fields when supplied in form data', () => {
        const result = validateCampaignForm({
          name: 'Valid Name',
          subject: 'Valid Subject',
          status: 'sent',
          userId: '671234567890abcdef123456',
          _id: '671234567890abcdef123457',
        });

        assert.equal(result.isValid, false);
        assert.equal(result.errors.status, 'status is a protected field and cannot be set.');
        assert.equal(result.errors.userId, 'userId is a protected field and cannot be set.');
        assert.equal(result.errors._id, '_id is a protected field and cannot be set.');
      });

      it('29. Validates partial updates (isUpdate: true) allowing omitted fields', () => {
        const result = validateCampaignForm(
          { name: 'Updated Campaign Name' },
          { isUpdate: true }
        );

        assert.equal(result.isValid, true);
        assert.deepEqual(result.errors, {});
      });

      it('30. Rejects empty payload for partial update (isUpdate: true)', () => {
        const result = validateCampaignForm({}, { isUpdate: true });

        assert.equal(result.isValid, false);
        assert.equal(result.errors._form, 'At least one field must be provided for update.');
      });
    });
  });
});
