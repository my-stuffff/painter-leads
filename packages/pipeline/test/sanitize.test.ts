import { describe, expect, it } from 'vitest';
import {
  hasUnguardedFormulaPrefix,
  MAX_CELL_CHARS,
  safeHyperlink,
  sanitizeCell,
  unguardCell,
} from '../src/report/sanitize';
import { BOM, csvText } from '../src/report/csv';

describe('sanitizeCell (T-05-01)', () => {
  it.each(['=1+1', '+15125550100', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])('prefixes an apostrophe to %j', (v) => {
    expect(sanitizeCell(v)).toBe(`'${v}`);
  });

  it('leaves ordinary text alone, including a phone in national format and a URL', () => {
    for (const v of ['Acme Painting', '(512) 373-0002', 'https://acme.test', '08817', '4.7', '']) expect(sanitizeCell(v)).toBe(v);
  });

  it('cuts text at the Excel cell limit, guard included', () => {
    expect(sanitizeCell('a'.repeat(MAX_CELL_CHARS + 50))).toHaveLength(MAX_CELL_CHARS);
    expect(sanitizeCell(`=${'a'.repeat(MAX_CELL_CHARS + 50)}`)).toHaveLength(MAX_CELL_CHARS);
  });

  it('unguardCell is the inverse and only strips a guard it would have added', () => {
    expect(unguardCell(sanitizeCell('=1+1'))).toBe('=1+1');
    expect(unguardCell("'quoted text")).toBe("'quoted text");
    expect(hasUnguardedFormulaPrefix('=1')).toBe(true);
    expect(hasUnguardedFormulaPrefix("'=1")).toBe(false);
  });
});

describe('safeHyperlink (T-05-02)', () => {
  it('accepts http and https only', () => {
    expect(safeHyperlink('https://acme.test/a?b=1')).toBe('https://acme.test/a?b=1');
    expect(safeHyperlink('http://acme.test')).toBe('http://acme.test');
    for (const bad of ['javascript:alert(1)', 'file:///c:/x', 'mailto:a@b.c', 'ftp://x.test', 'data:text/html,hi', 'not a url', '', 'https://a.test/with space']) {
      expect(safeHyperlink(bad)).toBeNull();
    }
  });
});

describe('CSV text (REP-02)', () => {
  it('starts with a BOM, quotes every field, ends lines with CRLF, writes blanks as empty fields', () => {
    const text = csvText(['A', 'B', 'C'], [
      ['x', null, 4.5],
      ['say "hi"', '', 0],
    ]);
    expect(text.startsWith(BOM)).toBe(true);
    expect(text.slice(1)).toBe('"A","B","C"\r\n"x","","4.5"\r\n"say ""hi""","","0"\r\n');
    expect(text).not.toMatch(/null|undefined/);
  });

  it('guards formula prefixes in CSV too', () => {
    expect(csvText(['A'], [['=HYPERLINK("http://evil.test")']]).slice(1)).toBe(`"A"\r\n"'=HYPERLINK(""http://evil.test"")"\r\n`);
  });
});
