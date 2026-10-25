import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll, type Db, type RegistryMatchInput, type StageContext } from '@pp/core';
import { ROSTER_RETRY_PAUSE_MS, resetRosterQueue } from '../src/nj/roster-ensure';
import { loadNjRosterRows, parseNjRoster } from '../src/nj/roster-parse';
import { createRegistriesStage } from '../src/stage';
import { fixture, insertCompany, makeFetcher, stageContext, tempDir, testConfig } from './helpers';
import { mockDetailFlow, mockPrincipalFlow } from './nj-detail-mocks';
import { mockRosterFlow } from './nj-mocks';

let db: Db;
let close: () => Promise<void>;
const saved = process.env.PP_DATA_DIR;
const NJ = new Set(['nj_hic_roster', 'nj_hic_detail', 'nj_principal_search'] as const);

/** The real Spectra registration (public register data; the email is invented), as a Tinton Falls roster. */
const tintonFallsRoster = `${fixture('nj', 'nj-roster-synthetic.txt').split('\n')[0]}\nSPECTRA PAINTING, INC.|||||Home Improvement Contractors|Home Improvement Business Contr|13VH06161800|3/7/2011|3/31/2027|65 Reeds Rd||Tinton Falls|NJ|07724|Monmouth|spectra@spectra-example.test|Active|\n`;

beforeAll(() => {
  ({ db, close } = getTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await truncateAll(db);
  resetRosterQueue();
  process.env.PP_DATA_DIR = tempDir();
});
afterEach(() => {
  if (saved === undefined) delete process.env.PP_DATA_DIR;
  else process.env.PP_DATA_DIR = saved;
});

/** A run in the Edison area, so every company needs the rosters of its own town AND Edison. */
async function edisonRun(): Promise<number> {
  const r = await db.$client.query(`INSERT INTO runs (area_id, state, status, config_snapshot) VALUES ('edison_nj', 'NJ', 'running', '{}'::jsonb) RETURNING id`);
  return r.rows[0].id as number;
}

async function input(over: { name: string; city: string; zip: string }): Promise<RegistryMatchInput> {
  const company = await insertCompany(db, { state: 'NJ', ...over });
  return { company, emails: [], licenceNumbers: [], websiteDomain: null };
}

function setup() {
  const f = makeFetcher(testConfig());
  const sleeps: number[] = [];
  return { ...f, sleeps, ctxFor: (runId: number): StageContext => ({ ...stageContext(db, f.fetcher, f.config), runId, sleep: async (ms) => void sleeps.push(ms) }) };
}

const rosterFlows = (calls: string[]) => calls.filter((c) => c.includes('/Verification_Bulk/Search.aspx') && c.startsWith('GET')).length;
const rosterRows = async () => (await db.$client.query(`SELECT upper(city) AS city, count(*)::int AS n FROM registry_records WHERE source_type = 'nj_hic_roster' GROUP BY 1 ORDER BY 1`)).rows;
const statusOf = async (companyId: number) => (await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [companyId])).rows[0].registry_status;

describe('NJ roster: a town that fails once is retried after a pause', () => {
  it('(a) 500 at "Download List", then success on the retry: every town is loaded and nothing is skipped', async () => {
    const t = setup();
    const runId = await edisonRun();
    const i = await input({ name: 'Bright Coat Painting LLC', city: 'Iselin', zip: '08817' });
    mockRosterFlow(t.agent, { downloadListFails: true }); // Iselin, first try
    mockRosterFlow(t.agent, { roster: tintonFallsRoster.replace('Tinton Falls', 'Iselin') }); // Iselin, retry
    mockRosterFlow(t.agent); // Edison

    const r = await createRegistriesStage({ only: NJ }).run(t.ctxFor(runId), i);

    expect(t.sleeps).toEqual([ROSTER_RETRY_PAUSE_MS]);
    expect(rosterFlows(t.calls())).toBe(3);
    expect((await rosterRows()).map((x) => x.city)).toEqual(['EDISON', 'ISELIN']);
    expect(r.status.nj_hic_roster).toBe('matched');
    expect((await statusOf(i.company.companyId)).nj_roster_skipped).toBeUndefined();
  });
});

