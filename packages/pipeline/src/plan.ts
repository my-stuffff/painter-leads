import { getArea, type Db, type PpConfig } from '@pp/core';
import { q, q1 } from './sql';

export type SearchPhase = 'pilot' | 'expansion';

export interface PlanResult {
  runId: number;
  inserted: number;
  total: number;
}

/**
 * D-09 (amended): one searches row per (term, ZIP), term-major: all pilot ZIPs for term 1, then term 2 ...
 * Without a runId a new run (status planned, config snapshot) is created. With one, only the missing
 * (run, zip, term) rows are added, so re-planning is harmless.
 */
export async function planSearches(
  db: Db,
  config: PpConfig,
  areaId: string,
  phase: SearchPhase = 'pilot',
  runId?: number,
): Promise<PlanResult> {
  const area = getArea(config, areaId);
  let id = runId;
  if (id === undefined) {
    const created = await q1<{ id: number }>(
      db,
      `INSERT INTO runs (area_id, state, status, config_snapshot) VALUES ($1, $2, 'planned', $3::jsonb) RETURNING id`,
      [area.id, area.state, JSON.stringify(config)],
    );
    if (!created) throw new Error('could not create the run');
    id = created.id;
  }

  const zips = phase === 'pilot' ? area.pilotZctas : area.expansionZctas;
  const centres = new Map(area.allZctas.map((z) => [z.zcta, z] as const));
  const base = await q1<{ max: number | null }>(db, `SELECT MAX(position) AS max FROM searches WHERE run_id = $1`, [id]);
  let position = base?.max ?? 0;

  let inserted = 0;
  for (const term of config.search.terms) {
    for (const zip of zips) {
      position += 1;
      const centre = centres.get(zip);
      const res = await q<{ id: number }>(
        db,
        `INSERT INTO searches (run_id, area_id, zip, term, phase, position, query, center_lat, center_lng, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         ON CONFLICT (run_id, zip, term) DO NOTHING
         RETURNING id`,
        [id, area.id, zip, term, phase, position, `${term} ${zip}`, centre?.lat ?? null, centre?.lng ?? null],
      );
      if (res.length > 0) inserted += 1;
      else position -= 1;
    }
  }
  const total = await q1<{ n: string }>(db, `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1`, [id]);
  return { runId: id, inserted, total: Number(total?.n ?? 0) };
}
