import { DEFAULT_SELECTION_POLICY, selectBest } from '../evidence/select';
import type { EvidenceDraft } from '../evidence/store';
import type { ExclusionReason } from '../types';
import type { CompanyRef, ResidentialDecision, StageContext, StageRegistry } from './types';

interface FakeListing {
  id: number;
  name: string;
  rating: number;
  reviews: number;
  detailDone: boolean;
  companyId: number | null;
}

/**
 * Deterministic in-memory implementations of all nine stages, so the pipeline can be built before
 * the real packages merge. One registry instance keeps its own state: discover creates two
 * listings (one that meets the default thresholds, one that does not), detail marks them done,
 * merge creates one company per listing, qualify reads the evidence the fake discover recorded.
 */
export function createFakeStages(): StageRegistry {
  const listings: FakeListing[] = [];

  const draft = (
    ctx: StageContext,
    l: FakeListing,
    field: 'rating' | 'review_count',
    value: number,
  ): EvidenceDraft => ({
    listingId: l.id,
    field,
    value: String(value),
    sourceType: 'google_maps',
    sourceUrl: `https://www.google.com/maps/place/fake-${l.id}`,
    capturedAt: ctx.now(),
    snippet: `${l.name} ${value}`,
    extractor: 'fake-discover',
    extractorVersion: '0',
    confidence: 'high',
  });

  return {
    discover: {
      name: 'discover',
      async run(ctx) {
        if (listings.length === 0) {
          listings.push(
            { id: 1, name: 'Fake Painting One', rating: 4.9, reviews: 25, detailDone: false, companyId: null },
            { id: 2, name: 'Fake Painting Two', rating: 4.1, reviews: 25, detailDone: false, companyId: null },
          );
          for (const l of listings) {
            await ctx.evidence.recordMany([draft(ctx, l, 'rating', l.rating), draft(ctx, l, 'review_count', l.reviews)]);
          }
        }
        return { searchesDone: 1, searchesRemaining: 0, cardsSeen: listings.length, newListings: listings.length, stopped: null };
      },
    },
    detail: {
      name: 'detail',
      async run() {
        let done = 0;
        for (const l of listings) {
          if (!l.detailDone) {
            l.detailDone = true;
            done++;
          }
        }
        return { done, limitedView: 0, failed: 0, stopped: null };
      },
    },
    merge: {
      name: 'merge',
      async run(ctx) {
        for (const l of listings) {
          l.companyId = l.id;
          await ctx.evidence.setCompany(l.id, l.id);
        }
        return {
          companies: listings.length,
          mergesByRung: { place_id: listings.length, phone: 0, domain: 0, name_zip: 0 },
          possibleDuplicates: 0,
        };
      },
    },
    'site-enrich': {
      name: 'site-enrich',
      async run(_ctx, input: CompanyRef) {
        return {
          companyId: input.companyId,
          status: input.websiteUrl ? 'ok' : 'no_website',
          pages: [],
          emails: 0,
          owners: 0,
          licenceNumbers: [],
          residentialSignals: 0,
        };
      },
    },
    'site-finalize': {
      name: 'site-finalize',
      async run() {
        return { templateNamesRejected: 0 };
      },
    },
    'registries-match': {
      name: 'registries-match',
      async run(_ctx, input) {
        return { companyId: input.company.companyId, status: {}, owners: 0, evidenceIds: [] };
      },
    },
    classify: {
      name: 'classify',
      async run(): Promise<ResidentialDecision> {
        return { label: 'residential_only', signals: [], reason: 'fake classifier' };
      },
    },
    qualify: {
      name: 'qualify',
      async run(ctx, input) {
        const rows = await ctx.evidence.listForCompany(input.companyId);
        const policy = { ...DEFAULT_SELECTION_POLICY, minConfidence: 'low' as const };
        const rating = selectBest(rows, 'rating', policy);
        const reviews = selectBest(rows, 'review_count', policy);
        const q = ctx.config.qualification;
        const reasons: ExclusionReason[] = [];
        if (!rating) reasons.push('rating not captured');
        else if (Number(rating.value) < q.minRating) reasons.push('rating below minimum');
        if (!reviews) reasons.push('review count not captured');
        else if (Number(reviews.value) < q.minReviews) reasons.push('review count below minimum');
        else if (Number(reviews.value) > q.maxReviews) reasons.push('review count above maximum');
        return { qualified: reasons.length === 0, reasons };
      },
    },
    report: {
      name: 'report',
      async run(_ctx, input) {
        return {
          xlsxPath: `${input.outDir}/fake.xlsx`,
          masterCsvPath: `${input.outDir}/fake-master.csv`,
          qualifiedCsvPath: `${input.outDir}/fake-qualified.csv`,
          counts: { companies: listings.length },
        };
      },
    },
  };
}
