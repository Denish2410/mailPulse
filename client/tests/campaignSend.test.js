import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiClient } from '../src/lib/api.js';
import { sendCampaign, getCampaignDeliveries } from '../src/api/campaigns.js';
import {
  getCampaignStatusBadge,
  isCampaignEditable,
  getCampaignSendAvailability,
  formatSendConfirmation,
  getSendCampaignErrorMessage,
  formatDeliverySummary,
  describeDeliveryError,
} from '../src/utils/campaignHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative) =>
  fs.readFileSync(path.resolve(__dirname, relative), 'utf-8');

const previewSource = readSource('../src/components/campaigns/CampaignPreviewDialog.jsx');
const panelSource = readSource('../src/components/campaigns/DeliveryStatusPanel.jsx');
const tableSource = readSource('../src/components/campaigns/CampaignsTable.jsx');

const CAMPAIGN_ID = '671234567890abcdef123456';

const draftCampaign = (overrides = {}) => ({
  id: CAMPAIGN_ID,
  name: 'Launch',
  subject: 'Big news',
  textContent: 'Hello',
  htmlContent: '<p>Hello</p>',
  status: 'draft',
  recipientIds: ['a', 'b'],
  ...overrides,
});

const readyReadiness = (count = 2) => ({
  isReady: true,
  issues: [],
  summary: { eligibleRecipientsCount: count },
});

const httpError = (status, data = {}) => {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
};

