export type QueryForm = 'zip_text' | 'viewport';

/**
 * The query form the pilot uses. Decided by the live smoke in plan 01-02 (see 01-02-SUMMARY.md,
 * "Query form decision").
 */
export const QUERY_FORM: QueryForm = 'zip_text';

export interface SearchTarget {
  term: string;
  zip: string;
  centerLat?: number | null;
  centerLng?: number | null;
}

/** The Google Maps search URL for one (term, ZIP). English, US. */
export function buildSearchUrl(target: SearchTarget, form: QueryForm = QUERY_FORM): string {
  if (form === 'viewport') {
    if (target.centerLat == null || target.centerLng == null) {
      throw new Error(`viewport query needs centerLat/centerLng for ${target.zip}`);
    }
    return `https://www.google.com/maps/search/${encodeURIComponent(target.term)}/@${target.centerLat},${target.centerLng},13z?hl=en&gl=us`;
  }
  return `https://www.google.com/maps/search/${encodeURIComponent(`${target.term} ${target.zip}`)}/?hl=en&gl=us`;
}

/** A free-text query as typed into the Maps search box (used by the datacentre test). */
export function buildTextSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/?hl=en&gl=us`;
}
