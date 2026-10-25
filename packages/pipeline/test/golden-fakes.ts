import { normaliseBusinessName, type GoldenReplayers, type ResidentialLabel } from '@pp/core';

const text = (pages: { html: string }[]): string => pages.map((p) => p.html).join('\n');

/** Small, correct stand-ins for the sites / maps / registries replayers, enough for the synthetic cases. */
export function correctReplayers(): GoldenReplayers {
  return {
    mapsCard: (snapshot) => {
      const s = (snapshot ?? {}) as Record<string, string | null>;
      return { name: s.name ?? null, rating: s.rating ?? null, review_count: s.review_count ?? null, phone: s.phone ?? null, category: s.category ?? null, website: s.website ?? null };
    },
    emails: (pages) => [...new Set([...text(pages).matchAll(/mailto:([^"'>\s]+)/gi)].map((m) => m[1] as string))],
    owners: (pages) =>
      [...text(pages).matchAll(/Meet ([A-Z][a-z]+ [A-Z][a-z]+), owner/g)].map((m) => ({ name: m[1] as string, title: 'Owner', confidence: 'medium' as const })),
    residential: ({ pages }) => {
      const label: ResidentialLabel = /commercial/i.test(text(pages)) ? 'residential_and_commercial' : 'residential_only';
      return { label, signals: [], reason: 'synthetic' };
    },
    registryMatch: ({ company, candidates }) =>
      (candidates as { sourceKey: string; legalName: string }[])
        .filter((c) => normaliseBusinessName(c.legalName).norm === normaliseBusinessName(company.name).norm)
        .map((c) => ({ sourceKey: c.sourceKey, strength: 'strong' as const })),
  };
}
