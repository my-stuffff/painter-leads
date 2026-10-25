import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  normaliseBusinessName,
  normaliseEmail,
  normaliseUrlForCompare,
  personNameKey,
  toE164,
  zip5,
  type Db,
  type PpConfig,
} from '@pp/core';
import { loadRun } from '../data';
import { csvText, writeFileAtomic } from '../report/csv';
import { buildReportData, type ShownValue } from '../report/rows';
import { resolveOutDir } from '../report/stage';
import { q } from '../sql';
import { isDriftOk, type DriftConfig } from './drift';
import { accuracyDir } from './sample';
import {
  isNotFindable,
  NOT_FINDABLE,
  parseAdjudicationCsv,
  parseTruthCsv,
  TRUTH_FIELDS,
  type AdjudicationRow,
  type TruthField,
  type TruthRow,
} from './truth';
import { wilson } from './wilson';

export type ResultClass = 'correct' | 'wrong' | 'missed' | 'both_blank' | 'unverifiable' | 'unchecked';

/** What the system output for one sampled company (the values the report shows plus the held-back candidates). */
export interface SystemSample {
  sampleId: string;
  companyId: number;
  shown: Record<string, ShownValue>;
  lowCandidates: Record<string, ShownValue[]>;
}

export interface ResultRow {
  sampleId: string;
  field: TruthField;
  systemValue: string;
  confidence: string;
  truthValue: string;
  cls: ResultClass;
  /** true = a value the report shows; false = a candidate held back for low confidence. */
  shown: boolean;
  /** The checker collected this more than truthWithinHours after the run. */
  stale: boolean;
  causeTag: string;
  /** Evidence behind the system value (for the adjudication sheet). */
  sourceUrl: string;
  snippet: string;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** How two values of one field are made comparable (R: "Accuracy measurement design", step 3). */
export function normaliseForCompare(field: TruthField, value: string): string {
  const v = value.trim();
  switch (field) {
    case 'phone':
      return toE164(v) ?? v.replace(/\D/g, '');
    case 'website':
      return normaliseUrlForCompare(v);
    case 'email':
      return normaliseEmail(v);
    case 'owner_name':
      return personNameKey(v);
    case 'name':
      return normaliseBusinessName(v).norm;
    case 'zip':
      return zip5(v) ?? v;
    case 'rating':
    case 'review_count': {
      const n = Number(v);
      return Number.isFinite(n) ? String(n) : v;
    }
    case 'residential_status':
      return slug(v);
    case 'is_painter': {
      const t = v.toLowerCase();
      return ['yes', 'y', 'true', '1'].includes(t) ? 'yes' : ['no', 'n', 'false', '0'].includes(t) ? 'no' : t;
    }
    case 'address':
      return squash(v);
    default:
      return squash(v);
  }
}

/** An address matches when the street line equals the checker's, or sits inside a longer full address. */
function addressMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.includes(short);
}

export interface CompareContext {
  drift: DriftConfig;
  /** truth review count for the company (to know whether the review count changed). */
  truthReviews: number | null;
  systemReviews: number | null;
}

export function fieldEquals(field: TruthField, system: string, truth: string, ctx: CompareContext): boolean {
  const a = normaliseForCompare(field, system);
  const b = normaliseForCompare(field, truth);
  if (field === 'address') return addressMatches(a, b);
  if (field === 'rating' || field === 'review_count') {
    const sa = Number(a);
    const sb = Number(b);
    if (!Number.isFinite(sa) || !Number.isFinite(sb)) return a === b;
    if (field === 'rating') {
      const changed = ctx.truthReviews !== null && ctx.systemReviews !== null && ctx.truthReviews !== ctx.systemReviews;
      return isDriftOk('rating', sa, sb, { reviewCountChanged: changed }, ctx.drift);
    }
    return isDriftOk('review_count', sa, sb, { reviewCountChanged: false }, ctx.drift);
  }
  return a === b;
}

export interface CompareInput {
  samples: SystemSample[];
  truth: TruthRow[];
  adjudication: AdjudicationRow[];
  drift: DriftConfig;
  /** When the run was frozen; checker rows dated more than truthWithinHours later are flagged. */
  runFrozenAt: Date;
  truthWithinHours: number;
}

export interface CompareOutput {
  rows: ResultRow[];
  unchecked: number;
  stale: number;
}

/**
 * ACC-01 / D-31 / D-38: classify every (sample, field): equal -> correct, different -> wrong, system blank with a
 * findable truth -> missed, both blank -> both_blank, a system value the checker could not find -> unverifiable
 * (never correct by itself; an adjudication verdict decides). Rating and review count use the drift rule.
 */
