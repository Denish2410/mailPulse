import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import {
  getSignupForms,
  createSignupForm,
  updateSignupForm,
  deleteSignupForm,
  getPublicForm,
  subscribeToPublicForm,
  confirmSubscription,
} from '../src/api/signupForms.js';
import {
  buildPublicFormUrl,
  buildEmbedSnippet,
  validateSignupFormInput,
  validateSubscribeInput,
  getSubscribeErrorMessage,
} from '../src/utils/signupFormHelpers.js';

describe('Signup forms client', () => {
  afterEach(() => mock.restoreAll());

  it('manages forms through the owner endpoints', async () => {
    const calls = [];
    for (const verb of ['get', 'post', 'patch', 'delete']) {
      mock.method(apiClient, verb, async (url, ...rest) => {
        calls.push([verb, url, rest[0]]);
        return { data: { success: true, data: { forms: [{ id: 'f1' }], form: { id: 'f1' } } } };
      });
    }
    assert.deepEqual(await getSignupForms(), [{ id: 'f1' }]);
    assert.deepEqual(await createSignupForm({ name: 'News' }), { id: 'f1' });
    assert.deepEqual(await updateSignupForm('f1', { enabled: false }), { id: 'f1' });
    assert.equal((await deleteSignupForm('f1')).success, true);
    assert.deepEqual(
      calls.map(([v, u]) => `${v} ${u}`),
      ['get /signup-forms', 'post /signup-forms', 'patch /signup-forms/f1', 'delete /signup-forms/f1']
    );
  });

  it('calls the public endpoints without auth', async () => {
    const calls = [];
    mock.method(apiClient, 'get', async (url, config) => {
      calls.push(['get', url, config]);
      return { data: { data: { form: { name: 'News' } } } };
    });
    mock.method(apiClient, 'post', async (url, body, config) => {
      calls.push(['post', url, body, config]);
      return { data: { success: true, data: { formName: 'News' } } };
    });
    assert.deepEqual(await getPublicForm('abc'), { name: 'News' });
    await subscribeToPublicForm('abc', { email: ' a@b.co ', name: ' Ada ', website: '' });
    await subscribeToPublicForm('abc', { email: 'a@b.co', website: 'bot' });
    assert.deepEqual(await confirmSubscription('t'.repeat(64)), { formName: 'News' });

    assert.equal(calls[0][2].skipAuth, true);
    assert.deepEqual(calls[1][2], { email: 'a@b.co', name: 'Ada' });
    assert.deepEqual(calls[2][2], { email: 'a@b.co', website: 'bot' });
    assert.equal(calls[1][1], '/public/forms/abc/subscribe');
    assert.equal(calls[1][3].skipAuth, true);
    assert.equal(calls[3][1], '/public/subscriptions/confirm');
    assert.equal(calls[3][3].skipAuth, true);
  });
});

describe('Signup form helpers', () => {
  it('builds the public url and embed snippet safely', () => {
    assert.equal(buildPublicFormUrl('https://app.example.com/', 'abc'), 'https://app.example.com/subscribe/abc');
    assert.equal(
      buildEmbedSnippet('https://x.test/subscribe/a"b', 'News <b>'),
      '<a href="https://x.test/subscribe/a&quot;b">News b</a>'
    );
  });

  it('validates the owner editor', () => {
    const ok = validateSignupFormInput({ name: 'Newsletter', description: 'x', tags: 'Blog, News' });
    assert.deepEqual(ok.errors, {});
    assert.deepEqual(ok.tags, ['blog', 'news']);
    assert.ok(validateSignupFormInput({ name: 'a' }).errors.name);
    assert.ok(validateSignupFormInput({ name: 'Valid', description: 'x'.repeat(301) }).errors.description);
    assert.ok(validateSignupFormInput({ name: 'Valid', tags: 'bad!' }).errors.tags);
  });

  it('validates the public form and maps errors', () => {
    assert.deepEqual(validateSubscribeInput({ email: 'a@b.co' }), {});
    assert.ok(validateSubscribeInput({ email: '' }).email);
    assert.ok(validateSubscribeInput({ email: 'nope' }).email);
    assert.ok(validateSubscribeInput({ email: 'a@b.co', name: 'x'.repeat(101) }).name);
    assert.match(getSubscribeErrorMessage({ response: { status: 404 } }), /not available/);
    assert.match(getSubscribeErrorMessage({ response: { status: 429 } }), /Too many/);
    assert.match(getSubscribeErrorMessage({}), /Something went wrong/);
  });
});
