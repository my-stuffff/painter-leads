import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll, type Db, type RegistryMatchInput } from '@pp/core';
import { commands } from '../src/commands';
import { restoreSupersededRegistryEvidence } from '../src/restore';
import { resetRosterQueue } from '../src/nj/roster-ensure';
import { loadNjRosterRows, parseNjRoster } from '../src/nj/roster-parse';
import { createRegistriesStage } from '../src/stage';
import { fixture, insertCompany, makeFetcher, stageContext, tempDir, testConfig } from './helpers';
import { mockDetailFlow, mockPrincipalFlow } from './nj-detail-mocks';

let db: Db;
let close: () => Promise<void>;
const saved = process.env.PP_DATA_DIR;
const CAPTURED = new Date('2026-10-25T12:00:00Z');
const spectraRow =
  'SPECTRA PAINTING, INC|||||Home Improvement Contractors|Home Improvement Business Contr|13VH06161800|3/7/2011|3/31/2027|65 Reeds Rd||Tinton Falls|NJ|07724|Monmouth|spectra@spectra-example.test|Active|';

beforeAll(() => {
  ({ db, close } = getTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await truncateAll(db);
  resetRosterQueue();
  const dir = path.join(tempDir(), 'downloads', 'nj');
  mkdirSync(dir, { recursive: true });
  for (const slug of ['edison', 'tinton-falls']) writeFileSync(path.join(dir, `${slug}-2026-10-25.txt`), '');
  process.env.PP_DATA_DIR = path.dirname(path.dirname(dir));
  await loadNjRosterRows(db, parseNjRoster(`${fixture('nj', 'nj-roster-synthetic.txt')}${spectraRow}\n`), { capturedAt: CAPTURED });
});
afterEach(() => {
  if (saved === undefined) delete process.env.PP_DATA_DIR;
  else process.env.PP_DATA_DIR = saved;
});

const config = testConfig();
const NJ = new Set(['nj_hic_roster', 'nj_hic_detail', 'nj_principal_search'] as const);

/** A company matched to Spectra with its owner and principal check captured (mocked), as run 8 had it. */
async function matchedCompany(): Promise<{ companyId: number; input: RegistryMatchInput }> {
  const company = await insertCompany(db, { name: 'Spectra Painting', state: 'NJ', city: 'Tinton Falls', zip: '07724' });
  const input: RegistryMatchInput = { company, emails: [], licenceNumbers: [], websiteDomain: null };
  const f = makeFetcher(config);
  mockDetailFlow(f.agent, 'spectra');
  mockPrincipalFlow(f.agent, true);
  await createRegistriesStage({ only: NJ }).run(stageContext(db, f.fetcher, config), input);
  return { companyId: company.companyId, input };
}

const supersedeAll = (companyId: number): Promise<unknown> =>
  db.$client.query(`UPDATE evidence SET status = 'rejected', reject_reason = 'superseded' WHERE company_id = $1 AND source_type LIKE 'nj_%'`, [companyId]);
const accepted = async (companyId: number): Promise<string[]> =>
  (await db.$client.query(`SELECT source_type, field, value FROM evidence WHERE company_id = $1 AND status = 'accepted' ORDER BY id`, [companyId])).rows.map(
    (r: { source_type: string; field: string; value: string }) => `${r.source_type}/${r.field}=${r.value}`,
  );

describe('restoreSupersededRegistryEvidence', () => {
  it('puts back every value a reprocess retired and did not write again (the run-8 damage), and is idempotent', async () => {
    const { companyId } = await matchedCompany();
    const before = await accepted(companyId);
    expect(before).toHaveLength(7);
    await supersedeAll(companyId);
    expect(await accepted(companyId)).toEqual([]);

    const r = await restoreSupersededRegistryEvidence(db, { companyIds: [companyId] });
    expect(r).toMatchObject({ restored: 7, companies: 1 });
    expect(r.byKind['nj_hic_detail/owner_name']).toBe(1);
    expect(r.byKind['nj_principal_search/owner_name']).toBe(1);
    expect(await accepted(companyId)).toEqual(before);

    expect((await restoreSupersededRegistryEvidence(db, { companyIds: [companyId] })).restored).toBe(0);
    const rejected = await db.$client.query(`SELECT count(*)::int AS n FROM evidence WHERE company_id = $1 AND status = 'rejected'`, [companyId]);
    expect(rejected.rows[0].n).toBe(0);
  });

  it('leaves a retired value alone when a value of that field from that source was written again (the new one wins)', async () => {
    const { companyId, input } = await matchedCompany();
    await supersedeAll(companyId);
    // the owner changed: the stage wrote the new one
    await db.$client.query(
      `INSERT INTO evidence (company_id, registry_record_id, field, value, value_norm, source_type, source_url, captured_at, snippet, extractor, extractor_version, confidence, status)
       SELECT company_id, registry_record_id, field, 'Erica Doeler', 'erica doeler', source_type, source_url, now(), snippet, extractor, extractor_version, confidence, 'accepted'
         FROM evidence WHERE company_id = $1 AND source_type = 'nj_hic_detail' LIMIT 1`,
      [input.company.companyId],
    );
    await restoreSupersededRegistryEvidence(db, { companyIds: [companyId] });
    const now = await accepted(companyId);
    expect(now).toContain('nj_hic_detail/owner_name=Erica Doeler');
    expect(now).not.toContain('nj_hic_detail/owner_name=Eric Doeler');
    // the principal check confirmed the OLD owner: it stays retired
    expect(now.some((a) => a.startsWith('nj_principal_search/'))).toBe(false);
    // the roster values are still the registry's: back
    expect(now).toContain('nj_hic_roster/licence_number=13VH06161800');
  });

  it('does not bring back values of a registration the company is no longer matched to, or a source that now says no_match', async () => {
    const { companyId } = await matchedCompany();
    await supersedeAll(companyId);
    await db.$client.query(`DELETE FROM registry_matches WHERE company_id = $1`, [companyId]);
    expect((await restoreSupersededRegistryEvidence(db, { companyIds: [companyId] })).restored).toBe(0);

    const again = await matchedCompany();
    await supersedeAll(again.companyId);
    await db.$client.query(`UPDATE companies SET registry_status = registry_status || '{"nj_hic_detail":"no_match","nj_principal_search":"no_match"}'::jsonb WHERE id = $1`, [again.companyId]);
    const r = await restoreSupersededRegistryEvidence(db, { companyIds: [again.companyId] });
    expect(r.restored).toBe(5); // the roster rows only: no owner any more
    expect((await accepted(again.companyId)).some((a) => a.includes('owner_name'))).toBe(false);
  });

  it('is a CLI command: pp registries restore-superseded --run N', async () => {
    const { companyId } = await matchedCompany();
    const runId = (await db.$client.query(`INSERT INTO runs (area_id, state, status, config_snapshot) VALUES ('edison_nj', 'NJ', 'running', '{}'::jsonb) RETURNING id`)).rows[0].id as number;
    await db.$client.query('UPDATE companies SET run_id = $2 WHERE id = $1', [companyId, runId]);
    await supersedeAll(companyId);

    const spec = commands.find((c) => c.name === 'registries restore-superseded');
    expect(spec?.options?.some((o) => o.flags === '--run <id>')).toBe(true);
    const lines: string[] = [];
    const ctx = { db: async () => db, out: (l: string) => lines.push(l) } as never;
    await spec?.run(ctx, [], { run: String(runId) });
    expect(lines[0]).toBe(`run ${runId}: 7 registry values put back on 1 companies`);
    expect(await accepted(companyId)).toHaveLength(7);
    await expect(spec?.run(ctx, [], {})).rejects.toThrow(/--run/);
  });
});
