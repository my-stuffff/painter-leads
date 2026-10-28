import type { PpConfig } from '@pp/core';
import { DEFAULT_JOB_SETTINGS, type JobSettings } from './contract';

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** A job's stored settings (jobs.settings jsonb) with the defaults filled in for anything missing or malformed. */
export function readSettings(raw: unknown): JobSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof JobSettings, unknown>>;
  const terms = Array.isArray(s.terms)
    ? s.terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    : [];
  return {
    minRating: finite(s.minRating, DEFAULT_JOB_SETTINGS.minRating),
    minReviews: Math.trunc(finite(s.minReviews, DEFAULT_JOB_SETTINGS.minReviews)),
    maxReviews: Math.trunc(finite(s.maxReviews, DEFAULT_JOB_SETTINGS.maxReviews)),
    reuseDays: Math.max(0, finite(s.reuseDays, DEFAULT_JOB_SETTINGS.reuseDays)),
    terms: terms.length > 0 ? terms : [...DEFAULT_JOB_SETTINGS.terms],
  };
}

/**
 * The config a job's cities are scraped with: the base config, only the search terms replaced. The thresholds stay
 * the base ones, because the pipeline writes companies.qualified and two jobs must never disturb each other.
 */
export function pipelineConfig(base: PpConfig, s: JobSettings): PpConfig {
  return { ...base, search: { ...base.search, terms: [...s.terms] } };
}

/**
 * The config a job's export is judged with: the base config with the job's rating and review thresholds
 * (residential-only and Google-profile rules unchanged). Only used for the pure qualify() at export time.
 */
export function exportConfig(base: PpConfig, s: JobSettings): PpConfig {
  return {
    ...base,
    qualification: { ...base.qualification, minRating: s.minRating, minReviews: s.minReviews, maxReviews: s.maxReviews },
  };
}
