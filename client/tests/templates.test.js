import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from '../src/api/templates.js';
import {
  formatMergeTag,
  insertAtSelection,
  validateTemplateForm,
  templateToCampaignFields,
  getTemplateErrorMessage,
  MERGE_TAG_OPTIONS,
} from '../src/utils/templateHelpers.js';

describe('Templates API client', () => {
  afterEach(() => mock.restoreAll());

  it('lists templates with sanitized query params', async () => {
    let captured;
    mock.method(apiClient, 'get', async (url, config) => {
      captured = { url, config };
      return { data: { data: { templates: [], count: 0 } } };
    });
    const result = await getTemplates({ page: '2', limit: 500, search: '  welcome ' });
    assert.equal(captured.url, '/templates');
    assert.deepEqual(captured.config.params, { page: 2, search: 'welcome' });
    assert.equal(result.count, 0);
  });

  it('gets, creates, updates and deletes via the right endpoints', async () => {
    const template = { id: 't1', name: 'Welcome' };
    const calls = [];
    for (const verb of ['get', 'post', 'patch', 'delete']) {
      mock.method(apiClient, verb, async (url, ...rest) => {
        calls.push([verb, url, rest[0]]);
        return { data: { success: true, data: { template } } };
      });
    }
    assert.deepEqual(await getTemplateById('t1'), template);
    assert.deepEqual(await createTemplate({ name: 'Welcome' }), template);
    assert.deepEqual(await updateTemplate('t1', { subject: 'x' }), template);
    assert.equal((await deleteTemplate('t1')).success, true);
    assert.deepEqual(
      calls.map(([v, u]) => `${v} ${u}`),
      ['get /templates/t1', 'post /templates', 'patch /templates/t1', 'delete /templates/t1']
    );
    assert.deepEqual(calls[1][2], { name: 'Welcome' });
  });
});

describe('Template helpers', () => {
  it('formats merge tags with optional sanitized fallback', () => {
    assert.equal(formatMergeTag('name'), '{{name}}');
    assert.equal(formatMergeTag('firstName', 'there'), '{{firstName | "there"}}');
    assert.equal(formatMergeTag('name', ' a"}}b '), '{{name | "ab"}}');
    assert.ok(MERGE_TAG_OPTIONS.some((o) => o.tag === 'email'));
  });

  it('inserts at selection with clamping', () => {
    assert.deepEqual(insertAtSelection('Hello ', '{{name}}'), { value: 'Hello {{name}}', cursor: 14 });
    assert.deepEqual(insertAtSelection('abcd', 'X', 1, 3), { value: 'aXd', cursor: 2 });
    assert.deepEqual(insertAtSelection('abc', 'X', -5, 99), { value: 'X', cursor: 1 });
    assert.deepEqual(insertAtSelection(undefined, 'X', 2, 3), { value: 'X', cursor: 1 });
  });

  it('validates the template form', () => {
    assert.deepEqual(validateTemplateForm({ name: 'Welcome' }), {});
    assert.ok(validateTemplateForm({ name: 'a' }).name);
    assert.ok(validateTemplateForm({ name: 'x'.repeat(121) }).name);
    assert.ok(validateTemplateForm({ name: 'ok', subject: 'x'.repeat(201) }).subject);
  });

  it('maps templates to campaign fields and error messages', () => {
    assert.deepEqual(templateToCampaignFields({ subject: 'S', textContent: 'T', htmlContent: '<p/>', name: 'N' }), {
      subject: 'S',
      textContent: 'T',
      htmlContent: '<p/>',
    });
    assert.deepEqual(templateToCampaignFields(null), { subject: '', textContent: '', htmlContent: '' });
    assert.match(getTemplateErrorMessage({ response: { status: 409, data: {} } }), /already exists/);
    assert.match(getTemplateErrorMessage({ response: { status: 404 } }), /no longer exists/);
    assert.match(getTemplateErrorMessage({}), /Something went wrong/);
  });
});
