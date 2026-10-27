import {
  makeSnippet,
  schema,
  type CaptureStatus,
  type Db,
  type EvidenceDraft,
  type EvidenceStore,
  type Field,
} from '@pp/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CardSnapshot, PlaceSnapshot } from './driver/types';
import type { ParsedCard } from './parse/card';
import type { Captured } from './parse/field';
import type { ParsedPlace } from './parse/place';
import type { ParsedPlaceUrl } from './parse/url';
import { CARD_EXTRACTOR, PLACE_EXTRACTOR, VERSION } from './version';

export interface PersistCtx {
  db: Db;
  evidence: EvidenceStore;
  now(): Date;
}

export type ListingRow = typeof schema.listings.$inferSelect;
type ListingInsert = typeof schema.listings.$inferInsert;
type Source = 'card' | 'place';

/** A set of columns that is captured (or not) as one unit, plus the column that holds its capture status. */
interface Group {
  statusKey: string;
  status: CaptureStatus;
  set: Record<string, unknown>;
}

function cardGroups(c: ParsedCard): Group[] {
  const coordsStatus = c.lat.status === 'captured' ? c.lng.status : c.lat.status;
  return [
    {
      statusKey: 'categoryStatus',
      status: c.category.status,
      set: { categories: c.category.value ? [c.category.value] : [], categoryStatus: c.category.status },
    },
    { statusKey: 'ratingStatus', status: c.rating.status, set: { rating: c.rating.value, ratingStatus: c.rating.status } },
    {
      statusKey: 'reviewCountStatus',
      status: c.reviewCount.status,
      set: { reviewCount: c.reviewCount.value, reviewCountStatus: c.reviewCount.status },
    },
    { statusKey: 'phoneStatus', status: c.phone.status, set: { phoneE164: c.phone.value, phoneStatus: c.phone.status } },
    {
      statusKey: 'websiteStatus',
      status: c.website.status,
      set: { websiteUrl: c.website.value, websiteStatus: c.website.status },
    },
    {
      statusKey: 'coordsStatus',
      status: coordsStatus,
      set: { lat: c.lat.value, lng: c.lng.value, coordsStatus: coordsStatus },
    },
    {
      statusKey: 'closedStatus',
      status: c.permanentlyClosed.status,
      set: { permanentlyClosed: c.permanentlyClosed.value, closedStatus: c.permanentlyClosed.status },
    },
  ];
}

function placeGroups(p: ParsedPlace): Group[] {
  const coordsStatus = p.lat.status === 'captured' ? p.lng.status : p.lat.status;
  const a = p.address;
  const addrOk = a.full.status === 'captured';
  return [
    {
      statusKey: 'categoryStatus',
      status: p.categories.status,
      set: { categories: p.categories.value ?? [], categoryStatus: p.categories.status },
    },
    { statusKey: 'ratingStatus', status: p.rating.status, set: { rating: p.rating.value, ratingStatus: p.rating.status } },
    {
      statusKey: 'reviewCountStatus',
      status: p.reviewCount.status,
      set: { reviewCount: p.reviewCount.value, reviewCountStatus: p.reviewCount.status },
    },
    { statusKey: 'phoneStatus', status: p.phone.status, set: { phoneE164: p.phone.value, phoneStatus: p.phone.status } },
    {
      statusKey: 'websiteStatus',
      status: p.website.status,
      set: { websiteUrl: p.website.value, websiteStatus: p.website.status },
    },
    {
      statusKey: 'addressStatus',
      status: a.full.status,
      set: {
        addressFull: a.full.value,
        street: addrOk ? a.street : null,
        city: addrOk ? a.city : null,
        zip: addrOk ? a.zip : null,
        state: addrOk ? a.state : null,
        addressStatus: a.full.status,
      },
    },
    {
      statusKey: 'coordsStatus',
      status: coordsStatus,
      set: { lat: p.lat.value, lng: p.lng.value, coordsStatus: coordsStatus },
    },
    {
      statusKey: 'closedStatus',
      status: p.permanentlyClosed.status,
      set: { permanentlyClosed: p.permanentlyClosed.value, closedStatus: p.permanentlyClosed.status },
    },
  ];
}

/**
 * Which groups to write over an existing row.
 * - A captured value always replaces a not-captured one.
 * - A card never overwrites a value a place page already captured.
 * - A not-captured result never overwrites a captured value (a hidden count must not erase a real one).
 */
