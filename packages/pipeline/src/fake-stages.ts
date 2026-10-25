import {
  createFakeStages,
  getArea,
  type AreaDef,
  type CompanyRef,
  type EvidenceDraft,
  type ResidentialDecision,
  type StageContext,
  type StageRegistry,
  type StopInfo,
} from '@pp/core';
import { loadRun } from './data';
import { q, q1 } from './sql';

/**
 * Deterministic stand-ins for the stages of maps / sites / registries that write real rows, so a whole run
 * (merge, filter, area, qualify, report) can be exercised end to end before those packages exist (D-33).
 * core's createFakeStages() records evidence for listing ids it never inserts, which a real database refuses,
 * so discover, detail, site-enrich and classify are re-done here; site-finalize and registries-match come from core.
 */
export interface FakeStageOptions {
  /** Stops the first discover call with a fake block after this many searches (resume tests). */
  blockAfterSearches?: number;
}

interface FakeCompany {
  key: string;
  name: string;
  categories: string[];
  rating: number | null;
  reviews: number | null;
  zip: number | 'expansion';
  sab?: boolean;
  website?: string;
}

const TEMPLATES: FakeCompany[] = [
  { key: 'one', name: 'Fake Painting One', categories: ['Painter'], rating: 4.9, reviews: 25, zip: 0, website: 'https://fakepainting-one.test' },
  { key: 'two', name: 'Fake Painting Two', categories: ['Painter'], rating: 4.1, reviews: 25, zip: 0, website: 'https://fakepainting-two.test' },
  { key: 'store', name: 'Fake Paint Depot', categories: ['Paint store'], rating: 4.8, reviews: 30, zip: 1 },
  { key: 'limited', name: 'Fake Painters Limited View', categories: ['House painter'], rating: null, reviews: null, zip: 1 },
  { key: 'sab', name: 'Fake Service Area Painting', categories: ['Painter'], rating: 4.8, reviews: 40, zip: 0, sab: true },
  { key: 'commercial', name: 'Fake Commercial Coatings', categories: ['Painting contractor'], rating: 4.9, reviews: 50, zip: 2, website: 'https://fakecoatings.test' },
  { key: 'expansion', name: 'Fake Expansion Painting', categories: ['Painter'], rating: 4.8, reviews: 20, zip: 'expansion' },
];

function zipOf(area: AreaDef, t: FakeCompany): string | null {
  if (t.zip === 'expansion') return area.expansionZctas[0] ?? null;
  return area.pilotZctas[t.zip % area.pilotZctas.length] ?? null;
}

const profileUrl = (area: AreaDef, t: FakeCompany): string => `https://www.google.com/maps/place/fake-${area.id}-${t.key}`;

