import type { Db } from '@pp/core';
import { evidenceByCompany, listingsByCompany, loadCompanies, runCompanyIds } from './data';
import { q } from './sql';

export interface PainterDecision {
  status: 'painter' | 'not_painter' | 'unknown';
  /** The category that decided it (the painter category kept, or the non-painter category excluded). */
  category: string | null;
  reason: string;
}

const norm = (c: string): string => c.toLowerCase().replace(/\s+/g, ' ').trim();

const PAINTER_EXACT = new Set([
  'painter',
  'painters',
  'painting',
  'house painter',
  'painting contractor',
  'commercial painter',
  'interior painter',
  'exterior painter',
  'residential painter',
  'industrial painter',
  'painting service',
  'painting company',
]);

const NON_PAINTER_EXACT = new Set([
  'paint store',
  'paint shop',
  'paint supplier',
  'paint manufacturer',
  'art studio',
  'art school',
  'art center',
  'art class',
  'painting lessons',
  'painting class',
  'paint and sip studio',
  'paint & sip studio',
  'auto body shop',
  'auto painting',
  'auto paint shop',
  'car detailing service',
  'car detailing',
  'mural artist',
  'muralist',
  'artist',
  'wallpaper store',
  'wallpaper installer',
  'wallpaper hanger',
  'interior designer',
  'interior decorator',
]);

/**
 * Any category naming a studio, pottery / ceramics or a paint-and-sip / paint party is a place to paint for fun,
 * never a painting contractor ("Painting studio" would otherwise match the /^painting\b/ painter rule).
 */
const NON_PAINTER_PATTERN =
  /\bwallpaper\b|\bmural|\bauto (?:body|paint)|\bcar (?:paint|detail)|\bart (?:studio|school|center|class)|\bpaint (?:store|shop|supplier|manufactur)|\bpaint(?:ing)? (?:lesson|class)|paint (?:and|&) sip|\bpaint(?:ing)? part(?:y|ies)\b|\bstudios?\b|\bpotter(?:y|s)\b|\bceramics?\b|\binterior (?:design|decorat)/;

const CONTRACTOR_TYPES = new Set([
  'contractor',
  'general contractor',
  'handyman',
  'handyperson',
  'drywall contractor',
  'remodeler',
  'home improvement contractor',
  'construction company',
  'renovation contractor',
  'kitchen remodeler',
  'stucco contractor',
  'plastering contractor',
  'home builder',
]);

function isNonPainterCategory(c: string): boolean {
  const n = norm(c);
  return NON_PAINTER_EXACT.has(n) || NON_PAINTER_PATTERN.test(n);
}

function isPainterCategory(c: string): boolean {
  const n = norm(c);
  if (isNonPainterCategory(n)) return false;
  return PAINTER_EXACT.has(n) || /\bpainters?\b/.test(n) || /^painting\b/.test(n);
}

/**
 * R6 / D-24. Keep when any category is a painter category, or the name says paint/coating and a category is a
 * contractor type. Otherwise a non-painter category marks it 'not a painting contractor' (that category is the
 * reason); anything else stays 'unknown' (kept for review, never qualified).
 */
export function classifyPainter(categories: string[], name: string): PainterDecision {
  const cats = categories.map((c) => c.trim()).filter((c) => c.length > 0);

  const painterCat = cats.find(isPainterCategory);
  if (painterCat) return { status: 'painter', category: painterCat, reason: `category "${painterCat}"` };

  if (/paint|coating/i.test(name)) {
    const contractor = cats.find((c) => CONTRACTOR_TYPES.has(norm(c)));
    if (contractor) {
      return { status: 'painter', category: contractor, reason: `name "${name}" with contractor category "${contractor}"` };
    }
  }

  const nonPainter = cats.find(isNonPainterCategory);
  if (nonPainter) {
    return { status: 'not_painter', category: nonPainter, reason: `category "${nonPainter}" is not a painting contractor` };
  }

  return {
    status: 'unknown',
    category: null,
    reason: cats.length === 0 ? 'no category captured' : `categories not recognised: ${cats.join(', ')}`,
  };
}

export interface FilterCounts {
  painter: number;
  notPainter: number;
  unknown: number;
  /** category strings of 'unknown' companies with how many companies carried each (Summary lists them). */
  unrecognised: Record<string, number>;
}

/** Applies classifyPainter to every company of the run (all categories of all its listings). */
export async function applyPainterFilter(db: Db, runId: number): Promise<FilterCounts> {
  const ids = await runCompanyIds(db, runId);
  const companies = await loadCompanies(db, ids);
  const listings = await listingsByCompany(db, ids);
  const evidence = await evidenceByCompany(db, ids);
  const counts: FilterCounts = { painter: 0, notPainter: 0, unknown: 0, unrecognised: {} };

  for (const c of companies) {
    const categories = new Set<string>();
    for (const l of listings.get(c.id) ?? []) for (const cat of l.categories) categories.add(cat);
    for (const e of evidence.get(c.id) ?? []) {
      if (e.field === 'category' && e.status === 'accepted') categories.add(e.value);
    }
    const d = classifyPainter([...categories], c.displayName);
    await q(
      db,
      `UPDATE companies SET painter_status = $2, painter_reason = $3, painter_category = $4, updated_at = now() WHERE id = $1`,
      [c.id, d.status, d.reason, d.category],
    );
    if (d.status === 'painter') counts.painter += 1;
    else if (d.status === 'not_painter') counts.notPainter += 1;
    else {
      counts.unknown += 1;
      for (const cat of categories.size > 0 ? categories : ['(no category captured)']) {
        counts.unrecognised[cat] = (counts.unrecognised[cat] ?? 0) + 1;
      }
    }
  }
  return counts;
}
