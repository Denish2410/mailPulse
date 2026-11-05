import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import { getContacts, createContact, updateContact, getContactTags } from '../src/api/contacts.js';
import { applyCampaignAudience } from '../src/api/campaigns.js';
import {
  getSegments,
  createSegment,
  previewSegment,
  previewSegmentCriteria,
  deleteSegment,
} from '../src/api/segments.js';
import {
  normalizeTag,
  parseTagInput,
  buildCriteriaFromForm,
  criteriaToForm,
  validateSegmentForm,
  describeCriteria,
  getSegmentErrorMessage,
} from '../src/utils/segmentHelpers.js';

describe('Tag and segment API clients', () => {
  afterEach(() => mock.restoreAll());

  it('passes a normalized tag filter and tags on contact create/update', async () => {
    let getConfig;
    const bodies = [];
    mock.method(apiClient, 'get', async (url, config) => {
      getConfig = { url, config };
      return { data: { data: { contacts: [], tags: [{ tag: 'vip', count: 2 }] } } };
    });
    mock.method(apiClient, 'post', async (url, body) => {
      bodies.push(body);
      return { data: { data: { contact: {} } } };
    });
    mock.method(apiClient, 'patch', async (url, body) => {
      bodies.push(body);
      return { data: { data: { contact: {} } } };
    });

    await getContacts({ tag: '  VIP ' });
    assert.equal(getConfig.config.params.tag, 'vip');
    await getContacts({ tag: '   ' });
    assert.equal(getConfig.config.params.tag, undefined);

    await createContact({ name: 'Ada', email: 'a@b.co', tags: ['vip'] });
    await createContact({ name: 'Ada', email: 'a@b.co' });
    await updateContact('c1', { tags: [] });
    await updateContact('c1', { name: 'New' });
    assert.deepEqual(bodies, [
      { name: 'Ada', email: 'a@b.co', tags: ['vip'] },
      { name: 'Ada', email: 'a@b.co' },
      { tags: [] },
      { name: 'New' },
    ]);

    assert.deepEqual(await getContactTags(), [{ tag: 'vip', count: 2 }]);
    assert.equal(getConfig.url, '/contacts/tags');
  });

  it('calls the segment and audience endpoints', async () => {
    const calls = [];
    for (const verb of ['get', 'post', 'delete']) {
      mock.method(apiClient, verb, async (url, ...rest) => {
        calls.push([verb, url, rest[0]]);
        return { data: { success: true, data: { segment: { id: 's1' }, preview: { total: 3 }, segments: [] } } };
      });
    }
    await getSegments({ page: '2', search: ' vip ' });
    await createSegment({ name: 'VIPs', criteria: { tagsAny: ['vip'] } });
    assert.equal((await previewSegment('s1')).total, 3);
    await previewSegmentCriteria({ tagsAny: ['vip'] });
    await deleteSegment('s1');
    await applyCampaignAudience('c1', { tags: ['vip'], mode: 'add' });
    await applyCampaignAudience('c1', { segmentId: 's1' });

    assert.deepEqual(
      calls.map(([v, u]) => `${v} ${u}`),
      [
        'get /segments',
        'post /segments',
        'get /segments/s1/preview',
        'post /segments/preview',
        'delete /segments/s1',
        'post /campaigns/c1/audience',
        'post /campaigns/c1/audience',
      ]
    );
    assert.deepEqual(calls[3][2], { criteria: { tagsAny: ['vip'] } });
    assert.deepEqual(calls[5][2], { mode: 'add', tags: ['vip'] });
    assert.deepEqual(calls[6][2], { mode: 'replace', segmentId: 's1' });
  });
});

describe('Segment helpers', () => {
  it('normalizes and parses tag input', () => {
    assert.equal(normalizeTag('  VIP '), 'vip');
    assert.equal(normalizeTag('bad!'), null);
    assert.deepEqual(parseTagInput('VIP, lead,\nvip , bad!, , x'), {
      tags: ['vip', 'lead', 'x'],
      invalid: ['bad!'],
    });
    assert.deepEqual(parseTagInput(undefined), { tags: [], invalid: [] });
  });

  it('builds criteria from the form and back', () => {
    const { criteria, invalidTags } = buildCriteriaFromForm({
      tagsAny: 'VIP, Lead',
      tagsAll: '',
      engagementType: 'opened',
      engagementDays: '30',
      createdWithinDays: '',
    });
    assert.deepEqual(criteria, { tagsAny: ['vip', 'lead'], engagement: { type: 'opened', days: 30 } });
    assert.deepEqual(invalidTags, []);
    assert.equal(buildCriteriaFromForm({ engagementType: 'opened', engagementDays: '999' }).criteria.engagement, undefined);
    assert.equal(criteriaToForm(criteria).tagsAny, 'vip, lead');
    assert.equal(criteriaToForm({}).engagementDays, '30');
  });

  it('validates the segment form', () => {
    assert.deepEqual(validateSegmentForm('VIPs', { tagsAny: 'vip' }), {});
    assert.ok(validateSegmentForm('a', { tagsAny: 'vip' }).name);
    assert.match(validateSegmentForm('VIPs', {}).criteria, /at least one rule/);
    assert.match(validateSegmentForm('VIPs', { tagsAny: 'bad!' }).criteria, /Invalid tags/);
  });

  it('describes criteria and maps errors', () => {
    assert.equal(
      describeCriteria({ tagsAny: ['vip'], engagement: { type: 'not_opened', days: 60 }, createdWithinDays: 7 }),
      'has any of: vip · did not open in the last 60 days · added in the last 7 days'
    );
    assert.equal(describeCriteria({}), 'No rules');
    assert.match(getSegmentErrorMessage({ response: { status: 422 } }), /5,000/);
    assert.match(getSegmentErrorMessage({ response: { status: 409, data: {} } }), /already exists/);
    assert.match(getSegmentErrorMessage({}), /Something went wrong/);
  });
});
