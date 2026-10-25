import { registrableDomain, type PpConfig } from '@pp/core';

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface FranchiseFlag {
  franchise: boolean;
  brand: string | null;
}

/**
 * R7 / D-26: a listing belongs to a franchise brand when its name starts with a configured brand
 * (case-insensitive) or its website's registrable domain is a configured brand domain. Franchise
 * locations are never merged on a shared brand domain.
 */
export function flagFranchise(name: string, websiteUrl: string | null, config: PpConfig): FranchiseFlag {
  const n = squash(name);
  const { brands, domains } = config.franchise;
  for (const brand of brands) {
    const b = squash(brand);
    if (b.length > 0 && (n === b || n.startsWith(`${b} `))) return { franchise: true, brand };
  }
  if (websiteUrl) {
    const d = registrableDomain(websiteUrl).domain;
    if (d) {
      const idx = domains.findIndex((x) => x.toLowerCase() === d);
      if (idx !== -1) return { franchise: true, brand: brands[idx] ?? d };
    }
  }
  return { franchise: false, brand: null };
}