describe('NJ roster: a town that fails twice is skipped, nothing else is lost', () => {
  it('(b) the other towns load, and the detail and principal lookups still run for a company the stored roster already matches', async () => {
    const t = setup();
    const runId = await edisonRun();
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    // Tinton Falls was pulled a month ago (older than 7 days, so it is due again) and its rows are in the database.
    await loadNjRosterRows(db, parseNjRoster(tintonFallsRoster), { capturedAt: new Date('2026-09-20T00:00:00Z') });
    mockRosterFlow(t.agent, { downloadListFails: true });
    mockRosterFlow(t.agent, { downloadListFails: true });
    mockRosterFlow(t.agent); // Edison
    mockDetailFlow(t.agent, 'spectra');
    mockPrincipalFlow(t.agent, true);

    const r = await createRegistriesStage({ only: NJ }).run(t.ctxFor(runId), i);

    expect(r.status).toEqual({ nj_hic_roster: 'matched', nj_hic_detail: 'matched', nj_principal_search: 'matched' });
    expect(r.owners).toBe(1);
    expect(t.sleeps).toEqual([ROSTER_RETRY_PAUSE_MS]);
    expect((await rosterRows()).map((x) => x.city)).toEqual(['EDISON', 'TINTON FALLS']);
    expect(rosterFlows(t.calls())).toBe(3);
    expect(t.calls().some((c) => c.includes('/verification/Details.aspx'))).toBe(true);
    expect(t.calls().some((c) => c.includes('/DOR/BusinessRecords/'))).toBe(true);
  });

  it('(b) a company that nothing on the loaded rosters matches is an error for the roster source (never "no match") and names the skipped town', async () => {
    const t = setup();
    const runId = await edisonRun();
    const i = await input({ name: 'Nobody Painting', city: 'Iselin', zip: '08830' });
    mockRosterFlow(t.agent, { downloadListFails: true });
    mockRosterFlow(t.agent, { downloadListFails: true });
    mockRosterFlow(t.agent); // Edison

    const r = await createRegistriesStage({ only: NJ }).run(t.ctxFor(runId), i);

    expect(r.status).toEqual({ nj_hic_roster: 'error', nj_hic_detail: 'not_applicable', nj_principal_search: 'not_applicable' });
    expect((await statusOf(i.company.companyId)).nj_roster_skipped).toEqual(['Iselin']);
    expect((await rosterRows()).map((x) => x.city)).toEqual(['EDISON']);
  });

  it('(b) the next company of the same stage does not hit the failed town again', async () => {
    const t = setup();
    const runId = await edisonRun();
    const a = await input({ name: 'Nobody Painting', city: 'Iselin', zip: '08830' });
    const b = await input({ name: 'Nobody Else Painting', city: 'Iselin', zip: '08830' });
    mockRosterFlow(t.agent, { downloadListFails: true });
    mockRosterFlow(t.agent, { downloadListFails: true });
    mockRosterFlow(t.agent); // Edison, pulled once

    const stage = createRegistriesStage({ only: NJ });
    await stage.run(t.ctxFor(runId), a);
    const before = rosterFlows(t.calls());
    const r = await stage.run(t.ctxFor(runId), b);

    expect(before).toBe(3);
    expect(rosterFlows(t.calls())).toBe(before);
    expect(t.sleeps).toEqual([ROSTER_RETRY_PAUSE_MS]);
    expect(r.status.nj_hic_roster).toBe('error');
  });

  it('(d) re-running the stage (a new stage instance) pulls the town that failed before and matches the company', async () => {
    const t = setup();
    const runId = await edisonRun();
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    mockRosterFlow(t.agent, { downloadListFails: true });
    mockRosterFlow(t.agent, { downloadListFails: true });
    mockRosterFlow(t.agent); // Edison

    const first = await createRegistriesStage({ only: NJ }).run(t.ctxFor(runId), i);
    expect(first.status.nj_hic_roster).toBe('error');

    mockRosterFlow(t.agent, { roster: tintonFallsRoster }); // Tinton Falls now answers; Edison's file is still fresh
    mockDetailFlow(t.agent, 'spectra');
    mockPrincipalFlow(t.agent, true);
    const again = await createRegistriesStage({ only: NJ }).run(t.ctxFor(runId), i);

    expect(again.status).toEqual({ nj_hic_roster: 'matched', nj_hic_detail: 'matched', nj_principal_search: 'matched' });
    expect(rosterFlows(t.calls())).toBe(4);
    expect((await statusOf(i.company.companyId)).nj_roster_skipped).toBeUndefined();
  });
});

describe('NJ roster: a charge still stops the flow', () => {
  it('(c) a confirmation page that is not $0.00 stops before Continue, is not retried or skipped, and fails the NJ sources', async () => {
    const t = setup();
    const runId = await edisonRun();
    const i = await input({ name: 'Nobody Painting', city: 'Iselin', zip: '08830' });
    const seen = mockRosterFlow(t.agent, { confirm: fixture('nj', 'roster-03_confirm.html').replace('$0.00', '$25.00') });

    const r = await createRegistriesStage({ only: NJ }).run(t.ctxFor(runId), i);

    expect(r.status).toEqual({ nj_hic_roster: 'error', nj_hic_detail: 'error', nj_principal_search: 'error' });
    expect(t.sleeps).toEqual([]);
    expect(seen.some((s) => s.path.startsWith('/Verification_Bulk/PrefDetails'))).toBe(false);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);
    expect(rosterFlows(t.calls())).toBe(1);
  });
});

