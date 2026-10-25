import { z } from 'zod';
import { SOURCE_IDS, type SourceId } from '../types';

const pauseRange = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([min, max]) => min <= max, { message: 'pause range must be [min, max] with min <= max' });

const sourceEntry = z.strictObject({
  enabled: z.boolean(),
  minIntervalMs: z.number().int().nonnegative(),
  robots: z.enum(['respect', 'override']),
});

const sourcesShape = Object.fromEntries(SOURCE_IDS.map((id) => [id, sourceEntry])) as Record<
  SourceId,
  typeof sourceEntry
>;

export const PpConfigSchema = z.strictObject({
  qualification: z
    .strictObject({
      minRating: z.number().min(0).max(5),
      minReviews: z.number().int().nonnegative(),
      maxReviews: z.number().int().nonnegative(),
      requireGoogleProfile: z.boolean(),
      requireResidentialOnly: z.boolean(),
    })
    .refine((q) => q.minReviews <= q.maxReviews, {
      message: 'minReviews must be <= maxReviews',
      path: ['minReviews'],
    }),
  search: z.strictObject({
    terms: z.array(z.string().min(1)).min(1),
    order: z.literal('term-major'),
    zctaMinShare: z.number().min(0).max(1),
  }),
  areas: z.strictObject({
    file: z.string().min(1),
    pilotOrder: z.array(z.string().min(1)).min(1),
    expandIfPaintersBelow: z.record(z.string(), z.number().int().nonnegative()),
  }),
  maps: z.strictObject({
    headless: z.boolean(),
    locale: z.string().min(2),
    timezoneId: z.string().min(1),
    searchPauseMs: pauseRange,
    placePauseMs: pauseRange,
    dailyCap: z.strictObject({
      searches: z.number().int().positive(),
      placePages: z.number().int().positive(),
    }),
    limitedViewStreakStop: z.number().int().positive(),
    maxScrolls: z.number().int().positive(),
    blockBackoffMinutes: z.number().int().nonnegative(),
    smokeBudget: z.strictObject({
      searches: z.number().int().nonnegative(),
      placePages: z.number().int().nonnegative(),
    }),
    dcTest: z.strictObject({ queries: z.array(z.string().min(1)) }),
  }),
  sources: z.strictObject(sourcesShape),
  fetch: z.strictObject({
    timeoutMs: z.number().int().positive(),
    maxBodyBytes: z.number().int().positive(),
    maxDownloadBytes: z.number().int().positive(),
    maxRedirects: z.number().int().nonnegative(),
    robotsCacheHours: z.number().nonnegative(),
    dnsOverrides: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  }),
  crawl: z.strictObject({
    maxInternalPages: z.number().int().nonnegative(),
    linkPattern: z.string().min(1),
    renderIfVisibleCharsBelow: z.number().int().nonnegative(),
    concurrency: z.number().int().positive(),
    maxBundles: z.number().int().nonnegative(),
    maxBundleBytes: z.number().int().nonnegative(),
  }),
  confidence: z.strictObject({ websiteOwner: z.enum(['medium', 'low']) }),
  report: z.strictObject({
    minConfidence: z.enum(['high', 'medium', 'low']),
    outDir: z.string().min(1),
  }),
  franchise: z.strictObject({
    brands: z.array(z.string().min(1)),
    domains: z.array(z.string().min(1)),
  }),
  accuracy: z.strictObject({
    perState: z.number().int().positive(),
    minQualified: z.number().int().nonnegative(),
    maxNonPainters: z.number().int().nonnegative(),
    drift: z.strictObject({
      reviewAbs: z.number().nonnegative(),
      reviewPct: z.number().nonnegative(),
      ratingTol: z.number().nonnegative(),
    }),
    truthWithinHours: z.number().positive(),
  }),
});

export type PpConfig = z.infer<typeof PpConfigSchema>;
