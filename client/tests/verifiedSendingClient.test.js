import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getSendCampaignErrorMessage } from '../src/utils/campaignHelpers.js';

const err403 = (message) => ({ response: { status: 403, data: { message } } });

describe('Send error message for unverified accounts', () => {
  it('shows the server guidance when the email is not verified', () => {
    const message = 'Verify your email address before you send campaigns. Check your inbox.';
    assert.equal(getSendCampaignErrorMessage(err403(message)), message);
  });

  it('keeps the generic message for other 403 responses', () => {
    assert.equal(
      getSendCampaignErrorMessage(err403('Your account is not permitted to send campaigns.')),
      'Your account is not permitted to send campaigns.'
    );
    assert.equal(getSendCampaignErrorMessage({ response: { status: 403 } }), 'Your account is not permitted to send campaigns.');
  });
});