/** A company of the run with a Google listing in `city`, as the pipeline stores it (painter, not out of area). */
async function runCompany(runId: number, over: { name: string; city: string; zip: string; websiteDomain?: string | null; inArea?: boolean | null; state?: string }): Promise<RegistryMatchInput> {
  const n = (await db.$client.query('SELECT count(*)::int AS n FROM listings')).rows[0].n as number;
  const l = await db.$client.query(
    `INSERT INTO listings (place_id, profile_url, name, city, zip, state) VALUES ($1, $2, $3, $4, $5, 'NJ') RETURNING id`,
    [`place-${n}`, `https://maps.example.test/${n}`, over.name, over.city, over.zip],
  );
  const c = await db.$client.query(
    `INSERT INTO companies (run_id, display_name, state, painter_status, in_area, primary_listing_id) VALUES ($1, $2, $3, 'painter', $4, $5) RETURNING id`,
    [runId, over.name, over.state ?? 'NJ', over.inArea === undefined ? true : over.inArea, l.rows[0].id],
  );
  const company = { companyId: c.rows[0].id as number, name: over.name, state: 'NJ' as const, city: over.city, zip: over.zip, street: null, websiteUrl: null, phoneE164: null, categories: ['Painter'] };
  return { company, emails: [], licenceNumbers: [], websiteDomain: over.websiteDomain ?? null };
}

const fordsRoster = `${fixture('nj', 'nj-roster-synthetic.txt').split('\n')[0]}\nZORBLAT PAINTING CO INC|||||Home Improvement Contractors|Home Improvement Business Contr|13VH90000099|1/1/2020|3/31/2027|900 Quux Road||Fords|NJ||Middlesex|info@zorblat-example.test|Active|\n`;

describe('NJ roster: every town of the run is loaded, whichever company comes first', () => {
  it('(e) an Edison listing is matched to a registration in Fords when another company of the run is in Fords, even if it is processed first', async () => {
    const t = setup();
    const runId = await edisonRun();
    const first = await runCompany(runId, { name: 'Zorblat Painting Company', city: 'Edison', zip: '08837', websiteDomain: 'zorblat-example.test' });
    await runCompany(runId, { name: 'Some Fords Painter', city: 'Fords', zip: '08863' });
    mockRosterFlow(t.agent); // Edison, the company's own town
    mockRosterFlow(t.agent, { roster: fordsRoster }); // Fords, from the other company of the run

    const r = await createRegistriesStage({ only: NJ, offline: false }).run(t.ctxFor(runId), first);

    expect(rosterFlows(t.calls())).toBe(2);
    expect((await rosterRows()).map((x) => x.city)).toEqual(['EDISON', 'FORDS']);
    expect(r.status.nj_hic_roster).toBe('matched');
    expect((await db.$client.query(`SELECT m.rung, r.source_key FROM registry_matches m JOIN registry_records r ON r.id = m.registry_record_id WHERE m.company_id = $1`, [first.company.companyId])).rows).toEqual([
      { rung: 'email_domain', source_key: '13VH90000099' },
    ]);
  });

  it('(e) towns of companies that are out of area, not painters of this run or in another state are not pulled', async () => {
    const t = setup();
    const runId = await edisonRun();
    const first = await runCompany(runId, { name: 'Nobody Painting', city: 'Edison', zip: '08837' });
    await runCompany(runId, { name: 'Far Away Painter', city: 'Iselin', zip: '08830', inArea: false });
    await runCompany(runId, { name: 'Texas Painter', city: 'Austin', zip: '78701', state: 'TX' });
    mockRosterFlow(t.agent); // Edison only

    const r = await createRegistriesStage({ only: NJ }).run(t.ctxFor(runId), first);

    expect(rosterFlows(t.calls())).toBe(1);
    expect(r.status.nj_hic_roster).toBe('no_match');
  });

  it('(e) a run town that cannot be pulled does not turn other towns\' companies into errors; the company keeps its own result', async () => {
    const t = setup();
    const runId = await edisonRun();
    const first = await runCompany(runId, { name: 'Nobody Painting', city: 'Edison', zip: '08837' });
    await runCompany(runId, { name: 'Some Fords Painter', city: 'Fords', zip: '08863' });
    mockRosterFlow(t.agent); // Edison
    mockRosterFlow(t.agent, { downloadListFails: true }); // Fords, first try
    mockRosterFlow(t.agent, { downloadListFails: true }); // Fords, retry

    const r = await createRegistriesStage({ only: NJ }).run(t.ctxFor(runId), first);

    expect(r.status.nj_hic_roster).toBe('no_match');
    expect((await statusOf(first.company.companyId)).nj_roster_skipped).toBeUndefined();
  });
});