export function createDbFakeStages(opts: FakeStageOptions = {}): StageRegistry {
  const core = createFakeStages();
  let blockPending = opts.blockAfterSearches !== undefined;

  async function ensureListings(ctx: StageContext, area: AreaDef): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    for (const t of TEMPLATES) {
      const zip = zipOf(area, t);
      if (!zip) continue;
      const centre = area.allZctas[0];
      const url = profileUrl(area, t);
      const street = t.sab ? null : `${100 + ids.size} Fake Street`;
      const full = street ? `${street}, ${area.city}, ${area.state} ${zip}` : null;
      const limited = t.rating === null;
      const row = await q1<{ id: number; inserted: boolean }>(
        ctx.db,
        `INSERT INTO listings (place_id, profile_url, name, categories, category_status,
           rating, rating_status, review_count, review_count_status,
           phone_e164, phone_status, website_url, website_status,
           address_full, street, city, zip, state, address_status,
           lat, lng, coords_status, permanently_closed, closed_status,
           detail_status, first_seen_run_id, last_seen_run_id, first_seen_at)
         VALUES ($1, $2, $3, $4::text[], 'captured',
           $5, $6, $7, $8,
           $9, 'captured', $10, $11,
           $12, $13, $14, $15, $16, $17,
           $18, $19, 'captured', false, 'captured',
           $20, $21, $21, now())
         ON CONFLICT (place_id) DO UPDATE SET last_seen_run_id = EXCLUDED.last_seen_run_id
         RETURNING id, (xmax = 0) AS inserted`,
        [
          `fake-${area.id}-${t.key}`,
          url,
          t.name,
          t.categories,
          t.rating,
          limited ? 'limited_view' : 'captured',
          t.reviews,
          limited ? 'limited_view' : 'captured',
          `+1732555${String(1000 + ids.size).slice(-4)}`,
          t.website ?? null,
          t.website ? 'captured' : 'not_shown',
          full,
          street,
          area.city,
          t.sab ? null : zip,
          area.state,
          full ? 'captured' : 'not_shown',
          centre?.lat ?? 40.5,
          centre?.lng ?? -74.4,
          limited ? 'limited_view' : 'pending',
          ctx.runId,
        ],
      );
      if (!row) continue;
      ids.set(t.key, row.id);
      if (row.inserted) {
        const base = {
          listingId: row.id,
          sourceType: 'google_maps' as const,
          sourceUrl: url,
          capturedAt: ctx.now(),
          extractor: 'fake-discover',
          extractorVersion: '0',
          confidence: 'high' as const,
        };
        const drafts: EvidenceDraft[] = [
          { ...base, field: 'company_name' as const, value: t.name, snippet: t.name },
          ...t.categories.map((c) => ({ ...base, field: 'category' as const, value: c, snippet: `${t.name} · ${c}` })),
          { ...base, field: 'permanently_closed' as const, value: 'false', snippet: `${t.name} open` },
          { ...base, field: 'city' as const, value: area.city, snippet: `${t.name} ${area.city}` },
          { ...base, field: 'state' as const, value: area.state, snippet: `${t.name} ${area.state}` },
        ];
        if (t.rating !== null) drafts.push({ ...base, field: 'rating' as const, value: String(t.rating), snippet: `${t.name} ${t.rating} stars` });
        if (t.reviews !== null) drafts.push({ ...base, field: 'review_count' as const, value: String(t.reviews), snippet: `${t.name} ${t.reviews} reviews` });
        const phoneRow = await q1<{ phone_e164: string }>(ctx.db, `SELECT phone_e164 FROM listings WHERE id = $1`, [row.id]);
        if (phoneRow) drafts.push({ ...base, field: 'phone' as const, value: phoneRow.phone_e164, snippet: `${t.name} ${phoneRow.phone_e164}` });
        if (t.website) drafts.push({ ...base, field: 'website' as const, value: t.website, snippet: `${t.name} ${t.website}` });
        if (street && full) {
          drafts.push({ ...base, field: 'street' as const, value: street, snippet: full });
          drafts.push({ ...base, field: 'address' as const, value: full, snippet: full });
          drafts.push({ ...base, field: 'zip' as const, value: zip, snippet: full });
        }
        await ctx.evidence.recordMany(drafts);
      }
    }
    return ids;
  }

  return {
    ...core,
    discover: {
      name: 'discover',
      async run(ctx, input) {
        const run = await loadRun(ctx.db, input.runId);
        const area = getArea(ctx.config, run.areaId);
        const listingIds = await ensureListings(ctx, area);
        const pending = await q<{ id: number; zip: string }>(
          ctx.db,
          `SELECT id, zip FROM searches WHERE run_id = $1 AND status <> 'done' ORDER BY position`,
          [input.runId],
        );

        let handled = 0;
        let cards = 0;
        let newListings = 0;
        for (const s of pending) {
          if (blockPending && opts.blockAfterSearches !== undefined && handled >= opts.blockAfterSearches) {
            blockPending = false;
            await q(ctx.db, `UPDATE searches SET status = 'blocked', block_signal = 'sorry' WHERE id = $1`, [s.id]);
            const stopped: StopInfo = { signal: 'sorry', searchId: s.id, listingId: null, at: ctx.now(), detail: 'fake block' };
            return { searchesDone: handled, searchesRemaining: pending.length - handled, cardsSeen: cards, newListings, stopped };
          }
          let position = 0;
          let fresh = 0;
          for (const t of TEMPLATES) {
            if (zipOf(area, t) !== s.zip) continue;
            const listingId = listingIds.get(t.key);
            if (listingId === undefined) continue;
            position += 1;
            const seen = await q1<{ n: string }>(
              ctx.db,
              `SELECT COUNT(*) AS n FROM search_hits h JOIN searches x ON x.id = h.search_id WHERE x.run_id = $1 AND h.listing_id = $2`,
              [input.runId, listingId],
            );
            const isNew = Number(seen?.n ?? 0) === 0;
            await q(
              ctx.db,
              `INSERT INTO search_hits (search_id, listing_id, position, is_new) VALUES ($1, $2, $3, $4)
               ON CONFLICT (search_id, listing_id) DO NOTHING`,
              [s.id, listingId, position, isNew],
            );
            if (isNew) fresh += 1;
          }
          await q(
            ctx.db,
            `UPDATE searches SET status = 'done', attempts = attempts + 1, cards_found = $2, new_place_ids = $3,
               end_reached = true, started_at = $4, finished_at = $4 WHERE id = $1`,
            [s.id, position, fresh, ctx.now()],
          );
          handled += 1;
          cards += position;
          newListings += fresh;
        }
        return { searchesDone: handled, searchesRemaining: 0, cardsSeen: cards, newListings, stopped: null };
      },
    },
    detail: {
      name: 'detail',
      async run(ctx, input) {
        const rows = await q<{ id: number; rating_status: string }>(
          ctx.db,
          `SELECT l.id, l.rating_status FROM listings l WHERE l.detail_status = 'pending' AND l.id IN (
             SELECT h.listing_id FROM search_hits h JOIN searches s ON s.id = h.search_id WHERE s.run_id = $1)`,
          [input.runId],
        );
        for (const r of rows) {
          await q(ctx.db, `UPDATE listings SET detail_status = 'done', last_checked_at = $2 WHERE id = $1`, [r.id, ctx.now()]);
        }
        const limited = await q1<{ n: string }>(
          ctx.db,
          `SELECT COUNT(*) AS n FROM listings WHERE detail_status = 'limited_view' AND id IN (
             SELECT h.listing_id FROM search_hits h JOIN searches s ON s.id = h.search_id WHERE s.run_id = $1)`,
          [input.runId],
        );
        return { done: rows.length, limitedView: Number(limited?.n ?? 0), failed: 0, stopped: null };
      },
    },
    'site-enrich': {
      name: 'site-enrich',
      async run(ctx, company: CompanyRef) {
        if (!company.websiteUrl) {
          return { companyId: company.companyId, status: 'no_website', pages: [], emails: 0, owners: 0, licenceNumbers: [], residentialSignals: 0 };
        }
        const done = await q1<{ n: string }>(
          ctx.db,
          `SELECT COUNT(*) AS n FROM evidence WHERE company_id = $1 AND extractor = 'fake-site'`,
          [company.companyId],
        );
        let emails = 0;
        let owners = 0;
        if (Number(done?.n ?? 0) === 0) {
          const host = new URL(company.websiteUrl).hostname;
          const base = {
            companyId: company.companyId,
            sourceType: 'website' as const,
            sourceUrl: `${company.websiteUrl}/contact`,
            capturedAt: ctx.now(),
            extractor: 'fake-site',
            extractorVersion: '0',
            confidence: 'medium' as const,
          };
          await ctx.evidence.record({
            ...base,
            field: 'email',
            value: `info@${host}`,
            snippet: `Email us at info@${host}`,
            attrs: { kind: 'role', method: 'mailto' },
          });
          emails = 1;
          if (company.name.includes('One')) {
            await ctx.evidence.record({
              ...base,
              field: 'owner_name',
              value: 'Jane Fake',
              snippet: 'Meet Jane Fake, owner of Fake Painting One',
              attrs: { title: 'Owner' },
            });
            owners = 1;
          }
        }
        return { companyId: company.companyId, status: 'ok', pages: [], emails, owners, licenceNumbers: [], residentialSignals: 0 };
      },
    },
    classify: {
      name: 'classify',
      async run(ctx, input): Promise<ResidentialDecision> {
        const listing = await q1<{ profile_url: string }>(
          ctx.db,
          `SELECT profile_url FROM listings WHERE company_id = $1 ORDER BY id LIMIT 1`,
          [input.company.companyId],
        );
        const commercial = /commercial/i.test(input.company.name);
        return {
          label: commercial ? 'residential_and_commercial' : 'residential_only',
          reason: 'fake classifier (name and category)',
          signals: [
            {
              polarity: commercial ? 'commercial' : 'residential',
              id: commercial ? 'fake-name-commercial' : 'fake-category-painter',
              text: commercial ? 'commercial' : 'house painter',
              sourceType: 'google_maps',
              sourceUrl: listing?.profile_url ?? 'https://www.google.com/maps',
              snippet: input.company.name,
              strength: 'strong',
            },
          ],
        };
      },
    },
  };
}
