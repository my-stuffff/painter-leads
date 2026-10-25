import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDiff, goldenFieldKeys, loadGoldenCases, replayCase, replayField } from '../src/accuracy/golden-replay';
import { correctReplayers } from './golden-fakes';

const SAMPLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golden-sample');
const cases = loadGoldenCases(SAMPLE_DIR);
const byslug = (slug: string) => cases.find((c) => c.slug === slug) as (typeof cases)[number];

describe('golden harness on the synthetic cases (ACC-02)', () => {
  it('loads the cases in sorted directory order', () => {
    expect(cases.map((c) => `${c.state}/${c.slug}`)).toEqual(['NJ/synthetic-no-owner', 'NJ/synthetic-painting-co']);
  });

  it('lists the replayable fields of a case (these become the test titles state/slug/field)', () => {
    expect(goldenFieldKeys(byslug('synthetic-painting-co'))).toEqual([
      'emails',
      'owners',
      'residential',
      'maps_card.name',
      'maps_card.rating',
      'maps_card.review_count',
      'maps_card.phone',
      'maps_card.category',
      'maps_card.website',
      'registry_match',
    ]);
  });

  it('PASSES with the correct replayers: zero differences on every case', () => {
    for (const c of cases) expect(replayCase(c, correctReplayers())).toEqual([]);
  });

  it('FAILS with a broken replayer: a replayer that drops the email is reported with state, slug, field, expected and actual', () => {
    const broken = { ...correctReplayers(), emails: () => [] };
    const diffs = replayCase(byslug('synthetic-painting-co'), broken);
    expect(diffs).toEqual([
      { state: 'NJ', slug: 'synthetic-painting-co', field: 'emails', expected: 'info@synthetic-painting.test', actual: '(none)' },
    ]);
    expect(formatDiff(diffs[0]!)).toBe('NJ/synthetic-painting-co/emails: expected info@synthetic-painting.test, actual (none)');
  });

  it('FAILS when a replayer fills a field marked NOT_FINDABLE (the extractor now makes something up)', () => {
    const fills = { ...correctReplayers(), owners: () => [{ name: 'Made Up', title: 'Owner', confidence: 'medium' as const }] };
    const diffs = replayCase(byslug('synthetic-no-owner'), fills);
    expect(diffs).toEqual([{ state: 'NJ', slug: 'synthetic-no-owner', field: 'owners', expected: 'NOT_FINDABLE', actual: 'made up' }]);

    const emailFill = { ...correctReplayers(), emails: () => ['sales@no-owner-painting.test'] };
    expect(replayCase(byslug('synthetic-no-owner'), emailFill)[0]).toMatchObject({ field: 'emails', expected: 'NOT_FINDABLE' });
  });

  it('a low-confidence owner from the replayer is not an answer; names compare by person key (middle initials, case)', () => {
    const low = { ...correctReplayers(), owners: () => [{ name: 'Someone Else', title: null, confidence: 'low' as const }] };
    expect(replayCase(byslug('synthetic-no-owner'), low)).toEqual([]);
    const spelled = { ...correctReplayers(), owners: () => [{ name: 'SAM Q. SYNTHETIC', title: 'Owner', confidence: 'medium' as const }] };
    expect(replayField(byslug('synthetic-painting-co'), 'owners', spelled)).toBeNull();
  });

  it('a wrong residential label and a changed Maps card field are reported per field', () => {
    const wrong = {
      ...correctReplayers(),
      residential: () => ({ label: 'commercial_only' as const, signals: [], reason: 'x' }),
      mapsCard: () => ({ name: 'Synthetic Painting Co', rating: '4.5', review_count: '25', phone: '+17325550199', category: 'Painter', website: 'https://synthetic-painting.test' }),
    };
    const diffs = replayCase(byslug('synthetic-painting-co'), wrong);
    expect(diffs.map((d) => [d.field, d.expected, d.actual])).toEqual([
      ['residential', 'residential_only', 'commercial_only'],
      ['maps_card.rating', '4.9', '4.5'],
    ]);
  });

  it('a Maps field marked null (not on the card) fails if the parser now fills it', () => {
    const fills = { ...correctReplayers(), mapsCard: () => ({ name: 'No Owner Painting', rating: '4.8', review_count: '40', phone: '+17325550000', category: 'Painting contractor', website: 'https://no-owner-painting.test' }) };
    expect(replayCase(byslug('synthetic-no-owner'), fills).map((d) => [d.field, d.expected])).toEqual([['maps_card.phone', 'NOT_FINDABLE']]);
  });

  it('a registry matcher that stops matching, or matches the wrong row, is reported', () => {
    const none = { ...correctReplayers(), registryMatch: () => [] };
    expect(replayCase(byslug('synthetic-painting-co'), none)[0]).toMatchObject({ field: 'registry_match', expected: '13VH00099900:strong', actual: '(none)' });
    const wrongRow = { ...correctReplayers(), registryMatch: () => [{ sourceKey: '13VH00011100', strength: 'strong' as const }] };
    expect(replayCase(byslug('synthetic-painting-co'), wrongRow)[0]).toMatchObject({ field: 'registry_match', actual: '13VH00011100:strong' });
  });

  it('a missing replayer fails loudly instead of passing', () => {
    const { emails: _emails, ...withoutEmails } = correctReplayers();
    expect(() => replayCase(byslug('synthetic-painting-co'), withoutEmails)).toThrow('replayer "emails" is missing (package sites not merged yet)');
    expect(() => replayCase(byslug('synthetic-painting-co'), {})).toThrow(/is missing/);
  });

  it('the slimmed gzip pages were read back as text', () => {
    expect(byslug('synthetic-painting-co').pages[0]?.html).toContain('mailto:info@synthetic-painting.test');
    expect(byslug('synthetic-painting-co').pages[0]).toMatchObject({ url: 'https://synthetic-painting.test/', rendered: false });
  });
});
