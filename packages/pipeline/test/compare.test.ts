import { describe, expect, it } from 'vitest';
import { loadConfig, type Confidence } from '@pp/core';
import {
  compareTruth,
  fieldEquals,
  poolSummaries,
  recall,
  summarise,
  summaryMarkdown,
  type CompareInput,
  type SystemSample,
} from '../src/accuracy/compare';
import { NOT_FINDABLE, parseAdjudicationCsv, parseTruthCsv, type AdjudicationRow, type TruthField, type TruthRow } from '../src/accuracy/truth';
import type { ShownValue } from '../src/report/rows';

const config = loadConfig();
const FROZEN = new Date('2026-10-25T12:00:00Z');
const CHECKED = '2026-10-26T09:00:00Z'; // 21 h after the run

const sv = (value: string, confidence: Confidence = 'high'): ShownValue => ({ value, confidence, sourceUrl: 'https://src.test/p', snippet: `snippet ${value}` });

const sample = (shown: Record<string, ShownValue>, low: Record<string, ShownValue[]> = {}, id = 'NJ-001'): SystemSample => ({
  sampleId: id,
  companyId: 1,
  shown,
  lowCandidates: low,
});

const t = (field: TruthField, value: string, over: Partial<TruthRow> = {}, id = 'NJ-001'): TruthRow => ({
  sample_id: id,
  field,
  value,
  source_url: 'https://truth.test',
  checked_at: CHECKED,
  notes: '',
  ...over,
});

function run(samples: SystemSample[], truth: TruthRow[], adjudication: AdjudicationRow[] = []) {
  const input: CompareInput = {
    samples,
    truth,
    adjudication,
    drift: config.accuracy.drift,
    runFrozenAt: FROZEN,
    truthWithinHours: config.accuracy.truthWithinHours,
  };
  return compareTruth(input);
}

const clsOf = (out: ReturnType<typeof run>, field: TruthField, n = 0): string | undefined =>
  out.rows.filter((r) => r.field === field)[n]?.cls;

describe('compare classes (ACC-01, D-31)', () => {
  it('equal -> correct, different -> wrong', () => {
    const out = run(
      [sample({ owner_name: sv('John Smith'), phone: sv('(732) 555-0100') })],
      [t('owner_name', 'John Smith'), t('phone', '+17325559999')],
    );
    expect(clsOf(out, 'owner_name')).toBe('correct');
    expect(clsOf(out, 'phone')).toBe('wrong');
  });

  it('system blank + a findable truth -> missed; both blank -> both_blank', () => {
    const out = run([sample({})], [t('email', 'info@a.com'), t('owner_name', NOT_FINDABLE)]);
    expect(clsOf(out, 'email')).toBe('missed');
    expect(clsOf(out, 'owner_name')).toBe('both_blank');
  });

  it('a system value where the checker found nothing is unverifiable, never correct on its own', () => {
    const out = run([sample({ owner_name: sv('John Smith') })], [t('owner_name', NOT_FINDABLE)]);
    expect(clsOf(out, 'owner_name')).toBe('unverifiable');
    expect(out.rows.some((r) => r.cls === 'correct')).toBe(false);
  });

  it('an adjudication verdict decides an unverifiable row', () => {
    const verdict = (v: 'correct' | 'wrong'): AdjudicationRow[] => [{ sample_id: 'NJ-001', field: 'owner_name', value: 'John Smith', verdict: v, note: '' }];
    const s = [sample({ owner_name: sv('John Smith') })];
    expect(clsOf(run(s, [t('owner_name', NOT_FINDABLE)], verdict('correct')), 'owner_name')).toBe('correct');
    expect(clsOf(run(s, [t('owner_name', NOT_FINDABLE)], verdict('wrong')), 'owner_name')).toBe('wrong');
    // a verdict without a value covers every system value of that field
    expect(clsOf(run(s, [t('owner_name', NOT_FINDABLE)], [{ ...verdict('correct')[0]!, value: '' }]), 'owner_name')).toBe('correct');
  });

  it('a truth row left blank is not scored (unchecked), not silently counted', () => {
    const out = run([sample({ phone: sv('(732) 555-0100') })], [t('phone', '')]);
    expect(clsOf(out, 'phone')).toBe('unchecked');
    expect(out.unchecked).toBeGreaterThan(0);
  });

  it('several truth emails: the shown one counts as correct if it equals any of them', () => {
    const out = run([sample({ email: sv('sales@a.com') })], [t('email', 'info@a.com'), t('email', 'SALES@a.com')]);
    expect(clsOf(out, 'email')).toBe('correct');
  });

  it('low-confidence candidates are scored too, as their own rows, and are not "shown"', () => {
    const out = run(
      [sample({ owner_name: sv('Real Owner', 'high') }, { owner_name: [sv('Wrong Person', 'low')] })],
      [t('owner_name', 'Real Owner')],
    );
    const rows = out.rows.filter((r) => r.field === 'owner_name');
    expect(rows.map((r) => [r.systemValue, r.confidence, r.cls, r.shown])).toEqual([
      ['Real Owner', 'high', 'correct', true],
      ['Wrong Person', 'low', 'wrong', false],
    ]);
  });
});

