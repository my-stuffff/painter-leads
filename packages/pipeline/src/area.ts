import { getArea, zctaForPoint, zip5, type AreaDef, type Db, type EvidenceStore, type PpConfig } from '@pp/core';
import { evidenceByCompany, listingsByCompany, loadCompanies, loadRun, runCompanyIds, type ListingRow } from './data';
import { policyFor, selectLatest } from './select/policy';
import { q, q1 } from './sql';

export type LocationPrecision = 'exact' | 'approximate' | 'unknown';

export interface AreaDecision {
  inArea: boolean;
  precision: LocationPrecision;
  /** The ZIP / ZCTA the decision used (never written as a ZIP value for a service-area business). */
  zip: string | null;
  derivedFromPin: boolean;
}

/** In the area = one of its ZCTAs or a listed PO-box ZIP; expansion ZCTAs only once the expansion phase ran. */
export function zipInArea(area: AreaDef, zip: string, expansionActive: boolean): boolean {
  return (
    area.allZctas.some((z) => z.zcta === zip) ||
    area.poBoxZips.includes(zip) ||
    (expansionActive && area.expansionZctas.includes(zip))
  );
}

/**
 * D-10: the address ZIP decides when shown (exact). A service-area business has no street address: its map
 * pin is placed into a ZCTA offline (approximate). No address and no pin = unknown, outside.
 */
export function decideArea(
  area: AreaDef,
  input: { zip: string | null; lat: number | null; lng: number | null },
  expansionActive: boolean,
  pointToZcta: (lat: number, lng: number) => string | null = zctaForPoint,
): AreaDecision {
  const zip = zip5(input.zip);
  if (zip) return { inArea: zipInArea(area, zip, expansionActive), precision: 'exact', zip, derivedFromPin: false };
  if (input.lat !== null && input.lng !== null) {
    const zcta = pointToZcta(input.lat, input.lng);
    if (zcta) {
      return { inArea: zipInArea(area, zcta, expansionActive), precision: 'approximate', zip: zcta, derivedFromPin: true };
    }
  }
  return { inArea: false, precision: 'unknown', zip: null, derivedFromPin: false };
}

export const AREA_EXTRACTOR = 'pipeline/area';

/** Assigns in_area / location_precision to every company of the run; service-area businesses also get a derived city + state row. */
export async function assignArea(
  db: Db,
  evidenceStore: EvidenceStore,
  config: PpConfig,
  runId: number,
  now: Date,
): Promise<{ inArea: number; outside: number; approximate: number }> {
  const run = await loadRun(db, runId);
  const area = getArea(config, run.areaId);
  const expansion = await q1<{ n: string }>(
    db,
    `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1 AND phase = 'expansion'`,
    [runId],
  );
  const expansionActive = Number(expansion?.n ?? 0) > 0;

  const ids = await runCompanyIds(db, runId);
  const companies = await loadCompanies(db, ids);
  const listings = await listingsByCompany(db, ids);
  const evidence = await evidenceByCompany(db, ids);
  const policy = policyFor(config);
  const out = { inArea: 0, outside: 0, approximate: 0 };

  for (const c of companies) {
    const ls = listings.get(c.id) ?? [];
    const rows = evidence.get(c.id) ?? [];
    const zipRow = selectLatest(rows, 'zip', policy);
    const first = <K extends keyof ListingRow>(k: K): ListingRow[K] | null =>
      (ls.map((l) => l[k]).find((v) => v !== null && v !== undefined) as ListingRow[K] | undefined) ?? null;
    const decision = decideArea(
      area,
      { zip: zipRow?.value ?? first('zip'), lat: first('lat'), lng: first('lng') },
      expansionActive,
    );
    await q(db, `UPDATE companies SET in_area = $2, location_precision = $3, updated_at = now() WHERE id = $1`, [
      c.id,
      decision.inArea,
      decision.precision,
    ]);
    if (decision.inArea) out.inArea += 1;
    else out.outside += 1;
    if (decision.precision === 'approximate') out.approximate += 1;

    if (decision.derivedFromPin && decision.inArea) {
      const profile = ls[0]?.profileUrl ?? '';
      const already = rows.some((r) => r.extractor === AREA_EXTRACTOR && r.status === 'accepted');
      if (!already && profile) {
        const snippet = `Map pin lies inside ZIP area ${decision.zip} (service-area business, no street address)`;
        const base = {
          companyId: c.id,
          sourceType: 'google_maps' as const,
          sourceUrl: profile,
          capturedAt: now,
          snippet,
          extractor: AREA_EXTRACTOR,
          extractorVersion: '1',
          confidence: 'medium' as const,
          attrs: { derived: 'pin-in-zcta', zcta: decision.zip },
        };
        await evidenceStore.recordMany([
          { ...base, field: 'city', value: area.city },
          { ...base, field: 'state', value: area.state },
        ]);
      }
    }
  }
  return out;
}