function applicableGroups(existing: ListingRow | null, source: Source, groups: Group[]): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const g of groups) {
    if (g.status === 'pending') continue;
    if (!existing) {
      Object.assign(set, g.set);
      continue;
    }
    const current = (existing as unknown as Record<string, unknown>)[g.statusKey] as CaptureStatus;
    if (g.status === 'captured') {
      if (source === 'card' && existing.detailStatus === 'done' && current === 'captured') continue;
      Object.assign(set, g.set);
    } else if (current !== 'captured' && (current === 'pending' || source === 'place')) {
      Object.assign(set, g.set);
    }
  }
  return set;
}

export async function findListing(db: Db, placeId: string | null, cid: string | null): Promise<ListingRow | null> {
  const { listings } = schema;
  if (placeId) {
    const [row] = await db.select().from(listings).where(eq(listings.placeId, placeId)).limit(1);
    if (row) return row;
  }
  if (cid) {
    const [row] = await db.select().from(listings).where(eq(listings.cid, cid)).limit(1);
    if (row) return row;
  }
  return null;
}

interface Incoming {
  source: Source;
  placeId: string | null;
  cid: string | null;
  profileUrl: string;
  name: string | null;
  street: string | null;
  groups: Group[];
  raw: unknown;
}

async function upsertListing(ctx: PersistCtx, runId: number, inc: Incoming): Promise<{ row: ListingRow; inserted: boolean }> {
  const { listings } = schema;
  let existing = await findListing(ctx.db, inc.placeId, inc.cid);
  const rawKey = inc.source === 'card' ? 'cardRaw' : 'placeRaw';
  if (!existing) {
    if (!inc.placeId && !inc.cid) throw new Error('listing has neither a place id nor a CID');
    if (!inc.name) throw new Error('listing has no name');
    const values: Record<string, unknown> = {
      placeId: inc.placeId,
      cid: inc.cid,
      profileUrl: inc.profileUrl,
      name: inc.name,
      street: inc.street,
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      [rawKey]: inc.raw,
      ...applicableGroups(null, inc.source, inc.groups),
    };
    // Two searches running at once can both find the same business: whoever inserts second gets no row back
    // (place_id and cid are unique) and updates the row the first one made instead.
    const [row] = await ctx.db
      .insert(listings)
      .values(values as ListingInsert)
      .onConflictDoNothing()
      .returning();
    if (row) return { row, inserted: true };
    existing = await findListing(ctx.db, inc.placeId, inc.cid);
    if (!existing) throw new Error('listing insert conflicted but no listing has its place id or CID');
  }
  const set: Record<string, unknown> = {
    lastSeenRunId: runId,
    [rawKey]: inc.raw,
    ...applicableGroups(existing, inc.source, inc.groups),
  };
  if (existing.cid === null && inc.cid) {
    const clash = await findListing(ctx.db, null, inc.cid);
    if (!clash) set.cid = inc.cid;
  }
  if (existing.placeId === null && inc.placeId) {
    const clash = await findListing(ctx.db, inc.placeId, null);
    if (!clash) set.placeId = inc.placeId;
  }
  if (inc.source === 'place' && inc.name) set.name = inc.name;
  if (inc.street && (existing.street === null || inc.source === 'place')) {
    if (!(inc.source === 'card' && existing.detailStatus === 'done')) set.street = inc.street;
  }
  const [row] = await ctx.db.update(listings).set(set as Partial<ListingInsert>).where(eq(listings.id, existing.id)).returning();
  if (!row) throw new Error('listing update returned no row');
  return { row, inserted: false };
}

/** Snippet from a URL around the piece an id/coordinate was read from. */
function urlSnippet(url: string, fragment: string | undefined): string {
  if (!fragment) return makeSnippet(url, 0, Math.min(url.length, 80));
  const at = url.indexOf(fragment);
  return makeSnippet(url, Math.max(0, at), fragment.length);
}

function draft(
  listingId: number,
  field: Field,
  value: string,
  snippet: string,
  sourceUrl: string,
  extractor: string,
  at: Date,
  attrs?: Record<string, unknown>,
): EvidenceDraft {
  return {
    listingId,
    field,
    value,
    sourceType: 'google_maps',
    sourceUrl,
    capturedAt: at,
    snippet: makeSnippet(snippet, 0, snippet.length, 900) || value,
    extractor,
    extractorVersion: VERSION,
    confidence: 'high',
    ...(attrs ? { attrs } : {}),
  };
}

function ids(
  listingId: number,
  url: ParsedPlaceUrl,
  href: string,
  sourceUrl: string,
  extractor: string,
  at: Date,
): EvidenceDraft[] {
  const out: EvidenceDraft[] = [];
  if (url.placeId) out.push(draft(listingId, 'place_id', url.placeId, urlSnippet(href, url.fragments.placeId), sourceUrl, extractor, at));
  if (url.cid) out.push(draft(listingId, 'cid', url.cid, urlSnippet(href, url.fragments.cid), sourceUrl, extractor, at));
  if (url.latText && url.fragments.lat) out.push(draft(listingId, 'lat', url.latText, urlSnippet(href, url.fragments.lat), sourceUrl, extractor, at));
  if (url.lngText && url.fragments.lng) out.push(draft(listingId, 'lng', url.lngText, urlSnippet(href, url.fragments.lng), sourceUrl, extractor, at));
  return out;
}

