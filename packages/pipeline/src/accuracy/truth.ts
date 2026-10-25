import { parse } from 'csv-parse/sync';
import { z } from 'zod';

/** The fields the blind checker fills in, one truth row per sample x field (several for emails). */
export const TRUTH_FIELDS = [
  'name',
  'phone',
  'website',
  'email',
  'owner_name',
  'owner_title',
  'rating',
  'review_count',
  'address',
  'zip',
  'category',
  'residential_status',
  'is_painter',
] as const;
export type TruthField = (typeof TRUTH_FIELDS)[number];

/** "I looked and it cannot be found" is an explicit value, different from a blank (not checked). */
export const NOT_FINDABLE = 'NOT_FINDABLE';

export const TruthRowSchema = z.object({
  sample_id: z.string().trim().min(1),
  field: z.enum(TRUTH_FIELDS),
  value: z.string().trim().default(''),
  source_url: z.string().trim().default(''),
  checked_at: z.string().trim().default(''),
  notes: z.string().default(''),
});
export type TruthRow = z.infer<typeof TruthRowSchema>;

export const AdjudicationRowSchema = z.object({
  sample_id: z.string().trim().min(1),
  field: z.enum(TRUTH_FIELDS),
  /** The system value being judged (empty = every system value of that field). */
  value: z.string().trim().default(''),
  verdict: z.string().trim().toLowerCase().pipe(z.enum(['correct', 'wrong'])),
  note: z.string().default(''),
});
export type AdjudicationRow = z.infer<typeof AdjudicationRowSchema>;

export const isNotFindable = (value: string): boolean => value.trim().toUpperCase() === NOT_FINDABLE;

function records(text: string): Record<string, string>[] {
  return parse(text, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<
    string,
    string
  >[];
}

export function parseTruthCsv(text: string): TruthRow[] {
  return records(text).map((r, i) => {
    const parsed = TruthRowSchema.safeParse(r);
    if (!parsed.success) throw new Error(`truth row ${i + 2}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    return { ...parsed.data, value: isNotFindable(parsed.data.value) ? NOT_FINDABLE : parsed.data.value };
  });
}

export function parseAdjudicationCsv(text: string): AdjudicationRow[] {
  return records(text)
    .filter((r) => (r.verdict ?? '').trim() !== '')
    .map((r, i) => {
      const parsed = AdjudicationRowSchema.safeParse(r);
      if (!parsed.success) throw new Error(`adjudication row ${i + 2}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      return parsed.data;
    });
}
