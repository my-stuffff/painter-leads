import type { EvidenceDraft, ReportResult } from '@pp/core';
import { planSearches } from '../src/plan';
import { qualifyRun } from '../src/qualify';
import { generateReport } from '../src/report/stage';
import { q } from '../src/sql';
import { FIXED_NOW, makeEnv, tempDir } from './helpers';
import { pointOf, prepareRun, seedListing, seedRun } from './seed';

type Env = ReturnType<typeof makeEnv>;

export interface Scenario {
  runId: number;
  base: string;
  report: ReportResult;
  ids: Map<string, number>;
}

/**
 * Eight companies that cover every rule the report shows: qualified (two on the exact thresholds), also commercial,
 * not a painter, rating/reviews not captured, a service-area business, a franchise location, hostile scraped text
 * and a rating one tenth below the line.
 */
export async function buildScenario(env: Env, over: { config?: Env['config'] } = {}): Promise<Scenario> {
  const config = over.config ?? env.config;
  const db = env.db;
  const runId = await seedRun(db);
  const sab = pointOf(config, 'edison_nj', '08820');

  await seedListing(db, env.evidence, runId, { key: 'alpha', name: 'Alpha Painting', rating: 4.8, reviews: 25, phone: '+17325550101', website: 'https://alphapainting.com', street: '1 Oak St', city: 'Edison', zip: '08817' });
  await seedListing(db, env.evidence, runId, { key: 'beta', name: 'Beta Commercial Painting', rating: 4.9, reviews: 30, phone: '+17325550102', street: '2 Elm St', city: 'Edison', zip: '08817' });
  await seedListing(db, env.evidence, runId, { key: 'gamma', name: 'Gamma Paint Supply', categories: ['Paint store'], rating: 4.8, reviews: 40, phone: '+17325550103', street: '3 Pine St', city: 'Edison', zip: '08820' });
  await seedListing(db, env.evidence, runId, { key: 'delta', name: 'Delta Painters', rating: null, reviews: null, phone: '+17325550104', street: '4 Fir St', city: 'Edison', zip: '08820' });
  await seedListing(db, env.evidence, runId, { key: 'epsilon', name: 'Epsilon Mobile Painting', rating: 4.7, reviews: 10, phone: '+17325550105', ...sab });
  await seedListing(db, env.evidence, runId, { key: 'certapro', name: 'CertaPro Painters of Edison', rating: 4.9, reviews: 99, phone: '+18005550106', website: 'https://certapro.com/edison', street: '6 Birch St', city: 'Edison', zip: '08837' });
  await seedListing(db, env.evidence, runId, { key: 'zeta', name: 'Zeta Painting', rating: 4.8, reviews: 20, phone: '+17325550107', website: 'javascript:alert(1)', street: '7 Ash St', city: 'Edison', zip: '08837' });
  await seedListing(db, env.evidence, runId, { key: 'eta', name: 'Eta Painting', rating: 4.6, reviews: 20, phone: '+17325550108', street: '8 Maple St', city: 'Edison', zip: '08837' });

  const ids = await prepareRun(env, runId, { residential: { 'Beta Commercial Painting': 'residential_and_commercial' } });
  const company = (name: string): number => ids.get(name) as number;

  const web = (field: EvidenceDraft['field'], companyName: string, value: string, over2: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
    companyId: company(companyName),
    field,
    value,
    sourceType: 'website',
    sourceUrl: 'https://alphapainting.com/contact',
    capturedAt: FIXED_NOW,
    snippet: value,
    extractor: 'seed-site',
    extractorVersion: '1',
    confidence: 'medium',
    ...over2,
  });

  await env.evidence.recordMany([
    web('owner_name', 'Alpha Painting', 'Jane Alpha', { sourceUrl: 'https://alphapainting.com/about', attrs: { title: 'Owner' } }),
    // two source families agree on this address, so core corroboration would have raised both rows to high
    web('email', 'Alpha Painting', 'info@alphapainting.com', { confidence: 'high', attrs: { kind: 'role' } }),
    web('email', 'Alpha Painting', 'INFO@alphapainting.com', { sourceType: 'nj_hic_roster', sourceUrl: 'https://newjersey.mylicense.com/seed/1', confidence: 'high', attrs: { kind: 'role' } }),
    web('nj_hic_number', 'Alpha Painting', '13VH00000100', { sourceType: 'nj_hic_roster', sourceUrl: 'https://newjersey.mylicense.com/seed/1', confidence: 'high' }),
    web('owner_name', 'Zeta Painting', '=HYPERLINK("http://evil.test","click")', { sourceUrl: 'https://zeta.test/about' }),
  ]);

  // Alpha was found by three searches (three ZIPs / terms): it must still be one company.
  const planned = await planSearches(db, config, 'edison_nj', 'pilot', runId);
  const searchIds = await q<{ id: number }>(db, `SELECT id FROM searches WHERE run_id = $1 ORDER BY position LIMIT 3`, [planned.runId]);
  const alphaListing = await q<{ id: number }>(db, `SELECT id FROM listings WHERE place_id = 'seed-alpha'`);
  for (const [i, s] of searchIds.entries()) {
    await q(db, `INSERT INTO search_hits (search_id, listing_id, position, is_new) VALUES ($1, $2, $3, $4)`, [s.id, alphaListing[0]?.id, i + 1, i === 0]);
  }

  await qualifyRun(db, config, runId);
  const base = tempDir();
  const report = await generateReport(db, config, runId, base);
  return { runId, base, report, ids };
}
