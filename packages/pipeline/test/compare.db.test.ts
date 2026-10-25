import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll } from '@pp/core';
import { buildAdjudicationSheet } from '../src/accuracy/adjudication';
import { compareRun, emptySummary, loadSystemSamples, RESULT_COLUMNS } from '../src/accuracy/compare';
import { drawSample } from '../src/accuracy/sample';
import { q } from '../src/sql';
import { makeEnv } from './helpers';
import { buildScenario } from './scenario';

const handle = getTestDb();
const db = handle.db;
const env = makeEnv(db);

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const CHECKED = '2026-10-26T09:00:00Z';

async function prepare() {
  const s = await buildScenario(env);
  await q(db, `UPDATE runs SET status = 'done', finished_at = '2026-10-25T12:00:00Z' WHERE id = $1`, [s.runId]);
  const drawn = await drawSample(db, env.config, s.runId, 42, s.base);
  const alpha = drawn.samples.find((x) => x.company === 'Alpha Painting')!.sampleId;
  const truth = (rows: [string, string][]): string =>
    ['sample_id,field,value,source_url,checked_at,notes', ...rows.map(([f, v]) => `${alpha},${f},${v},https://truth.test,${CHECKED},`)].join('\n');
  return { s, alpha, truth };
}

describe('accuracy compare on a sampled run (ACC-01)', () => {
  it('loads the system side from the same selection the report shows, with held-back candidates', async () => {
    const { s, alpha } = await prepare();
    const systems = await loadSystemSamples(db, env.config, s.runId);
    const a = systems.find((x) => x.sampleId === alpha)!;
    expect(a.shown['name']?.value).toBe('Alpha Painting');
    expect(a.shown['phone']?.value).toBe('(732) 555-0101');
    expect(a.shown['email']).toMatchObject({ value: 'info@alphapainting.com', confidence: 'high' });
    expect(a.shown['owner_name']).toMatchObject({ value: 'Jane Alpha', confidence: 'medium', sourceUrl: 'https://alphapainting.com/about' });
    expect(a.shown['rating']?.value).toBe('4.8');
    expect(a.shown['is_painter']?.value).toBe('yes');
    expect(a.shown['residential_status']?.value).toBe('Residential only');
    expect(a.shown['zip']?.value).toBe('08817');
  });

  it('writes results.csv, summary.json and summary.md; unverifiable values wait for adjudication', async () => {
    const { s, alpha, truth } = await prepare();
    const text = truth([
      ['name', 'Alpha Painting'],
      ['phone', '+17325550101'],
      ['website', 'https://www.alphapainting.com/'],
      ['email', 'INFO@alphapainting.com'],
      ['owner_name', 'NOT_FINDABLE'],
      ['rating', '4.8'],
      ['review_count', '26'],
      ['zip', '08820'],
    ]);
    const r = await compareRun(db, env.config, s.runId, { truthText: text, base: s.base });

    const results = parse(readFileSync(r.files.results, 'utf8'), { bom: true }) as string[][];
    expect(results[0]).toEqual([...RESULT_COLUMNS]);
    const rowFor = (field: string): string[] => results.find((x) => x[0] === alpha && x[1] === field) as string[];
    expect(rowFor('phone')).toEqual([alpha, 'phone', '(732) 555-0101', 'high', "'+17325550101", 'correct', '']);
    expect(rowFor('website')[5]).toBe('correct');
    expect(rowFor('email')[5]).toBe('correct');
    expect(rowFor('owner_name')[5]).toBe('unverifiable');
    expect(rowFor('review_count')[5]).toBe('correct'); // 25 captured, 26 live: inside the drift allowance
    expect(rowFor('zip')[5]).toBe('wrong');
    expect(rowFor('category')[5]).toBe('unchecked');

    const json = JSON.parse(readFileSync(r.files.summaryJson, 'utf8'));
    expect(json.state).toBe('NJ');
    expect(json.seed).toBe(42);
    expect(json.counts.phone.shown).toEqual({ correct: 1, wrong: 0, unverifiable: 0 });
    expect(json.counts.owner_name.medium.unverifiable).toBe(1);

    const md = readFileSync(r.files.summaryMd, 'utf8');
    expect(md).toContain('per-state-per-field figures are indicative (n small)');
    expect(md).toContain('Wilson 95% low');
  });

  it('the adjudication sheet lists the unverifiable value with its source, and a verdict resolves it', async () => {
    const { s, alpha, truth } = await prepare();
    const text = truth([['owner_name', 'NOT_FINDABLE']]);
    const sheet = await buildAdjudicationSheet(db, env.config, s.runId, { truthText: text, base: s.base });
    expect(sheet.rows).toBe(1);
    const rows = parse(readFileSync(sheet.file, 'utf8'), { bom: true }) as string[][];
    expect(rows[0]).toEqual(['sample_id', 'field', 'system_value', 'confidence', 'source_url', 'snippet', 'verdict', 'note']);
    expect(rows[1]?.slice(0, 5)).toEqual([alpha, 'owner_name', 'Jane Alpha', 'medium', 'https://alphapainting.com/about']);
    expect(rows[1]?.[5]).toBe('Jane Alpha');
    expect(rows[1]?.[6]).toBe('');

    const adj = `sample_id,field,value,verdict,note\n${alpha},owner_name,Jane Alpha,correct,"About page says so"\n`;
    const after = await compareRun(db, env.config, s.runId, { truthText: text, adjudicationText: adj, base: s.base });
    expect(after.summary.counts['owner_name']?.medium).toEqual({ correct: 1, wrong: 0, unverifiable: 0 });
    expect((await buildAdjudicationSheet(db, env.config, s.runId, { truthText: text, adjudicationText: adj, base: s.base })).rows).toBe(0);
  });

  it('pools this state with the summaries already written for other states', async () => {
    const { s, truth } = await prepare();
    const other = emptySummary('TX');
    other.runId = 99;
    other.samples = 50;
    other.counts['phone']!.shown = { correct: 45, wrong: 5, unverifiable: 0 };
    const dir = path.join(s.base, '99', 'accuracy', 'TX');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(other));

    const r = await compareRun(db, env.config, s.runId, { truthText: truth([['phone', '+17325550101']]), base: s.base });
    expect(r.pooled.samples).toBe(50 + r.summary.samples);
    expect(r.pooled.counts['phone']?.shown).toEqual({ correct: 46, wrong: 5, unverifiable: 0 });
    expect(readFileSync(r.files.summaryMd, 'utf8')).toContain(`## Pooled over ${r.pooled.samples} samples`);
  });

  it('refuses a run that has no sample', async () => {
    const s = await buildScenario(env);
    await expect(compareRun(db, env.config, s.runId, { truthText: 'sample_id,field,value\n', base: s.base })).rejects.toThrow(/has no sample/);
  });
});
