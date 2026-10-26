import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiClient } from '../src/lib/api.js';
import { sendCampaignTestEmail } from '../src/api/campaigns.js';
import {
  getTestEmailAvailability,
  formatTestEmailSuccess,
  getTestEmailErrorMessage,
} from '../src/utils/campaignHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const previewSource = fs.readFileSync(
  path.resolve(__dirname, '../src/components/campaigns/CampaignPreviewDialog.jsx'),
  'utf-8'
);

const CAMPAIGN_ID = '671234567890abcdef123456';

const draftCampaign = (overrides = {}) => ({
  id: CAMPAIGN_ID,
  name: 'October Newsletter',
  subject: 'Big news',
  textContent: 'Hello',
  htmlContent: '<p>Hello</p>',
  status: 'draft',
  recipientIds: [],
  ...overrides,
});

const httpError = (status, data = {}) => {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
};

describe('Campaign Test Email (Phase 4.4 Step 4)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('sendCampaignTestEmail API client', () => {
    it('1. POSTs to /campaigns/:id/test-email with an empty body and returns response data', async () => {
      const responseData = {
        destination: 'me@example.com',
        subject: '[TEST] Big news',
        messageId: '<abc@mailpulse.local>',
        sentAt: '2026-10-26T00:00:00.000Z',
      };
      let captured = null;
      mock.method(apiClient, 'post', async (url, body, config) => {
        captured = { url, body, config };
        return { data: { success: true, message: 'Test email dispatched', data: responseData } };
      });

      const result = await sendCampaignTestEmail(CAMPAIGN_ID);

      assert.equal(captured.url, `/campaigns/${CAMPAIGN_ID}/test-email`);
      // No destination, recipients, cc, or bcc are ever sent from the client
      assert.deepEqual(captured.body, {});
      assert.deepEqual(result, responseData);
    });

    it('2. Forwards request config such as an AbortSignal', async () => {
      const controller = new AbortController();
      let capturedConfig = null;
      mock.method(apiClient, 'post', async (url, body, config) => {
        capturedConfig = config;
        return { data: { data: {} } };
      });

      await sendCampaignTestEmail(CAMPAIGN_ID, { signal: controller.signal });
      assert.equal(capturedConfig.signal, controller.signal);
    });

    it('3. Propagates errors to the caller', async () => {
      mock.method(apiClient, 'post', async () => {
        throw httpError(503, { success: false, message: 'Email sending is not configured.' });
      });

      await assert.rejects(() => sendCampaignTestEmail(CAMPAIGN_ID), (err) => {
        assert.equal(err.response.status, 503);
        return true;
      });
    });
  });

  describe('getTestEmailAvailability', () => {
    it('4. Allows a draft with subject and content, even with zero recipients', () => {
      assert.deepEqual(getTestEmailAvailability(draftCampaign({ recipientIds: [] })), {
        canSend: true,
        reason: '',
      });
    });

    it('5. Allows text-only and HTML-only drafts', () => {
      assert.equal(getTestEmailAvailability(draftCampaign({ htmlContent: '' })).canSend, true);
      assert.equal(getTestEmailAvailability(draftCampaign({ textContent: '' })).canSend, true);
    });

    it('6. Blocks when a request is already in flight (duplicate submission guard)', () => {
      const result = getTestEmailAvailability(draftCampaign(), { isSending: true });
      assert.equal(result.canSend, false);
      assert.match(result.reason, /already being sent/);
    });

    it('7. Blocks campaigns with no non-whitespace content', () => {
      const result = getTestEmailAvailability(
        draftCampaign({ textContent: '   ', htmlContent: '\n\t' })
      );
      assert.equal(result.canSend, false);
      assert.match(result.reason, /content/);
    });

    it('8. Blocks missing subjects and non-draft campaigns', () => {
      assert.equal(getTestEmailAvailability(draftCampaign({ subject: '  ' })).canSend, false);
      assert.equal(getTestEmailAvailability(draftCampaign({ status: 'sent' })).canSend, false);
    });

    it('9. Handles null, undefined, and malformed campaigns without throwing', () => {
      for (const value of [null, undefined, 'x', 42, {}, { name: 'no id' }]) {
        assert.equal(getTestEmailAvailability(value).canSend, false);
      }
    });
  });

  describe('formatTestEmailSuccess', () => {
    it('10. Names the destination returned by the server', () => {
      const message = formatTestEmailSuccess({ destination: 'me@example.com' });
      assert.match(message, /^Test email sent to me@example\.com\./);
      assert.match(message, /spam folder/);
    });

    it('11. Falls back safely when the destination is missing', () => {
      assert.match(formatTestEmailSuccess(null), /your account email/);
      assert.match(formatTestEmailSuccess({ destination: '' }), /your account email/);
    });
  });

  describe('getTestEmailErrorMessage', () => {
    it('12. Maps rate limiting (429) to a wait-and-retry message', () => {
      assert.match(getTestEmailErrorMessage(httpError(429)), /wait a few minutes/);
    });

    it('13. Maps 503 to a configuration message and 502 to a provider message', () => {
      assert.match(getTestEmailErrorMessage(httpError(503)), /not configured/);
      assert.match(getTestEmailErrorMessage(httpError(502)), /email provider/);
    });

    it('14. Lists server-provided issues for 422 responses', () => {
      const message = getTestEmailErrorMessage(
        httpError(422, {
          errors: [
            { path: 'campaign.content', message: 'Campaign must have non-empty text content or HTML content.' },
            { path: 'x', message: '   ' },
            null,
          ],
        })
      );
      assert.match(message, /can't be sent as a test yet: Campaign must have non-empty text content/);
    });

    it('15. Maps 401, 403, and 404 to clear guidance', () => {
      assert.match(getTestEmailErrorMessage(httpError(401)), /sign in again/);
      assert.match(getTestEmailErrorMessage(httpError(403)), /not permitted/);
      assert.match(getTestEmailErrorMessage(httpError(404)), /no longer exists/);
    });

    it('16. Uses the server message for other 4xx errors', () => {
      assert.equal(
        getTestEmailErrorMessage(httpError(400, { message: 'Validation failed' })),
        'Validation failed'
      );
    });

    it('17. Never surfaces raw 5xx server text', () => {
      const message = getTestEmailErrorMessage(
        httpError(500, { message: 'secret stack smtp.internal pass=hunter2' })
      );
      assert.equal(message, 'Failed to send the test email. Please try again.');
    });

    it('18. Handles network errors, timeouts, and unexpected values', () => {
      assert.match(getTestEmailErrorMessage({ code: 'ERR_NETWORK', message: 'Network Error' }), /reach the server/);
      assert.match(getTestEmailErrorMessage({ code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' }), /timed out/);
      assert.equal(getTestEmailErrorMessage(undefined), 'Failed to send the test email. Please try again.');
    });
  });

  describe('CampaignPreviewDialog wiring', () => {
    it('19. Renders an accessible "Send test email" button wired to the handler and availability', () => {
      assert.match(previewSource, /onClick=\{handleTestEmailClick\}/);
      assert.match(previewSource, /disabled=\{!testEmailAvailability\.canSend\}/);
      assert.match(previewSource, /aria-busy=\{isSendingTestEmail\}/);
      assert.match(previewSource, /aria-label="Send a test email of this campaign to your own account email"/);
      assert.match(previewSource, /'Send test email'/);
    });

    it('20. Announces results through a polite live region with status and alert roles', () => {
      assert.match(previewSource, /aria-live="polite"/);
      assert.match(previewSource, /testEmail\.status === 'success'[\s\S]*?role="status"/);
      assert.match(previewSource, /testEmail\.status === 'error'[\s\S]*?role="alert"/);
    });

    it('21. Ignores stale results after the dialog closes or switches campaigns', () => {
      assert.match(previewSource, /currentRequestId !== testEmailRequestIdRef\.current/);
      assert.match(previewSource, /testEmailRequestIdRef\.current \+= 1;[\s\S]*?\}, \[isOpen, campaign\?\.id\]\);/);
    });

    it('22. Never injects HTML into the DOM (security invariant preserved)', () => {
      assert.doesNotMatch(previewSource, /dangerouslySetInnerHTML/);
    });
  });
});
