/**
 * The campaigns API client must carry the chosen Gmail account to the server. It once whitelisted
 * fields and silently dropped senderAccountId, so the sender picked in the form was never saved.
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import { createCampaign, updateCampaign } from '../src/api/campaigns.js';

const SENDER = '6b009e736dce57bff80e627d';
const reply = { data: { data: { campaign: { id: 'c1' } } } };

describe('Campaign API client and the sender account', () => {
  afterEach(() => mock.restoreAll());

  it('createCampaign sends the chosen senderAccountId', async () => {
    const post = mock.method(apiClient, 'post', async () => reply);
    await createCampaign({ name: 'N', subject: 'S', senderAccountId: SENDER });
    assert.equal(post.mock.calls[0].arguments[1].senderAccountId, SENDER);
  });

  it('createCampaign sends an explicit null (no sender yet) and omits the field when undefined', async () => {
    const post = mock.method(apiClient, 'post', async () => reply);
    await createCampaign({ name: 'N', subject: 'S', senderAccountId: null });
    assert.equal(post.mock.calls[0].arguments[1].senderAccountId, null);
    await createCampaign({ name: 'N', subject: 'S' });
    assert.equal('senderAccountId' in post.mock.calls[1].arguments[1], false);
  });

  it('updateCampaign sends a changed sender, sends null to clear it and leaves it alone when omitted', async () => {
    const patch = mock.method(apiClient, 'patch', async () => reply);
    await updateCampaign('c1', { senderAccountId: SENDER });
    assert.equal(patch.mock.calls[0].arguments[1].senderAccountId, SENDER);
    await updateCampaign('c1', { senderAccountId: null });
    assert.equal(patch.mock.calls[1].arguments[1].senderAccountId, null);
    await updateCampaign('c1', { name: 'Only a rename' });
    assert.equal('senderAccountId' in patch.mock.calls[2].arguments[1], false, 'a rename must not touch the sender');
  });
});
