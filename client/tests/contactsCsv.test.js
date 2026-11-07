import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import { importContacts, exportContacts } from '../src/api/contacts.js';
import {
  MAX_CSV_BYTES,
  CSV_TEMPLATE,
  validateCsvFile,
  formatImportSummary,
  getImportErrorMessage,
  downloadTextFile,
} from '../src/utils/csvHelpers.js';

describe('Contacts CSV client', () => {
  afterEach(() => mock.restoreAll());

  it('posts CSV text to /contacts/import and returns the result', async () => {
    let captured;
    mock.method(apiClient, 'post', async (url, body) => {
      captured = { url, body };
      return { data: { data: { created: 2, skipped: 0, invalid: 0, total: 2, errors: [] } } };
    });
    const result = await importContacts('email\na@b.co');
    assert.equal(captured.url, '/contacts/import');
    assert.deepEqual(captured.body, { csv: 'email\na@b.co' });
    assert.equal(result.created, 2);
  });

  it('requests the export as raw text with a normalized tag', async () => {
    let captured;
    mock.method(apiClient, 'get', async (url, config) => {
      captured = { url, config };
      return { data: 'name,email\r\n' };
    });
    assert.equal(await exportContacts({ tag: '  VIP ' }), 'name,email\r\n');
    assert.equal(captured.url, '/contacts/export');
    assert.deepEqual(captured.config.params, { tag: 'vip' });
    assert.equal(captured.config.responseType, 'text');
    assert.equal(captured.config.transformResponse('raw'), 'raw');

    await exportContacts();
    assert.deepEqual(captured.config.params, {});
  });
});

describe('CSV helpers', () => {
  it('validates the selected file', () => {
    assert.match(validateCsvFile(null), /Choose a CSV/);
    assert.match(validateCsvFile({ name: 'a.xlsx', size: 10 }), /\.csv/);
    assert.match(validateCsvFile({ name: 'a.csv', size: 0 }), /empty/);
    assert.match(validateCsvFile({ name: 'a.csv', size: MAX_CSV_BYTES + 1 }), /too large/);
    assert.equal(validateCsvFile({ name: 'Contacts.CSV', size: 100 }), null);
    assert.equal(validateCsvFile({ name: 'a.txt', size: 100 }), null);
  });

  it('summarizes results and maps errors', () => {
    assert.equal(formatImportSummary({ created: 3 }), '3 imported');
    assert.equal(
      formatImportSummary({ created: 3, skipped: 2, invalid: 1 }),
      '3 imported, 2 skipped (already exist), 1 invalid'
    );
    assert.equal(formatImportSummary(null), '0 imported');
    assert.equal(getImportErrorMessage({ response: { status: 400, data: { message: 'bad header' } } }), 'bad header');
    assert.match(getImportErrorMessage({ response: { status: 401 } }), /expired/);
    assert.match(getImportErrorMessage({ response: { status: 413 } }), /too large/);
    assert.match(getImportErrorMessage({}), /Import failed/);
  });

  it('ships a valid template and degrades outside the browser', () => {
    assert.ok(CSV_TEMPLATE.startsWith('name,email,tags'));
    assert.equal(downloadTextFile('x.csv', 'a'), false);
  });
});