function pushCaptured<T>(
  out: EvidenceDraft[],
  listingId: number,
  field: Field,
  c: Captured<T>,
  toText: (v: T) => string,
  sourceUrl: string,
  extractor: string,
  at: Date,
): void {
  if (c.status === 'captured' && c.value !== null && c.snippet) {
    out.push(draft(listingId, field, toText(c.value), c.snippet, sourceUrl, extractor, at));
  }
}

export function cardEvidence(listingId: number, c: ParsedCard, raw: CardSnapshot, sourceUrl: string, at: Date): EvidenceDraft[] {
  const out: EvidenceDraft[] = [];
  if (c.name) out.push(draft(listingId, 'company_name', c.name, c.nameSnippet ?? c.name, sourceUrl, CARD_EXTRACTOR, at));
  out.push(...ids(listingId, c.url, raw.href, sourceUrl, CARD_EXTRACTOR, at));
  const str = (v: string) => v;
  pushCaptured(out, listingId, 'category', c.category, str, sourceUrl, CARD_EXTRACTOR, at);
  pushCaptured(out, listingId, 'street', c.street, str, sourceUrl, CARD_EXTRACTOR, at);
  pushCaptured(out, listingId, 'rating', c.rating, (v) => String(v), sourceUrl, CARD_EXTRACTOR, at);
  pushCaptured(out, listingId, 'review_count', c.reviewCount, (v) => String(v), sourceUrl, CARD_EXTRACTOR, at);
  pushCaptured(out, listingId, 'phone', c.phone, str, sourceUrl, CARD_EXTRACTOR, at);
  pushCaptured(out, listingId, 'website', c.website, str, sourceUrl, CARD_EXTRACTOR, at);
  pushCaptured(out, listingId, 'permanently_closed', c.permanentlyClosed, (v) => String(v), sourceUrl, CARD_EXTRACTOR, at);
  return out;
}

export function placeEvidence(listingId: number, p: ParsedPlace, raw: PlaceSnapshot, sourceUrl: string, at: Date): EvidenceDraft[] {
  const out: EvidenceDraft[] = [];
  const x = PLACE_EXTRACTOR;
  if (p.name) out.push(draft(listingId, 'company_name', p.name, p.name, sourceUrl, x, at));
  out.push(...ids(listingId, p.url, raw.url, sourceUrl, x, at));
  const str = (v: string) => v;
  if (p.categories.status === 'captured' && p.categories.value) {
    for (const cat of p.categories.value) out.push(draft(listingId, 'category', cat, cat, sourceUrl, x, at));
  }
  pushCaptured(out, listingId, 'phone', p.phone, str, sourceUrl, x, at);
  pushCaptured(out, listingId, 'website', p.website, str, sourceUrl, x, at);
  pushCaptured(out, listingId, 'rating', p.rating, (v) => String(v), sourceUrl, x, at);
  pushCaptured(out, listingId, 'review_count', p.reviewCount, (v) => String(v), sourceUrl, x, at);
  pushCaptured(out, listingId, 'permanently_closed', p.permanentlyClosed, (v) => String(v), sourceUrl, x, at);
  const a = p.address;
  if (a.full.status === 'captured' && a.full.value && a.full.snippet) {
    out.push(draft(listingId, 'address', a.full.value, a.full.snippet, sourceUrl, x, at));
    if (a.street) out.push(draft(listingId, 'street', a.street, a.full.snippet, sourceUrl, x, at));
    if (a.city) out.push(draft(listingId, 'city', a.city, a.full.snippet, sourceUrl, x, at));
    if (a.state) out.push(draft(listingId, 'state', a.state, a.full.snippet, sourceUrl, x, at));
    if (a.zip) out.push(draft(listingId, 'zip', a.zip, a.full.snippet, sourceUrl, x, at));
  }
  return out;
}

