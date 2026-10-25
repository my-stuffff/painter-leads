import path from 'node:path';
import type { Db } from '@pp/core';
import { q } from './sql';
import { csvText, writeFileAtomic } from './report/csv';

export interface YieldRow {
  key: string;
  searches: number;
  cards: number;
  newCompanies: number;
}

export interface YieldResult {
  terms: YieldRow[];
  zips: YieldRow[];
}

/**
 * D-09: how many NEW companies each search term and each ZIP added. Searches are walked in plan order
 * (term-major) and a company counts only where it was first seen, so the numbers add up to the company total.
 */
export async function computeYields(db: Db, runId: number): Promise<YieldResult> {
  const searches = await q<{ id: number; zip: string; term: string; cards_found: number | null }>(
    db,
    `SELECT id, zip, term, cards_found FROM searches WHERE run_id = $1 ORDER BY position, id`,
    [runId],
  );
  const hits = await q<{ search_id: number; listing_id: number; company_id: number | null }>(
    db,
    `SELECT h.search_id, h.listing_id, l.company_id
       FROM search_hits h JOIN searches s ON s.id = h.search_id JOIN listings l ON l.id = h.listing_id
      WHERE s.run_id = $1 ORDER BY s.position, h.position, h.id`,
    [runId],
  );
  const hitsBySearch = new Map<number, typeof hits>();
  for (const h of hits) {
    const list = hitsBySearch.get(h.search_id);
    if (list) list.push(h);
    else hitsBySearch.set(h.search_id, [h]);
  }

  const terms = new Map<string, YieldRow>();
  const zips = new Map<string, YieldRow>();
  const bump = (m: Map<string, YieldRow>, key: string, cards: number, fresh: number): void => {
    const row = m.get(key) ?? { key, searches: 0, cards: 0, newCompanies: 0 };
    row.searches += 1;
    row.cards += cards;
    row.newCompanies += fresh;
    m.set(key, row);
  };

  const seen = new Set<string>();
  for (const s of searches) {
    const own = hitsBySearch.get(s.id) ?? [];
    let fresh = 0;
    for (const h of own) {
      const key = h.company_id !== null ? `c${h.company_id}` : `l${h.listing_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        fresh += 1;
      }
    }
    const cards = s.cards_found ?? own.length;
    bump(terms, s.term, cards, fresh);
    bump(zips, s.zip, cards, fresh);
  }
  return { terms: [...terms.values()], zips: [...zips.values()] };
}

export function yieldLines(r: YieldResult): string[] {
  const fmt = (kind: string, row: YieldRow): string =>
    `${kind.padEnd(5)} ${row.key.padEnd(26)} searches ${String(row.searches).padStart(3)}  cards ${String(row.cards).padStart(4)}  new companies ${String(row.newCompanies).padStart(4)}`;
  return [...r.terms.map((t) => fmt('term', t)), ...r.zips.map((z) => fmt('zip', z))];
}

export async function writeYieldCsv(dir: string, r: YieldResult): Promise<string> {
  const file = path.join(dir, 'yield.csv');
  const rows = [
    ...r.terms.map((t) => ['term', t.key, t.searches, t.cards, t.newCompanies]),
    ...r.zips.map((z) => ['zip', z.key, z.searches, z.cards, z.newCompanies]),
  ];
  await writeFileAtomic(file, csvText(['kind', 'key', 'searches', 'cards', 'new_companies'], rows));
  return file;
}
