import { getArea, type Db, type EvidenceRow, type PpConfig } from '@pp/core';
import {
  computeFacts,
  decideArea,
  evidenceByCompany,
  listingsByCompany,
  loadCompanies,
  policyFor,
  qualify,
  selectLatest,
  toEvidence,
  type ReportCompany,
} from '@pp/pipeline';
import { q, q1 } from './sql';

/**
 * companies.in_area is one flag per company, written by the area step of the LAST run that reached the company.
 * A company on the border of two cities (found by the Dallas and the Plano searches) is therefore judged against
 * whichever city ran last, and the other city's report changes after the fact (this is why the stored data no
 * longer gives the 28 Oct counts). For a job's export each city must be judged against its own area, exactly as its
 * own run did when it finished: the same decideArea rule assignArea uses, with the same inputs, without writing.
 *
 * Returns the in-area decision of this run's area for each company id.
 */
export async function inAreaForRun(db: Db, config: PpConfig, runId: number, areaId: string, ids: number[]): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  if (ids.length === 0) return out;
  const area = getArea(config, areaId);
  const expansion = await q1<{ n: string }>(db, `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1 AND phase = 'expansion'`, [runId]);
  const expansionActive = Number(expansion?.n ?? 0) > 0;
  const policy = policyFor(config);

  const zips = new Map<number, EvidenceRow[]>();
  for (const raw of await q(db, `SELECT * FROM evidence WHERE company_id = ANY($1::int[]) AND field = 'zip' ORDER BY id`, [ids])) {
    const e = toEvidence(raw);
    const list = zips.get(e.companyId as number);
    if (list) list.push(e);
    else zips.set(e.companyId as number, [e]);
  }
  const listings = new Map<number, { zip: string | null; lat: number | null; lng: number | null }[]>();
  for (const l of await q<{ company_id: number; zip: string | null; lat: number | null; lng: number | null }>(
    db,
    `SELECT company_id, zip, lat, lng FROM listings WHERE company_id = ANY($1::int[]) ORDER BY id`,
    [ids],
  )) {
    const list = listings.get(l.company_id);
    const row = { zip: l.zip, lat: l.lat === null ? null : Number(l.lat), lng: l.lng === null ? null : Number(l.lng) };
    if (list) list.push(row);
    else listings.set(l.company_id, [row]);
  }

  for (const id of ids) {
    const ls = listings.get(id) ?? [];
    const first = <K extends 'zip' | 'lat' | 'lng'>(k: K) => (ls.map((l) => l[k]).find((v) => v !== null && v !== undefined) ?? null) as
      | (typeof ls)[number][K]
      | null;
    const zipRow = selectLatest(zips.get(id) ?? [], 'zip', policy);
    const decision = decideArea(area, { zip: zipRow?.value ?? first('zip'), lat: first('lat'), lng: first('lng') }, expansionActive);
    out.set(id, decision.inArea);
  }
  return out;
}

/**
 * Re-judges the report companies whose stored in_area differs from this run's own area decision (see inAreaForRun):
 * the same computeFacts + qualify, with in_area as this run decides it. Returns the companies with qualified and
 * reasons replaced where they changed; nothing is written.
 */
export async function judgeAgainstRunArea(
  db: Db,
  config: PpConfig,
  runId: number,
  areaId: string,
  companies: ReportCompany[],
): Promise<ReportCompany[]> {
  const ids = companies.map((c) => c.companyId);
  const decided = await inAreaForRun(db, config, runId, areaId, ids);
  const stored = new Map(
    (await q<{ id: number; in_area: boolean | null }>(db, `SELECT id, in_area FROM companies WHERE id = ANY($1::int[])`, [ids])).map(
      (r) => [r.id, r.in_area !== false] as const,
    ),
  );
  const changed = ids.filter((id) => decided.has(id) && decided.get(id) !== stored.get(id));
  if (changed.length === 0) return companies;

  const rows = await loadCompanies(db, changed);
  const listings = await listingsByCompany(db, changed);
  const evidence = await evidenceByCompany(db, changed);
  const verdict = new Map<number, { qualified: boolean; reasons: ReportCompany['reasons'] }>();
  for (const c of rows) {
    const facts = computeFacts({ ...c, inArea: decided.get(c.id) ?? c.inArea }, listings.get(c.id) ?? [], evidence.get(c.id) ?? [], config);
    verdict.set(c.id, qualify(facts, config));
  }
  return companies.map((c) => {
    const v = verdict.get(c.companyId);
    return v ? { ...c, qualified: v.qualified, reasons: v.reasons } : c;
  });
}
