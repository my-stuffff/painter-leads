import { describe, expect, it } from 'vitest';
import { makeSnippet } from '../src/evidence/snippet';
import { MemoryEvidenceStore } from '../src/evidence/store';

describe('makeSnippet', () => {
  it('keeps short text whole and collapses whitespace', () => {
    expect(makeSnippet('Meet   John\n Smith, owner', 5, 10)).toBe('Meet John Smith, owner');
  });

  it('trims to at most 300 characters and keeps the match', () => {
    const text = `${'a '.repeat(400)}Meet John Smith, owner of Acme${' b'.repeat(400)}`;
    const idx = text.indexOf('John Smith');
    const s = makeSnippet(text, idx, 'John Smith'.length);
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).toContain('John Smith');
  });

  it('keeps a match at the very start or end', () => {
    const text = `Owner Jane Doe ${'x '.repeat(500)}`;
    expect(makeSnippet(text, 6, 8)).toContain('Jane Doe');
    const end = `${'x '.repeat(500)}Owner Jane Doe`;
    expect(makeSnippet(end, end.length - 8, 8)).toContain('Jane Doe');
  });
});

describe('MemoryEvidenceStore', () => {
  const base = {
    field: 'email' as const,
    value: 'Info@Acme.com',
    sourceType: 'website' as const,
    sourceUrl: 'https://acme.test/contact',
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    snippet: 'Email us: Info@Acme.com',
    extractor: 't',
    extractorVersion: '1',
    confidence: 'medium' as const,
  };

  it('refuses a row without provenance, like the database does', async () => {
    const s = new MemoryEvidenceStore();
    await expect(s.record({ ...base, companyId: 1, snippet: '' })).rejects.toThrow();
    await expect(s.record({ ...base })).rejects.toThrow();
  });

  it('normalises, links listing evidence to a company and supports reject', async () => {
    const s = new MemoryEvidenceStore();
    const id = await s.record({ ...base, listingId: 7 });
    await s.setCompany(7, 3);
    const rows = await s.listForCompany(3, 'email');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, valueNorm: 'info@acme.com', status: 'accepted' });
    await s.reject(id, 'placeholder');
    expect((await s.listForCompany(3))[0]).toMatchObject({ status: 'rejected', rejectReason: 'placeholder' });
  });
});
