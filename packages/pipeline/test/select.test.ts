import { describe, expect, it } from 'vitest';
import { loadConfig, type EvidenceRow, type Field, type SourceType } from '@pp/core';
import { PIPELINE_POLICY, policyFor, rowsBehind, selectEmail, selectField, selectLatest, selectPhone } from '../src/select/policy';

let id = 1;
const row = (field: Field, value: string, over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id: id++,
  companyId: 1,
  listingId: null,
  registryRecordId: null,
  field,
  value,
  valueNorm: value.toLowerCase(),
  sourceType: 'website' as SourceType,
  sourceUrl: `https://example.test/${id}`,
  pageSha256: null,
  capturedAt: new Date('2026-10-25T10:00:00Z'),
  snippet: value,
  extractor: 't',
  extractorVersion: '1',
  confidence: 'medium',
  status: 'accepted',
  corroboratedBy: [],
  attrs: {},
  ...over,
});

const policy = policyFor(loadConfig());

describe('pipeline selection policy (D-18, D-22, D-23)', () => {
  it('minConfidence comes from config.report', () => {
    expect(PIPELINE_POLICY.minConfidence).toBe('medium');
    const lax = { ...loadConfig(), report: { ...loadConfig().report, minConfidence: 'low' as const } };
    expect(policyFor(lax).minConfidence).toBe('low');
  });

  it('phone: the Google listing phone wins even when a registry phone has higher confidence', () => {
    const google = row('phone', '+17325550100', { sourceType: 'google_maps', confidence: 'medium' });
    const cslb = row('phone', '+17325559999', { sourceType: 'cslb_master', confidence: 'high' });
    expect(selectPhone([cslb, google], policy)?.value).toBe('+17325550100');
  });

  it('phone: with no Google phone nothing is shown (other phones stay evidence only)', () => {
    expect(selectPhone([row('phone', '+17325559999', { sourceType: 'cslb_master', confidence: 'high' })], policy)).toBeNull();
  });

  it('a low-confidence owner is not selected', () => {
    expect(selectField([row('owner_name', 'John Smith', { confidence: 'low' })], 'owner_name', policy)).toBeNull();
    expect(selectField([row('owner_name', 'John Smith', { confidence: 'medium' })], 'owner_name', policy)?.value).toBe('John Smith');
  });

  it('a rejected row (conflicts with registry) is never selected, and neither is needs_review', () => {
    const rejected = row('owner_name', 'Brennan Price', { status: 'rejected', rejectReason: 'conflicts with registry', confidence: 'high' });
    const review = row('owner_name', 'Maybe Person', { status: 'needs_review', confidence: 'high' });
    const registry = row('owner_name', 'Donal Lopez', { sourceType: 'cslb_master', confidence: 'high' });
    expect(selectField([rejected, review], 'owner_name', policy)).toBeNull();
    expect(selectField([rejected, review, registry], 'owner_name', policy)?.value).toBe('Donal Lopez');
  });

  it('owner: registry families before BBB before the website at equal confidence', () => {
    const website = row('owner_name', 'Web Person', { sourceType: 'website', confidence: 'high' });
    const bbb = row('owner_name', 'Bbb Person', { sourceType: 'bbb', confidence: 'high' });
    const registry = row('owner_name', 'Reg Person', { sourceType: 'nj_principal_search', confidence: 'high' });
    expect(selectField([website, bbb, registry], 'owner_name', policy)?.value).toBe('Reg Person');
    expect(selectField([website, bbb], 'owner_name', policy)?.value).toBe('Bbb Person');
  });

  it('email: personal before role before other, then confidence', () => {
    const other = row('email', 'x@a.com', { attrs: { kind: 'other' }, confidence: 'high' });
    const role = row('email', 'info@a.com', { attrs: { kind: 'role' }, confidence: 'high' });
    const personal = row('email', 'john@a.com', { attrs: { kind: 'personal' }, confidence: 'medium' });
    expect(selectEmail([other, role, personal], policy)?.value).toBe('john@a.com');
    expect(selectEmail([other, role], policy)?.value).toBe('info@a.com');
    expect(selectEmail([other], policy)?.value).toBe('x@a.com');
  });

  it('email: same kind, higher confidence first, then the first captured', () => {
    const a = row('email', 'a@a.com', { attrs: { kind: 'role' }, confidence: 'medium', capturedAt: new Date('2026-10-25T09:00:00Z') });
    const b = row('email', 'b@a.com', { attrs: { kind: 'role' }, confidence: 'high', capturedAt: new Date('2026-10-25T11:00:00Z') });
    const c = row('email', 'c@a.com', { attrs: { kind: 'role' }, confidence: 'high', capturedAt: new Date('2026-10-25T08:00:00Z') });
    expect(selectEmail([a, b], policy)?.value).toBe('b@a.com');
    expect(selectEmail([a, b, c], policy)?.value).toBe('c@a.com');
  });

  it('selectLatest takes the most recent capture (the place page replaces the card)', () => {
    const card = row('review_count', '24', { sourceType: 'google_maps', capturedAt: new Date('2026-10-25T09:00:00Z') });
    const place = row('review_count', '25', { sourceType: 'google_maps', capturedAt: new Date('2026-10-25T09:05:00Z') });
    expect(selectLatest([card, place], 'review_count', policy)?.value).toBe('25');
  });

  it('rowsBehind lists the chosen row first, adds agreeing rows of other sources, and counts one source URL once', () => {
    const site = row('email', 'info@a.com', { sourceType: 'website', sourceUrl: 'https://a.com/contact' });
    const siteAgain = row('email', 'INFO@a.com', { valueNorm: 'info@a.com', sourceType: 'website', sourceUrl: 'https://a.com/contact' });
    const hic = row('email', 'info@a.com', { sourceType: 'nj_hic_roster', sourceUrl: 'https://hic.test/1' });
    const different = row('email', 'other@a.com', { sourceType: 'website' });
    const rejected = row('email', 'info@a.com', { sourceType: 'bbb', status: 'rejected' });
    const behind = rowsBehind([siteAgain, hic, different, rejected, site], site);
    expect(behind.map((r) => r.id)).toEqual([site.id, hic.id]);
  });
});
