import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv, escapeCsvCell, CsvError } from '../src/utils/csv.js';

describe('CSV parsing', () => {
  it('parses simple rows with LF, CRLF and CR newlines', () => {
    const expected = [['a', 'b'], ['1', '2']];
    assert.deepEqual(parseCsv('a,b\n1,2'), expected);
    assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), expected);
    assert.deepEqual(parseCsv('a,b\r1,2\r'), expected);
  });

  it('handles quotes, escaped quotes, commas and embedded newlines', () => {
    assert.deepEqual(parseCsv('name,note\n"Doe, Jane","said ""hi"""\n"multi\nline",x'), [
      ['name', 'note'],
      ['Doe, Jane', 'said "hi"'],
      ['multi\nline', 'x'],
    ]);
  });

  it('strips a BOM, skips blank lines and keeps empty fields', () => {
    assert.deepEqual(parseCsv('﻿a,b\n\n,\n1,\n'), [['a', 'b'], ['', ''], ['1', '']]);
    assert.deepEqual(parseCsv(''), []);
  });

  it('treats a quote in the middle of a field literally', () => {
    assert.deepEqual(parseCsv('5" pipe,x'), [['5" pipe', 'x']]);
  });

  it('rejects unterminated quotes, non-strings and oversized files', () => {
    assert.throws(() => parseCsv('a,"b'), CsvError);
    assert.throws(() => parseCsv(42), CsvError);
    assert.throws(() => parseCsv('h\n1\n2\n3', { maxRows: 2 }), CsvError);
    assert.doesNotThrow(() => parseCsv('h\n1\n2', { maxRows: 2 }));
  });
});

describe('CSV generation', () => {
  it('quotes special characters', () => {
    assert.equal(escapeCsvCell('plain'), 'plain');
    assert.equal(escapeCsvCell('a,b'), '"a,b"');
    assert.equal(escapeCsvCell('say "x"'), '"say ""x"""');
    assert.equal(escapeCsvCell('l1\nl2'), '"l1\nl2"');
    assert.equal(escapeCsvCell(null), '');
    assert.equal(escapeCsvCell(5), '5');
  });

  it('neutralizes spreadsheet formula injection', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx']) {
      assert.ok(escapeCsvCell(evil).startsWith("'") || escapeCsvCell(evil).startsWith('"\''), evil);
    }
    assert.equal(escapeCsvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it('round-trips through parseCsv', () => {
    const rows = [['Doe, Jane', 'a@b.co', 'vip;lead'], ['Quote "Q"', 'c@d.co', '']];
    assert.deepEqual(parseCsv(toCsv(['name', 'email', 'tags'], rows)), [['name', 'email', 'tags'], ...rows]);
    assert.ok(toCsv(['a'], []).endsWith('\r\n'));
  });
});
