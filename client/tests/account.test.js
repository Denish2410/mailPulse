import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import { updateProfile, exportAccountData, deleteAccount } from '../src/api/auth.js';
import {
  validateProfileForm,
  getDeleteAccountErrorMessage,
  getExportFileName,
  MAX_MAILING_ADDRESS_LENGTH,
} from '../src/utils/accountHelpers.js';
import { getSendCampaignErrorMessage } from '../src/utils/campaignHelpers.js';

describe('Account API client', () => {
  afterEach(() => mock.restoreAll());

  it('PATCHes only the provided, trimmed profile fields', async () => {
    let captured;
    mock.method(apiClient, 'patch', async (url, body) => {
      captured = { url, body };
      return { data: { data: { user: { id: '1', mailingAddress: '1 Main St' } } } };
    });
    const user = await updateProfile({ mailingAddress: '  1 Main St  ' });
    assert.equal(captured.url, '/auth/me');
    assert.deepEqual(captured.body, { mailingAddress: '1 Main St' });
    assert.equal(user.mailingAddress, '1 Main St');
  });

  it('downloads the export as raw text', async () => {
    let captured;
    mock.method(apiClient, 'get', async (url, config) => {
      captured = { url, config };
      return { data: '{"account":{}}' };
    });
    assert.equal(await exportAccountData(), '{"account":{}}');
    assert.equal(captured.url, '/auth/me/export');
    assert.equal(captured.config.responseType, 'text');
  });

  it('sends the password in the DELETE body', async () => {
    let captured;
    mock.method(apiClient, 'delete', async (url, config) => {
      captured = { url, config };
      return { data: { success: true } };
    });
    await deleteAccount({ password: 'secret-pass' });
    assert.equal(captured.url, '/auth/me');
    assert.deepEqual(captured.config.data, { password: 'secret-pass' });
  });
});

describe('Account helpers', () => {
  it('validates name and address length', () => {
    assert.equal(validateProfileForm({ name: 'Al', mailingAddress: '1 Main St' }).isValid, true);
    assert.equal(validateProfileForm({ name: 'A' }).errors.name.length > 0, true);
    assert.equal(validateProfileForm({ mailingAddress: 'x'.repeat(MAX_MAILING_ADDRESS_LENGTH + 1) }).isValid, false);
    assert.equal(validateProfileForm({ mailingAddress: '' }).isValid, true); // clearing is allowed
    assert.equal(validateProfileForm({}).isValid, true);
  });

  it('maps delete errors to friendly messages', () => {
    assert.match(getDeleteAccountErrorMessage({ response: { status: 403 } }), /password/);
    assert.equal(
      getDeleteAccountErrorMessage({ response: { status: 409, data: { message: 'Finish sending first.' } } }),
      'Finish sending first.'
    );
    assert.match(getDeleteAccountErrorMessage({ response: { status: 429 } }), /Too many/);
    assert.match(getDeleteAccountErrorMessage(new Error('x')), /Could not delete/);
  });

  it('names the export file by date', () => {
    assert.equal(getExportFileName(new Date('2026-11-09T12:00:00Z')), 'mailpulse-export-2026-11-09.json');
  });

  it('shows the missing-mailing-address guidance on a blocked send', () => {
    const message = 'Add your mailing address in Account settings before you send campaigns.';
    assert.equal(getSendCampaignErrorMessage({ response: { status: 403, data: { message } } }), message);
  });
});