describe('Campaign Sending (Phase 5)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('sendCampaign API client', () => {
    it('1. POSTs { confirm: true } to /campaigns/:id/send and returns response data', async () => {
      const responseData = { campaign: { id: CAMPAIGN_ID, status: 'sending' }, queuedRecipients: 2 };
      let captured = null;
      mock.method(apiClient, 'post', async (url, body, config) => {
        captured = { url, body, config };
        return { data: { success: true, data: responseData } };
      });

      const result = await sendCampaign(CAMPAIGN_ID);

      assert.equal(captured.url, `/campaigns/${CAMPAIGN_ID}/send`);
      // Never sends recipients, addresses, or content from the client
      assert.deepEqual(captured.body, { confirm: true });
      assert.deepEqual(result, responseData);
    });

    it('2. Propagates errors to the caller', async () => {
      mock.method(apiClient, 'post', async () => {
        throw httpError(409, { success: false });
      });
      await assert.rejects(() => sendCampaign(CAMPAIGN_ID), /409/);
    });
  });

  describe('getCampaignDeliveries API client', () => {
    it('3. GETs the delivery log with sanitized query params', async () => {
      let captured = null;
      mock.method(apiClient, 'get', async (url, config) => {
        captured = { url, config };
        return { data: { data: { campaignStatus: 'sent', deliveries: [] } } };
      });

      const result = await getCampaignDeliveries(CAMPAIGN_ID, {
        page: '2',
        limit: 500,
        status: ' failed ',
      });

      assert.equal(captured.url, `/campaigns/${CAMPAIGN_ID}/deliveries`);
      assert.deepEqual(captured.config.params, { page: 2, status: 'failed' });
      assert.equal(result.campaignStatus, 'sent');
    });

    it('4. Drops unknown status filters and forwards request config', async () => {
      const controller = new AbortController();
      let captured = null;
      mock.method(apiClient, 'get', async (url, config) => {
        captured = config;
        return { data: { data: {} } };
      });

      await getCampaignDeliveries(CAMPAIGN_ID, { status: 'bounced', limit: 50 }, { signal: controller.signal });
      assert.deepEqual(captured.params, { limit: 50 });
      assert.equal(captured.signal, controller.signal);
    });
  });

  describe('Helpers', () => {
    it('5. Maps the failed status to a badge', () => {
      assert.equal(getCampaignStatusBadge('failed').label, 'Failed');
      assert.ok(getCampaignStatusBadge('failed').pillClass.includes('rose'));
    });

    it('6. Only drafts are editable', () => {
      assert.equal(isCampaignEditable(draftCampaign()), true);
      for (const status of ['sending', 'sent', 'failed']) {
        assert.equal(isCampaignEditable(draftCampaign({ status })), false);
      }
      assert.equal(isCampaignEditable(null), false);
    });

    it('7. Send is available only for ready drafts with recipients', () => {
      assert.deepEqual(getCampaignSendAvailability(draftCampaign(), readyReadiness(3)), {
        canSend: true,
        reason: '',
        recipientCount: 3,
      });

      assert.equal(getCampaignSendAvailability(draftCampaign({ status: 'sent' }), readyReadiness()).canSend, false);
      assert.equal(getCampaignSendAvailability(draftCampaign(), readyReadiness(), { isSending: true }).canSend, false);
      assert.equal(getCampaignSendAvailability(draftCampaign(), null).canSend, false);
      assert.equal(
        getCampaignSendAvailability(draftCampaign(), readyReadiness(), { isLoadingReadiness: true }).canSend,
        false
      );
      assert.equal(
        getCampaignSendAvailability(draftCampaign(), { isReady: false, summary: { eligibleRecipientsCount: 2 } }).canSend,
        false
      );
      assert.equal(getCampaignSendAvailability(draftCampaign(), readyReadiness(0)).canSend, false);
      assert.equal(getCampaignSendAvailability(undefined, readyReadiness()).canSend, false);
    });

    it('8. Confirmation text states the recipient count and that it cannot be undone', () => {
      assert.match(formatSendConfirmation(1), /1 recipient\?/);
      assert.match(formatSendConfirmation(5), /5 recipients\?/);
      assert.match(formatSendConfirmation(5), /can't be undone/);
    });

    it('9. Maps send errors to clear messages', () => {
      assert.match(getSendCampaignErrorMessage(httpError(409)), /already been sent/);
      assert.match(getSendCampaignErrorMessage(httpError(503)), /not configured/);
      assert.match(getSendCampaignErrorMessage(httpError(429)), /wait/);
      assert.match(
        getSendCampaignErrorMessage(
          httpError(422, { errors: [{ message: 'Campaign must have at least one eligible recipient.' }] })
        ),
        /at least one eligible recipient/
      );
      assert.match(getSendCampaignErrorMessage({ code: 'ERR_NETWORK', message: 'Network Error' }), /reach the server/);
      assert.equal(getSendCampaignErrorMessage(undefined), 'Failed to send the campaign. Please try again.');
    });

    it('10. Normalizes delivery summaries and computes progress', () => {
      assert.deepEqual(formatDeliverySummary({ total: 4, pending: 1, processing: 0, sent: 2, failed: 1 }), {
        total: 4,
        pending: 1,
        processing: 0,
        sent: 2,
        failed: 1,
        processed: 3,
        percent: 75,
        isComplete: false,
      });
      const done = formatDeliverySummary({ total: 2, sent: 2 });
      assert.equal(done.isComplete, true);
      assert.equal(done.percent, 100);
      const empty = formatDeliverySummary(null);
      assert.equal(empty.total, 0);
      assert.equal(empty.percent, 0);
      assert.equal(formatDeliverySummary({ total: -3, sent: 'x' }).total, 0);
    });

    it('11. Describes stored delivery error codes', () => {
      assert.match(describeDeliveryError('TRANSPORT_ERROR'), /provider/);
      assert.match(describeDeliveryError('INTERRUPTED'), /restart/);
      assert.match(describeDeliveryError('PERSIST_ERROR'), /not recorded/);
      assert.notEqual(describeDeliveryError('PERSIST_ERROR'), 'Unknown error');
      assert.equal(describeDeliveryError(null), '');
      assert.equal(describeDeliveryError('SOMETHING'), 'Unknown error');
    });
  });

  describe('Component wiring', () => {
    it('12. Preview dialog requires confirmation and blocks duplicate sends', () => {
      assert.match(previewSource, /disabled=\{!sendAvailability\.canSend \|\| sendState\.status === 'confirming'\}/);
      assert.match(previewSource, /if \(sendState\.status === 'sending'\) return;/);
      assert.match(previewSource, /currentRequestId !== sendRequestIdRef\.current/);
      assert.match(previewSource, /role="alertdialog"/);
    });

    it('13. Preview dialog shows delivery progress once a campaign is no longer a draft', () => {
      assert.match(previewSource, /!isDraft \? \(\s*<DeliveryStatusPanel/);
    });

    it('14. Delivery panel polls only while sending and cleans up timers and requests', () => {
      assert.match(panelSource, /if \(status === 'sending'\) \{\s*timer = setTimeout\(load, DELIVERY_POLL_INTERVAL_MS\);/);
      assert.match(panelSource, /clearTimeout\(timer\)/);
      assert.match(panelSource, /controller\?\.abort\(\)/);
      assert.doesNotMatch(panelSource, /dangerouslySetInnerHTML/);
    });

    it('15. Campaigns table hides edit and delete for sent campaigns', () => {
      assert.match(tableSource, /isCampaignEditable\(campaign\) && \(/);
    });
  });
});
