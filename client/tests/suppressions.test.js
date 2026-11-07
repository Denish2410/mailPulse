import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import { getSuppressions, createSuppression, deleteSuppression } from '../src/api/suppressions.js';
import {
  SOURCE_FILTER_OPTIONS,
  getSuppressionSourceInfo,
  validateSuppressionForm,
  getSuppressionErrorMessage,
} from '../src/utils/suppressionHelpers.js';

describe('Suppressions client', () => {
  afterEach(() => mock.restoreAll());

  it('lists with sanitized params', async () => {
    let captured;
    mock.method(apiClient, 'get', async (url, config) => {
      captured = { url, config };
      return { data: { data: { suppressions: [], count: 0 } } };
    });
    await getSuppressions({ page: '2', limit: 500, search: ' a@b.co ', source: 'bounce' });
    assert.equal(captured.url, '/suppressions');
    assert.deepEqual(captured.config.params, { page: 2, search: 'a@b.co', source: 'bounce' });
  });

  it('creates and deletes through the right endpoints', async () => {
    const calls = [];
    mock.method(apiClient, 'post', async (url, body) => {
      calls.push(['post', url, body]);
      return { data: { data: { suppression: { id: 's1' } } } };
    });
    mock.method(apiClient, 'delete', async (url) => {
      calls.push(['delete', url]);
      return { data: { success: true } };
    });
    assert.deepEqual(await createSuppression({ email: ' a@b.co ', reason: '  ' }), { id: 's1' });
    await createSuppression({ email: 'a@b.co', reason: ' why ' });
    assert.equal((await deleteSuppression('s1')).success, true);
    assert.deepEqual(calls, [
      ['post', '/suppressions', { email: 'a@b.co' }],
      ['post', '/suppressions', { email: 'a@b.co', reason: 'why' }],
      ['delete', '/suppressions/s1'],
    ]);
  });
});

describe('Suppression helpers', () => {
  it('labels sources', () => {
    assert.equal(getSuppressionSourceInfo('bounce').label, 'Bounced');
    assert.equal(getSuppressionSourceInfo('complaint').label, 'Spam complaint');
    assert.equal(getSuppressionSourceInfo('???').label, 'Unknown');
    assert.equal(SOURCE_FILTER_OPTIONS[0].value, '');
    assert.equal(SOURCE_FILTER_OPTIONS.length, 7);
  });

  it('validates the manual form', () => {
    assert.deepEqual(validateSuppressionForm({ email: 'a@b.co' }), {});
    assert.ok(validateSuppressionForm({ email: '' }).email);
    assert.ok(validateSuppressionForm({ email: 'nope' }).email);
    assert.ok(validateSuppressionForm({ email: 'a@b.co', reason: 'x'.repeat(251) }).reason);
  });

  it('maps errors', () => {
    assert.match(getSuppressionErrorMessage({ response: { status: 409, data: { message: 'Permanent' } } }), /Permanent/);
    assert.match(getSuppressionErrorMessage({ response: { status: 404 } }), /no longer exists/);
    assert.match(getSuppressionErrorMessage({}), /Something went wrong/);
  });
});