export function compareTruth(input: CompareInput): CompareOutput {
  const rows: ResultRow[] = [];
  let unchecked = 0;
  let stale = 0;
  const limitMs = input.truthWithinHours * 3600_000;

  const adjudicated = new Map<string, 'correct' | 'wrong'>();
  const adjudicatedAll = new Map<string, 'correct' | 'wrong'>();
  for (const a of input.adjudication) {
    if (a.value === '') adjudicatedAll.set(`${a.sample_id}|${a.field}`, a.verdict);
    else adjudicated.set(`${a.sample_id}|${a.field}|${normaliseForCompare(a.field, a.value)}`, a.verdict);
  }

  for (const s of input.samples) {
    const truthFor = (f: TruthField): TruthRow[] => input.truth.filter((t) => t.sample_id === s.sampleId && t.field === f && t.value !== '');
    const num = (f: TruthField): number | null => {
      const v = truthFor(f).find((t) => !isNotFindable(t.value));
      const n = v ? Number(v.value) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const sysReviews = s.shown['review_count'] ? Number(s.shown['review_count'].value) : null;
    const ctx: CompareContext = { drift: input.drift, truthReviews: num('review_count'), systemReviews: sysReviews };

    for (const field of TRUTH_FIELDS) {
      const t = truthFor(field);
      const entries: { v: ShownValue; shown: boolean }[] = [];
      const own = s.shown[field];
      if (own) entries.push({ v: own, shown: true });
      for (const low of s.lowCandidates[field] ?? []) entries.push({ v: low, shown: false });

      const isStale = t.some((x) => {
        const at = Date.parse(x.checked_at);
        return !Number.isFinite(at) || at - input.runFrozenAt.getTime() > limitMs;
      });
      if (isStale) stale += 1;
      const base = { sampleId: s.sampleId, field, stale: isStale, causeTag: '' };

      if (t.length === 0) {
        unchecked += 1;
        for (const e of entries) {
          rows.push({ ...base, systemValue: e.v.value, confidence: e.v.confidence, truthValue: '', cls: 'unchecked', shown: e.shown, sourceUrl: e.v.sourceUrl, snippet: e.v.snippet });
        }
        if (entries.length === 0) {
          rows.push({ ...base, systemValue: '', confidence: '', truthValue: '', cls: 'unchecked', shown: true, sourceUrl: '', snippet: '' });
        }
        continue;
      }

      const values = t.filter((x) => !isNotFindable(x.value)).map((x) => x.value);
      if (values.length > 0) {
        if (entries.length === 0) {
          rows.push({ ...base, systemValue: '', confidence: '', truthValue: values.join(' | '), cls: 'missed', shown: true, sourceUrl: '', snippet: '' });
          continue;
        }
        for (const e of entries) {
          const hit = values.find((tv) => fieldEquals(field, e.v.value, tv, ctx));
          rows.push({
            ...base,
            systemValue: e.v.value,
            confidence: e.v.confidence,
            truthValue: hit ?? (values[0] as string),
            cls: hit !== undefined ? 'correct' : 'wrong',
            shown: e.shown,
            sourceUrl: e.v.sourceUrl,
            snippet: e.v.snippet,
          });
        }
        continue;
      }

      // The checker looked and found nothing.
      if (entries.length === 0) {
        rows.push({ ...base, systemValue: '', confidence: '', truthValue: NOT_FINDABLE, cls: 'both_blank', shown: true, sourceUrl: '', snippet: '' });
        continue;
      }
      for (const e of entries) {
        const verdict =
          adjudicated.get(`${s.sampleId}|${field}|${normaliseForCompare(field, e.v.value)}`) ?? adjudicatedAll.get(`${s.sampleId}|${field}`);
        rows.push({
          ...base,
          systemValue: e.v.value,
          confidence: e.v.confidence,
          truthValue: NOT_FINDABLE,
          cls: verdict ?? 'unverifiable',
          shown: e.shown,
          sourceUrl: e.v.sourceUrl,
          snippet: e.v.snippet,
        });
      }
    }
  }
  return { rows, unchecked, stale };
}

// ---- summaries ------------------------------------------------------------------------------------------------

export const LEVELS = ['high', 'medium', 'low', 'shown'] as const;
export type Level = (typeof LEVELS)[number];

export interface Counts {
  correct: number;
  wrong: number;
  unverifiable: number;
}

export interface SummaryDoc {
  runId: number | null;
  state: string;
  seed: number | null;
  samples: number;
  unchecked: number;
  stale: number;
  /** field -> level -> counts of system values (shown = the values the report shows, high + medium). */
  counts: Record<string, Record<Level, Counts>>;
  /** field -> findable values the system left blank. */
  missed: Record<string, number>;
}

const zero = (): Counts => ({ correct: 0, wrong: 0, unverifiable: 0 });

export function emptySummary(state: string): SummaryDoc {
  const counts: SummaryDoc['counts'] = {};
  const missed: SummaryDoc['missed'] = {};
  for (const f of TRUTH_FIELDS) {
    counts[f] = { high: zero(), medium: zero(), low: zero(), shown: zero() };
    missed[f] = 0;
  }
  return { runId: null, state, seed: null, samples: 0, unchecked: 0, stale: 0, counts, missed };
}

export function summarise(out: CompareOutput, meta: { runId: number | null; state: string; seed: number | null; samples: number }): SummaryDoc {
  const doc = emptySummary(meta.state);
  Object.assign(doc, { runId: meta.runId, seed: meta.seed, samples: meta.samples, unchecked: out.unchecked, stale: out.stale });
  for (const r of out.rows) {
    if (r.cls === 'missed') doc.missed[r.field] = (doc.missed[r.field] ?? 0) + 1;
    if (r.cls !== 'correct' && r.cls !== 'wrong' && r.cls !== 'unverifiable') continue;
    const bucket = doc.counts[r.field] as Record<Level, Counts>;
    const add = (lvl: Level): void => {
      bucket[lvl][r.cls as keyof Counts] += 1;
    };
    add(r.confidence as Level);
    if (r.shown) add('shown');
  }
  return doc;
}

export function poolSummaries(docs: SummaryDoc[]): SummaryDoc {
  const pooled = emptySummary('pooled');
  for (const d of docs) {
    pooled.samples += d.samples;
    pooled.unchecked += d.unchecked;
    pooled.stale += d.stale;
    for (const f of TRUTH_FIELDS) {
      pooled.missed[f] = (pooled.missed[f] ?? 0) + (d.missed[f] ?? 0);
      for (const lvl of LEVELS) {
        const into = (pooled.counts[f] as Record<Level, Counts>)[lvl];
        const from = d.counts[f]?.[lvl];
        if (!from) continue;
        into.correct += from.correct;
        into.wrong += from.wrong;
        into.unverifiable += from.unverifiable;
      }
    }
  }
  return pooled;
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** Recall = correct / (correct + wrong + missed), over the values the report shows. */
export function recall(doc: SummaryDoc, field: string): { n: number; correct: number; point: number | null } {
  const c = doc.counts[field]?.shown ?? zero();
  const missed = doc.missed[field] ?? 0;
  const n = c.correct + c.wrong + missed;
  return { n, correct: c.correct, point: n === 0 ? null : c.correct / n };
}

function table(doc: SummaryDoc): string[] {
  const lines = [
    '| Field | Level | n | Correct | Precision | Wilson 95% low | Wilson 95% high | Unverifiable |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const f of TRUTH_FIELDS) {
    for (const lvl of LEVELS) {
      const c = doc.counts[f]?.[lvl] ?? zero();
      const n = c.correct + c.wrong;
      if (n === 0 && c.unverifiable === 0) continue;
      const w = wilson(c.correct, n);
      const label = lvl === 'shown' ? 'shown (high + medium)' : lvl;
      lines.push(`| ${f} | ${label} | ${n} | ${c.correct} | ${pct(w.point)} | ${pct(w.low)} | ${pct(w.high)} | ${c.unverifiable} |`);
    }
  }
  lines.push('', '| Field | Findable values | Found correctly | Recall |', '| --- | ---: | ---: | ---: |');
  for (const f of TRUTH_FIELDS) {
    const r = recall(doc, f);
    if (r.n === 0) continue;
    lines.push(`| ${f} | ${r.n} | ${r.correct} | ${pct(r.point)} |`);
  }
  return lines;
}

/** summary.md: tables per field x confidence level, per state and pooled, n + point + Wilson interval on every figure. */
export function summaryMarkdown(state: SummaryDoc, pooled: SummaryDoc | null): string {
  const lines = [
    `# Accuracy: ${state.state}${state.runId !== null ? ` (run ${state.runId}, seed ${state.seed})` : ''}`,
    '',
    `Samples: ${state.samples}. Rows the checker left blank (not scored): ${state.unchecked}. Checker rows dated more than the allowed hours after the run: ${state.stale}.`,
    '',
    `## ${state.state}`,
    '',
    'per-state-per-field figures are indicative (n small)',
    '',
    ...table(state),
  ];
  if (pooled) {
    lines.push('', `## Pooled over ${pooled.samples} samples`, '', 'Every figure carries n and its Wilson 95% interval; read the interval, not only the point.', '', ...table(pooled));
  }
  lines.push('');
  return lines.join('\n');
}

// ---- running it on a stored run ---------------------------------------------------------------------------------

/** The system side for the sampled companies of a run (from the same selection the report uses). */
export async function loadSystemSamples(db: Db, config: PpConfig, runId: number): Promise<SystemSample[]> {
  const samples = await q<{ sample_id: string; company_id: number }>(
    db,
    `SELECT sample_id, company_id FROM accuracy_samples WHERE run_id = $1 ORDER BY sample_id`,
    [runId],
  );
  if (samples.length === 0) throw new Error(`Run ${runId} has no sample; run: pp accuracy sample ${runId} --seed N`);
  const data = await buildReportData(db, config, runId);
  const byId = new Map(data.companies.map((c) => [c.companyId, c] as const));
  return samples.map((s) => {
    const c = byId.get(s.company_id);
    if (!c) throw new Error(`Sampled company ${s.company_id} is no longer part of run ${runId}`);
    return { sampleId: s.sample_id, companyId: c.companyId, shown: c.shown, lowCandidates: c.lowCandidates };
  });
}

export const RESULT_COLUMNS = ['sample_id', 'field', 'system_value', 'confidence', 'truth_value', 'class', 'cause_tag'] as const;

export interface CompareRunOptions {
  truthText: string;
  adjudicationText?: string;
  base?: string;
}

export interface CompareRunResult {
  dir: string;
  summary: SummaryDoc;
  pooled: SummaryDoc;
  rows: ResultRow[];
  files: { results: string; summaryJson: string; summaryMd: string };
}

/** Other states' latest summary.json under the same output folder (for the pooled figures). */
export function findOtherSummaries(base: string, current: { runId: number; state: string }): SummaryDoc[] {
  const latest = new Map<string, { runId: number; doc: SummaryDoc }>();
  if (!existsSync(base)) return [];
  for (const run of readdirSync(base)) {
    const runId = Number(run);
    if (!Number.isInteger(runId)) continue;
    const accDir = path.join(base, run, 'accuracy');
    if (!existsSync(accDir)) continue;
    for (const state of readdirSync(accDir)) {
      const file = path.join(accDir, state, 'summary.json');
      if (!existsSync(file) || (runId === current.runId && state === current.state)) continue;
      const prior = latest.get(state);
      if (!prior || runId > prior.runId) latest.set(state, { runId, doc: JSON.parse(readFileSync(file, 'utf8')) as SummaryDoc });
    }
  }
  return [...latest.values()].map((v) => v.doc);
}

/** `pp accuracy compare`: scores the checker's truth against the system's output for a sampled run. */
export async function compareRun(db: Db, config: PpConfig, runId: number, o: CompareRunOptions): Promise<CompareRunResult> {
  const run = await loadRun(db, runId);
  const systems = await loadSystemSamples(db, config, runId);
  const seedRow = await q<{ seed: number }>(db, `SELECT seed FROM accuracy_samples WHERE run_id = $1 LIMIT 1`, [runId]);

  const out = compareTruth({
    samples: systems,
    truth: parseTruthCsv(o.truthText),
    adjudication: o.adjudicationText ? parseAdjudicationCsv(o.adjudicationText) : [],
    drift: config.accuracy.drift,
    runFrozenAt: run.finishedAt ?? run.createdAt,
    truthWithinHours: config.accuracy.truthWithinHours,
  });
  const summary = summarise(out, { runId, state: run.state, seed: seedRow[0]?.seed ?? null, samples: systems.length });

  const base = resolveOutDir(config, o.base);
  const dir = accuracyDir(base, runId, run.state);
  const pooled = poolSummaries([...findOtherSummaries(base, { runId, state: run.state }), summary]);

  const files = { results: path.join(dir, 'results.csv'), summaryJson: path.join(dir, 'summary.json'), summaryMd: path.join(dir, 'summary.md') };
  await writeFileAtomic(
    files.results,
    csvText(
      RESULT_COLUMNS,
      out.rows.map((r) => [r.sampleId, r.field, r.systemValue, r.confidence, r.truthValue, r.cls, r.causeTag]),
    ),
  );
  await writeFileAtomic(files.summaryJson, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFileAtomic(files.summaryMd, summaryMarkdown(summary, pooled));
  return { dir, summary, pooled, rows: out.rows, files };
}
