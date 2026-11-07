import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMergeVariables,
  renderMergeTags,
  personalizeMessage,
  findMergeTags,
  escapeHtml,
} from '../src/services/personalization.service.js';

describe('Personalization service', () => {
  const vars = buildMergeVariables({ name: '  Ada   Lovelace King ', email: 'ada@example.com' });

  it('derives name parts', () => {
    assert.deepEqual(vars, {
      name: 'Ada Lovelace King',
      firstName: 'Ada',
      lastName: 'Lovelace King',
      email: 'ada@example.com',
      custom: {},
    });
    assert.deepEqual(buildMergeVariables({}), { name: '', firstName: '', lastName: '', email: '', custom: {} });
    assert.equal(buildMergeVariables({ name: 'Cher' }).lastName, '');
  });

  it('renders tags case-insensitively with flexible whitespace', () => {
    assert.equal(renderMergeTags('Hi {{ FIRSTNAME }} <{{email}}>', vars), 'Hi Ada <ada@example.com>');
    assert.equal(renderMergeTags('{{name}}/{{lastName}}', vars), 'Ada Lovelace King/Lovelace King');
  });

  it('uses fallbacks only when the value is empty', () => {
    const empty = buildMergeVariables({ email: 'x@example.com' });
    assert.equal(renderMergeTags('Hi {{name | "Customer"}}!', empty), 'Hi Customer!');
    assert.equal(renderMergeTags("Hi {{ firstName | 'there' }}!", empty), 'Hi there!');
    assert.equal(renderMergeTags('Hi {{name | "Customer"}}!', vars), 'Hi Ada Lovelace King!');
    assert.equal(renderMergeTags('Hi {{name}}!', empty), 'Hi !');
  });

  it('leaves unknown and unsubscribe tags untouched', () => {
    const t = '{{unsubscribeUrl}} {{unsubscribe}} {{coupon}} {{ name.x }}';
    assert.equal(renderMergeTags(t, vars), t);
  });

  it('escapes values in html mode and strips control characters in subject mode', () => {
    const evil = buildMergeVariables({ name: '<script>alert(1)</script> "Bob"', email: 'b@example.com' });
    const html = renderMergeTags('<p>{{name}}</p>', evil, { mode: 'html' });
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');

    const subj = renderMergeTags('Hello {{name}}', { name: 'A\r\nBcc: x@evil.com' }, { mode: 'subject' });
    assert.ok(!/[\r\n]/.test(subj));
  });

  it('does not re-expand tags contained in values', () => {
    const tricky = buildMergeVariables({ name: '{{email}}', email: 'secret@example.com' });
    assert.equal(renderMergeTags('{{name}}', tricky), '{{email}}');
  });

  it('personalizes subject, text and html together', () => {
    const out = personalizeMessage(
      { subject: 'For {{firstName | "you"}}', text: 'Hi {{name}}', html: '<b>{{email}}</b> {{unsubscribeUrl}}' },
      { name: 'Grace Hopper', email: 'grace@example.com' }
    );
    assert.deepEqual(out, {
      subject: 'For Grace',
      text: 'Hi Grace Hopper',
      html: '<b>grace@example.com</b> {{unsubscribeUrl}}',
    });
  });

  it('handles non-string input safely and finds used tags', () => {
    assert.equal(renderMergeTags(undefined, vars), '');
    assert.equal(renderMergeTags(null, vars), '');
    assert.deepEqual(findMergeTags('{{name}} {{ Email }} {{name|"x"}} {{nope}}').sort(), ['email', 'name']);
    assert.deepEqual(findMergeTags(42), []);
  });

  it('renders custom field tags with fallbacks and escaping', () => {
    const v = buildMergeVariables({ name: 'Ada', email: 'a@b.co', customFields: { Company: 'Acme <b>&</b>', plan: '' } });
    assert.equal(renderMergeTags('{{custom.company}}', v), 'Acme <b>&</b>');
    assert.equal(renderMergeTags('{{custom.company}}', v, { mode: 'html' }), 'Acme &lt;b&gt;&amp;&lt;/b&gt;');
    assert.equal(renderMergeTags('{{ Custom.PLAN | "free" }}', v), 'free');
    assert.equal(renderMergeTags('[{{custom.missing}}]', v), '[]');
    assert.equal(renderMergeTags('{{custom.}} {{custom.9x}}', v), '{{custom.}} {{custom.9x}}');
  });

  it('does not expand tags hidden inside custom values and ignores non-text values', () => {
    const v = buildMergeVariables({ name: 'Ada', email: 'a@b.co', customFields: { note: '{{email}}', n: 5 } });
    assert.equal(renderMergeTags('{{custom.note}}', v), '{{email}}');
    assert.equal(renderMergeTags('{{custom.n | "x"}}', v), 'x');
    assert.deepEqual(buildMergeVariables({ name: 'A B' }).custom, {});
    assert.deepEqual(findMergeTags('{{custom.Company}} {{name}} {{custom.company | "x"}}').sort(), ['custom.company', 'name']);
  });
});