describe('normalisation before comparing', () => {
  const ctx = { drift: config.accuracy.drift, truthReviews: null, systemReviews: null };

  it('phones compare as E.164', () => {
    expect(fieldEquals('phone', '(732) 555-0100', '+17325550100', ctx)).toBe(true);
    expect(fieldEquals('phone', '732.555.0100', '1-732-555-0100', ctx)).toBe(true);
    expect(fieldEquals('phone', '(732) 555-0100', '(732) 555-0101', ctx)).toBe(false);
  });

  it('emails compare lower-cased', () => {
    expect(fieldEquals('email', 'Info@Acme.COM', 'info@acme.com', ctx)).toBe(true);
  });

  it('URLs compare as host + path without www, scheme or a trailing slash', () => {
    expect(fieldEquals('website', 'https://www.acme.com/', 'http://acme.com', ctx)).toBe(true);
    expect(fieldEquals('website', 'https://acme.com/about', 'https://acme.com', ctx)).toBe(false);
  });

  it('person names ignore case, honorifics and middle initials', () => {
    expect(fieldEquals('owner_name', 'JOHN A. SMITH', 'John Smith', ctx)).toBe(true);
    expect(fieldEquals('owner_name', 'Mr. John Smith', 'John Smith', ctx)).toBe(true);
    expect(fieldEquals('owner_name', 'John Smith', 'Jon Smith', ctx)).toBe(false);
  });

  it('ZIPs compare as 5 digits', () => {
    expect(fieldEquals('zip', '08817', '08817-1234', ctx)).toBe(true);
    expect(fieldEquals('zip', '08817', '8817', ctx)).toBe(false);
  });

  it('a street line matches the same street inside a full address; company names ignore entity suffixes', () => {
    expect(fieldEquals('address', '1 Oak St', '1 Oak St, Edison, NJ 08817', ctx)).toBe(true);
    expect(fieldEquals('address', '2 Oak St', '1 Oak St, Edison, NJ 08817', ctx)).toBe(false);
    expect(fieldEquals('name', 'Acme Painting LLC', 'ACME PAINTING', ctx)).toBe(true);
  });

  it('residential status and painter flags compare by meaning', () => {
    expect(fieldEquals('residential_status', 'Residential only', 'residential_only', ctx)).toBe(true);
    expect(fieldEquals('is_painter', 'yes', 'Y', ctx)).toBe(true);
    expect(fieldEquals('is_painter', 'yes', 'no', ctx)).toBe(false);
  });
});

describe('rating and review count use the drift rule', () => {
  it('review count 120 captured, 122 live -> correct; 125 -> wrong; 119 -> wrong', () => {
    const cls = (live: string): string | undefined =>
      clsOf(run([sample({ review_count: sv('120') })], [t('review_count', live)]), 'review_count');
    expect(cls('122')).toBe('correct');
    expect(cls('125')).toBe('wrong');
    expect(cls('119')).toBe('wrong');
  });

  it('rating 4.8 vs live 4.7 is correct when the review count changed, wrong when it did not', () => {
    const changed = run([sample({ rating: sv('4.8'), review_count: sv('120') })], [t('rating', '4.7'), t('review_count', '121')]);
    expect(clsOf(changed, 'rating')).toBe('correct');
    const same = run([sample({ rating: sv('4.8'), review_count: sv('120') })], [t('rating', '4.7'), t('review_count', '120')]);
    expect(clsOf(same, 'rating')).toBe('wrong');
  });
});

describe('truth freshness', () => {
  it('flags truth collected more than 48 hours after the run', () => {
    const late = run([sample({ phone: sv('(732) 555-0100') })], [t('phone', '+17325550100', { checked_at: '2026-10-28T12:00:01Z' })]);
    expect(late.rows.find((r) => r.field === 'phone')?.stale).toBe(true);
    expect(late.stale).toBe(1);
    const ok = run([sample({ phone: sv('(732) 555-0100') })], [t('phone', '+17325550100')]);
    expect(ok.rows.find((r) => r.field === 'phone')?.stale).toBe(false);
  });
});

