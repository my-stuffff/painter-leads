import type { GoldenReplayers } from '@pp/core';
import type { CardSnapshot } from './driver/types';
import { parseCard } from './parse/card';

/** Golden replayer: a saved Maps card snapshot in, the values the card parser reads out (as the report would show them). */
export const mapsCard: GoldenReplayers['mapsCard'] = (snapshot) => {
  const c = parseCard(snapshot as CardSnapshot);
  return {
    name: c.name,
    rating: c.rating.value === null ? null : String(c.rating.value),
    review_count: c.reviewCount.value === null ? null : String(c.reviewCount.value),
    phone: c.phone.value,
    category: c.category.value,
    website: c.website.value,
  };
};
