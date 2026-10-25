import { getArea, type Db, type EvidenceDraft, type EvidenceStore, type PpConfig, type ResidentialLabel } from '@pp/core';
import { assignArea } from '../src/area';
import { runCompanyIds } from '../src/data';
import { applyPainterFilter } from '../src/filter';
import { mergeRun } from '../src/merge';
import { CLASSIFY_EXTRACTOR } from '../src/report/rows';
import { q, q1 } from '../src/sql';
import { FIXED_NOW, type makeEnv } from './helpers';

type Env = ReturnType<typeof makeEnv>;

export async function seedRun(db: Db, areaId = 'edison_nj', state: 'NJ' | 'TX' | 'CA' = 'NJ'): Promise<number> {
  const row = await q1<{ id: number }>(
    db,
    `INSERT INTO runs (area_id, state, status, config_snapshot, created_at) VALUES ($1, $2, 'running', '{}'::jsonb, $3) RETURNING id`,
    [areaId, state, FIXED_NOW],
  );
  return (row as { id: number }).id;
}

export interface SeedListing {
  key: string;
  name: string;
  categories?: string[];
  rating?: number | null;
  reviews?: number | null;
  /** E.164 */
  phone?: string | null;
  website?: string | null;
  street?: string | null;
  city?: string | null;
  zip?: string | null;
  state?: string;
  lat?: number | null;
  lng?: number | null;
  closed?: boolean;
}

export const profileOf = (key: string): string => `https://www.google.com/maps/place/seed-${key}`;

/** One listing plus its Google Maps evidence rows (a value only when it was given, so "not captured" stays NULL). */
export async function seedListing(db: Db, store: EvidenceStore, runId: number, s: SeedListing): Promise<number> {
  const rating = s.rating ?? null;
  const reviews = s.reviews ?? null;
  const phone = s.phone ?? null;
  const website = s.website ?? null;
  const street = s.street ?? null;
  const hasCoords = s.lat != null && s.lng != null;
  const full = street && s.city && s.zip ? `${street}, ${s.city}, ${s.state ?? 'NJ'} ${s.zip}` : null;
  const row = await q1<{ id: number }>(
    db,
    `INSERT INTO listings (place_id, profile_url, name, categories, category_status,
       rating, rating_status, review_count, review_count_status, phone_e164, phone_status,
       website_url, website_status, address_full, street, city, zip, state, address_status,
       lat, lng, coords_status, permanently_closed, closed_status, detail_status,
       first_seen_run_id, last_seen_run_id, first_seen_at, last_checked_at)
     VALUES ($1, $2, $3, $4::text[], 'captured',
       $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22, 'captured', 'done',
       $23, $23, $24, $24)
     RETURNING id`,
    [
      `seed-${s.key}`,
      profileOf(s.key),
      s.name,
      s.categories ?? ['Painter'],
      rating,
      rating === null ? 'limited_view' : 'captured',
      reviews,
      reviews === null ? 'limited_view' : 'captured',
      phone,
      phone ? 'captured' : 'not_shown',
      website,
      website ? 'captured' : 'not_shown',
      full,
      street,
      s.city ?? null,
      s.zip ?? null,
      s.state ?? 'NJ',
      full ? 'captured' : 'not_shown',
      hasCoords ? s.lat : null,
      hasCoords ? s.lng : null,
      hasCoords ? 'captured' : 'not_shown',
      s.closed ?? false,
      runId,
      FIXED_NOW,
    ],
  );
  const id = (row as { id: number }).id;

  const base = {
    listingId: id,
    sourceType: 'google_maps' as const,
    sourceUrl: profileOf(s.key),
    capturedAt: FIXED_NOW,
    extractor: 'seed',
    extractorVersion: '0',
    confidence: 'high' as const,
  };
  const draft = (field: EvidenceDraft['field'], value: string): EvidenceDraft => ({ ...base, field, value, snippet: `${s.name}: ${value}` });
  const drafts: EvidenceDraft[] = [draft('company_name', s.name), draft('permanently_closed', String(s.closed ?? false))];
  for (const c of s.categories ?? ['Painter']) drafts.push(draft('category', c));
  if (rating !== null) drafts.push(draft('rating', String(rating)));
  if (reviews !== null) drafts.push(draft('review_count', String(reviews)));
  if (phone) drafts.push(draft('phone', phone));
  if (website) drafts.push(draft('website', website));
  if (street) drafts.push(draft('street', street));
  if (full) drafts.push(draft('address', full));
  if (s.city && full) drafts.push(draft('city', s.city));
  if (s.zip && full) drafts.push(draft('zip', s.zip));
  if (full) drafts.push(draft('state', s.state ?? 'NJ'));
  await store.recordMany(drafts);
  return id;
}

export interface PrepareOptions {
  /** Residential label per company name; default residential_only for painters. */
  residential?: Record<string, ResidentialLabel>;
}

/** merge -> painter filter -> area -> residential decisions (each with one signal row), like the run does. */
export async function prepareRun(env: Env, runId: number, o: PrepareOptions = {}): Promise<Map<string, number>> {
  await mergeRun(env.db, env.evidence, env.config, runId);
  await applyPainterFilter(env.db, runId);
  await assignArea(env.db, env.evidence, env.config, runId, FIXED_NOW);

  const byName = new Map<string, number>();
  const ids = await runCompanyIds(env.db, runId);
  const rows = await q<{ id: number; display_name: string; painter_status: string }>(
    env.db,
    `SELECT id, display_name, painter_status FROM companies WHERE id = ANY($1::int[])`,
    [ids],
  );
  for (const c of rows) {
    byName.set(c.display_name, c.id);
    if (c.painter_status !== 'painter') continue;
    const label = o.residential?.[c.display_name] ?? 'residential_only';
    await q(env.db, `UPDATE companies SET residential_status = $2 WHERE id = $1`, [c.id, label]);
    await env.evidence.record({
      companyId: c.id,
      field: 'residential_signal',
      value: `residential: house painter`,
      sourceType: 'google_maps',
      sourceUrl: profileOf('x'),
      capturedAt: FIXED_NOW,
      snippet: `${c.display_name}: house painter`,
      extractor: CLASSIFY_EXTRACTOR,
      extractorVersion: '1',
      confidence: 'high',
      attrs: { label },
    });
  }
  return byName;
}

export function pointOf(config: PpConfig, areaId: string, zcta: string): { lat: number; lng: number } {
  const z = getArea(config, areaId).allZctas.find((x) => x.zcta === zcta);
  if (!z) throw new Error(`no ZCTA ${zcta} in ${areaId}`);
  return { lat: z.lat, lng: z.lng };
}