describe('precision, recall and the intervals (D-38)', () => {
  const build = () => {
    const samples: SystemSample[] = [];
    const truth: TruthRow[] = [];
    for (let i = 1; i <= 10; i++) {
      const id = `NJ-${String(i).padStart(3, '0')}`;
      samples.push(sample({ phone: sv(i === 10 ? '(732) 555-9999' : '(732) 555-0100') }, i === 3 ? { phone: [sv('(732) 555-7777', 'low')] } : {}, id));
      truth.push(t('phone', '+17325550100', {}, id));
      // owners: 8 samples with an owner shown (one wrong, one missed)
      if (i <= 8) {
        samples[i - 1]!.shown.owner_name = sv(i === 8 ? 'Wrong Person' : 'Real Owner', i <= 4 ? 'high' : 'medium');
        truth.push(t('owner_name', 'Real Owner', {}, id));
      } else if (i === 9) {
        truth.push(t('owner_name', 'Missed Owner', {}, id));
      }
    }
    return run(samples, truth);
  };

  it('precision per field and per confidence level with n, plus the shown aggregate', () => {
    const out = build();
    const doc = summarise(out, { runId: 1, state: 'NJ', seed: 42, samples: 10 });
    expect(doc.counts['phone']?.high).toEqual({ correct: 9, wrong: 1, unverifiable: 0 });
    expect(doc.counts['phone']?.low).toEqual({ correct: 0, wrong: 1, unverifiable: 0 }); // the held-back candidate
    expect(doc.counts['phone']?.shown).toEqual({ correct: 9, wrong: 1, unverifiable: 0 }); // low is not shown
    expect(doc.counts['owner_name']?.high).toEqual({ correct: 4, wrong: 0, unverifiable: 0 });
    expect(doc.counts['owner_name']?.medium).toEqual({ correct: 3, wrong: 1, unverifiable: 0 });
    expect(doc.counts['owner_name']?.shown).toEqual({ correct: 7, wrong: 1, unverifiable: 0 });
  });

  it('recall = correct / (correct + wrong + missed) over shown values', () => {
    const doc = summarise(build(), { runId: 1, state: 'NJ', seed: 42, samples: 10 });
    expect(doc.missed['owner_name']).toBe(1);
    const r = recall(doc, 'owner_name');
    expect(r).toMatchObject({ n: 9, correct: 7 });
    expect(r.point).toBeCloseTo(7 / 9, 10);
  });

  it('summary.md gives n and the Wilson interval for every figure and labels per-state-per-field as indicative', () => {
    const doc = summarise(build(), { runId: 1, state: 'NJ', seed: 42, samples: 10 });
    const md = summaryMarkdown(doc, poolSummaries([doc]));
    expect(md).toContain('per-state-per-field figures are indicative (n small)');
    expect(md).toContain('Wilson 95% low');
    expect(md).toMatch(/\| phone \| shown \(high \+ medium\) \| 10 \| 9 \| 90\.0% \| \d+\.\d% \| \d+\.\d% \|/);
    expect(md).toContain('## Pooled over 10 samples');
    // no precision row without its n and interval
    const precisionRows = md.split('\n').filter((l) => /^\| (phone|owner_name) \| (high|medium|low|shown)/.test(l));
    expect(precisionRows.length).toBeGreaterThan(4);
    for (const line of precisionRows) {
      expect(line.split('|').filter((c) => c.trim() !== '').length).toBeGreaterThanOrEqual(8);
    }
  });

  it('pooling adds the counts of the states', () => {
    const a = summarise(build(), { runId: 1, state: 'NJ', seed: 1, samples: 10 });
    const b = summarise(build(), { runId: 2, state: 'TX', seed: 1, samples: 10 });
    const pooled = poolSummaries([a, b]);
    expect(pooled.samples).toBe(20);
    expect(pooled.counts['phone']?.shown).toEqual({ correct: 18, wrong: 2, unverifiable: 0 });
    expect(pooled.missed['owner_name']).toBe(2);
  });
});

describe('truth files', () => {
  it('parse truth.csv with NOT_FINDABLE in any case, several email rows and a BOM', () => {
    const rows = parseTruthCsv('﻿sample_id,field,value,source_url,checked_at,notes\nNJ-001,email,a@b.com,https://x,2026-10-26T09:00:00Z,\nNJ-001,email,c@d.com,https://x,2026-10-26T09:00:00Z,\nNJ-001,owner_name,not_findable,,2026-10-26T09:00:00Z,looked at about page\n');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ field: 'owner_name', value: NOT_FINDABLE });
  });

  it('reject an unknown field with the row number', () => {
    expect(() => parseTruthCsv('sample_id,field,value\nNJ-001,shoe_size,9\n')).toThrow(/row 2/);
  });

  it('adjudication.csv rows without a verdict are ignored; a bad verdict is refused', () => {
    expect(parseAdjudicationCsv('sample_id,field,value,verdict\nNJ-001,email,a@b.com,\nNJ-002,email,a@b.com,Correct\n')).toHaveLength(1);
    expect(() => parseAdjudicationCsv('sample_id,field,value,verdict\nNJ-001,email,a@b.com,maybe\n')).toThrow();
  });
});