/** Records only evidence this listing does not already hold (same field, extractor and value), so re-reads never duplicate rows. */
export async function recordNewEvidence(ctx: PersistCtx, listingId: number, drafts: EvidenceDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const { evidence } = schema;
  const extractors = [...new Set(drafts.map((d) => d.extractor))];
  const have = await ctx.db
    .select({ field: evidence.field, extractor: evidence.extractor, value: evidence.value })
    .from(evidence)
    .where(and(eq(evidence.listingId, listingId), inArray(evidence.extractor, extractors)));
  const seen = new Set(have.map((r) => `${r.field}\u0000${r.extractor}\u0000${r.value}`));
  const fresh: EvidenceDraft[] = [];
  for (const d of drafts) {
    const key = `${d.field}\u0000${d.extractor}\u0000${d.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(d);
  }
  await ctx.evidence.recordMany(fresh);
  return fresh.length;
}

export interface CardPersisted {
  listingId: number;
  inserted: boolean;
  /** First time this listing is seen in this run. */
  isNew: boolean;
}

/** Stores one search-result card: listing upsert, evidence rows, and the search_hits row (position is 1-based). */
export async function persistCard(
  ctx: PersistCtx,
  runId: number,
  searchId: number,
  position: number,
  snapshot: CardSnapshot,
  parsed: ParsedCard,
): Promise<CardPersisted | null> {
  if (!parsed.name || (!parsed.placeId && !parsed.cid)) return null;
  const { row, inserted } = await upsertListing(ctx, runId, {
    source: 'card',
    placeId: parsed.placeId,
    cid: parsed.cid,
    profileUrl: parsed.profileUrl,
    name: parsed.name,
    street: parsed.street.value,
    groups: cardGroups(parsed),
    raw: snapshot,
  });
  await recordNewEvidence(ctx, row.id, cardEvidence(row.id, parsed, snapshot, row.profileUrl, ctx.now()));
  const isNew = await firstSeenInRun(ctx.db, row.id, runId);
  await ctx.db
    .insert(schema.searchHits)
    .values({ searchId, listingId: row.id, position, isNew })
    .onConflictDoNothing({ target: [schema.searchHits.searchId, schema.searchHits.listingId] });
  return { listingId: row.id, inserted, isNew };
}

/** True when no search of this run has hit the listing yet. */
async function firstSeenInRun(db: Db, listingId: number, runId: number): Promise<boolean> {
  const { searchHits, searches } = schema;
  const rows = await db
    .select({ id: searchHits.id })
    .from(searchHits)
    .innerJoin(searches, eq(searches.id, searchHits.searchId))
    .where(and(eq(searchHits.listingId, listingId), eq(searches.runId, runId)))
    .limit(1);
  return rows.length === 0;
}

export type PlaceOutcome = 'done' | 'limited_view' | 'failed';

/**
 * Stores one place page read for an existing listing (detail stage), or creates the listing when a search
 * landed straight on a place page. Returns what the detail status became.
 */
export async function persistPlace(
  ctx: PersistCtx,
  runId: number,
  listing: ListingRow | null,
  snapshot: PlaceSnapshot,
  parsed: ParsedPlace,
): Promise<{ outcome: PlaceOutcome; listingId: number | null; inserted: boolean }> {
  const { listings } = schema;
  const now = ctx.now();
  if (!parsed.loaded) {
    if (!listing) return { outcome: 'failed', listingId: null, inserted: false };
    await ctx.db
      .update(listings)
      .set({ detailStatus: 'failed', detailAttempts: sql`${listings.detailAttempts} + 1`, lastCheckedAt: now })
      .where(eq(listings.id, listing.id));
    return { outcome: 'failed', listingId: listing.id, inserted: false };
  }
  const outcome: PlaceOutcome = parsed.limitedView ? 'limited_view' : 'done';
  const target = listing ?? (await findListing(ctx.db, parsed.placeId, parsed.cid));
  // A search that landed on a place page whose URL carries no place id or CID (or that shows no name) cannot be
  // tied to a business for sure: nothing is stored, the search is recorded as failed.
  if (!target && ((!parsed.placeId && !parsed.cid) || !parsed.name)) return { outcome: 'failed', listingId: null, inserted: false };
  const { row, inserted } = await upsertListing(ctx, runId, {
    source: 'place',
    placeId: parsed.placeId ?? target?.placeId ?? null,
    cid: parsed.cid ?? target?.cid ?? null,
    profileUrl: target?.profileUrl ?? parsed.profileUrl,
    name: parsed.name,
    street: null,
    groups: placeGroups(parsed),
    raw: snapshot,
  });
  await ctx.db
    .update(listings)
    .set({
      detailStatus: outcome === 'done' ? 'done' : 'limited_view',
      detailAttempts: sql`${listings.detailAttempts} + 1`,
      lastCheckedAt: now,
    })
    .where(eq(listings.id, row.id));
  await recordNewEvidence(ctx, row.id, placeEvidence(row.id, parsed, snapshot, row.profileUrl, now));
  return { outcome, listingId: row.id, inserted };
}
