/**
 * Pure parts of the Maps rate probe: the ramp of steps, the stop rules for one step, and the per-step
 * summary. No browser, no clock, no network here, so all of it is unit-tested with fakes.
 */

export type ProbeMode = 'search' | 'place';
export type ProbeKind = 'search' | 'place';

/** What one request came back as. The four block outcomes mirror detectBlock()'s signals. */
export type ProbeOutcome =
  | 'ok'
  | 'limited_view'
  | 'sorry'
  | 'captcha'
  | 'unusual_traffic'
  | 'http_403'
  /** The page loaded but was neither a results list, a place page nor a block page (e.g. a consent wall). */
  | 'empty'
  /** Navigation threw (timeout, crash). */
  | 'error';

export const BLOCK_OUTCOMES: readonly ProbeOutcome[] = ['sorry', 'captcha', 'unusual_traffic', 'http_403'];

export function isBlockOutcome(o: ProbeOutcome): boolean {
  return BLOCK_OUTCOMES.includes(o);
}

export interface ProbeStep {
  /** "A", "B", ... for ramp steps; "harvest" / "recovery-1" for the extra phases. */
  name: string;
  /** Random pause each worker takes after every request, inclusive range in ms. */
  pauseMs: [number, number];
  /** Parallel browser pages. */
  concurrency: number;
  /** Requests this step sends (fewer when it stops early or the overall budget runs out). */
  requests: number;
}

export interface RampOptions {
  /** Step A pause: the current local pace. */
  basePauseMs: [number, number];
  /** Concurrency the last step reaches. */
  maxConcurrency: number;
  steps: number;
  stepRequests: number;
}

const STEP_NAMES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The ramp: step A runs at the local pace with one page. Each later step halves the pause. The last
 * ceil(log2(maxConcurrency)) steps also double the number of pages, ending exactly at maxConcurrency.
 * E.g. base 4-8 s, 6 steps, concurrency 8: A 1x 4-8 s, B 1x 2-4 s, C 1x 1-2 s, D 2x 0.5-1 s,
 * E 4x 250-500 ms, F 8x 125-250 ms.
 */
export function buildRamp(o: RampOptions): ProbeStep[] {
  const steps = Math.max(1, Math.min(o.steps, STEP_NAMES.length));
  const maxC = Math.max(1, Math.floor(o.maxConcurrency));
  const growth = Math.min(maxC > 1 ? Math.ceil(Math.log2(maxC)) : 0, steps - 1);
  const firstGrowth = steps - growth;
  const [min, max] = o.basePauseMs;
  const out: ProbeStep[] = [];
  for (let i = 0; i < steps; i++) {
    const factor = 2 ** i;
    let concurrency = 1;
    if (growth > 0 && i >= firstGrowth) concurrency = Math.min(maxC, 2 ** (i - firstGrowth + 1));
    if (growth > 0 && i === steps - 1) concurrency = maxC;
    out.push({
      name: STEP_NAMES[i] as string,
      pauseMs: [Math.round(min / factor), Math.round(max / factor)],
      concurrency,
      requests: o.stepRequests,
    });
  }
  return out;
}

/** Parses "4000-8000" or "5000" into an inclusive range. */
export function parsePauseRange(text: string): [number, number] {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(text);
  if (!m) throw new Error(`PAUSE_MS must look like "4000-8000" or "5000", got "${text}"`);
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (b < a) throw new Error(`PAUSE_MS max is below min: "${text}"`);
  return [a, b];
}

/** Parses a RAMP override: a JSON array of {pauseMs:[min,max], concurrency, requests, name?}. */
export function parseRampJson(text: string): ProbeStep[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`RAMP is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('RAMP must be a non-empty JSON array');
  return raw.map((s: unknown, i) => {
    const step = s as Partial<ProbeStep>;
    const p = step.pauseMs;
    const okPause =
      Array.isArray(p) && p.length === 2 && p.every((n) => Number.isInteger(n) && n >= 0) && (p[1] as number) >= (p[0] as number);
    const okConc = Number.isInteger(step.concurrency) && (step.concurrency as number) >= 1;
    const okReq = Number.isInteger(step.requests) && (step.requests as number) >= 1;
    if (!okPause || !okConc || !okReq) {
      throw new Error(`RAMP step ${i} needs pauseMs [min,max] (whole ms), concurrency >= 1 and requests >= 1`);
    }
    return {
      name: typeof step.name === 'string' && step.name.length > 0 ? step.name : (STEP_NAMES[i] ?? `S${i}`),
      pauseMs: [p[0] as number, p[1] as number],
      concurrency: step.concurrency as number,
      requests: step.requests as number,
    };
  });
}

export type StopReason =
  | { reason: 'blocked'; signal: ProbeOutcome; detail: string }
  | { reason: 'limited_streak'; detail: string }
  | { reason: 'error_streak'; detail: string };

/**
 * The stop rules for one step. Any block page stops at once. `limitedStreak` limited-view place pages
 * in a row (the pipeline's own rule, maps.limitedViewStreakStop) stop it, and so do `errorStreak`
 * errors / unreadable pages in a row. Any other outcome resets the streak it does not belong to.
 * "In a row" is in the order requests finish.
 */
export class StepMonitor {
  private limited = 0;
  private errors = 0;
  stopped: StopReason | null = null;

  constructor(private readonly o: { limitedStreak: number; errorStreak: number }) {}

  record(outcome: ProbeOutcome): StopReason | null {
    if (this.stopped) return this.stopped;
    if (isBlockOutcome(outcome)) {
      this.stopped = { reason: 'blocked', signal: outcome, detail: `block page: ${outcome}` };
      return this.stopped;
    }
    if (outcome === 'limited_view') {
      this.limited++;
      this.errors = 0;
      if (this.o.limitedStreak > 0 && this.limited >= this.o.limitedStreak) {
        this.stopped = { reason: 'limited_streak', detail: `${this.limited} limited-view place pages in a row` };
      }
      return this.stopped;
    }
    if (outcome === 'error' || outcome === 'empty') {
      this.errors++;
      this.limited = 0;
      if (this.o.errorStreak > 0 && this.errors >= this.o.errorStreak) {
        this.stopped = { reason: 'error_streak', detail: `${this.errors} errors or unreadable pages in a row` };
      }
      return this.stopped;
    }
    this.limited = 0;
    this.errors = 0;
    return null;
  }
}

export interface ProbeRecord {
  type: 'request';
  t: string;
  step: string;
  kind: ProbeKind;
  outcome: ProbeOutcome;
  ms: number;
  status: number | null;
  worker: number;
  seq: number;
  /** Cards on a search page (after scrolling). */
  cards?: number;
  /** Error message or the landed URL of an unreadable page. */
  detail?: string;
}

export interface StepSummary {
  type: 'step';
  step: string;
  kind: ProbeKind;
  pauseMs: [number, number];
  concurrency: number;
  planned: number;
  requests: number;
  ok: number;
  okPct: number;
  limited: number;
  limitedPct: number;
  blocked: number;
  blockedBy: Partial<Record<ProbeOutcome, number>>;
  empty: number;
  errors: number;
  avgMs: number | null;
  wallMs: number;
  /** requests / wall time, scaled to one hour. */
  effectivePerHour: number | null;
  /** completed | budget | blocked | limited_streak | error_streak */
  stoppedBy: string;
  stopDetail: string | null;
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export function summarizeStep(
  step: ProbeStep,
  kind: ProbeKind,
  records: readonly ProbeRecord[],
  wallMs: number,
  stop: StopReason | null,
  budgetHit: boolean,
): StepSummary {
  const count = (o: ProbeOutcome): number => records.filter((r) => r.outcome === o).length;
  const blockedBy: Partial<Record<ProbeOutcome, number>> = {};
  for (const b of BLOCK_OUTCOMES) {
    const n = count(b);
    if (n > 0) blockedBy[b] = n;
  }
  const blocked = Object.values(blockedBy).reduce((a, b) => a + (b ?? 0), 0);
  const n = records.length;
  const ok = count('ok');
  const limited = count('limited_view');
  const ms = records.map((r) => r.ms);
  return {
    type: 'step',
    step: step.name,
    kind,
    pauseMs: step.pauseMs,
    concurrency: step.concurrency,
    planned: step.requests,
    requests: n,
    ok,
    okPct: pct(ok, n),
    limited,
    limitedPct: pct(limited, n),
    blocked,
    blockedBy,
    empty: count('empty'),
    errors: count('error'),
    avgMs: n === 0 ? null : Math.round(ms.reduce((a, b) => a + b, 0) / n),
    wallMs,
    effectivePerHour: wallMs > 0 && n > 0 ? Math.round((n / wallMs) * 3_600_000) : null,
    stoppedBy: stop ? stop.reason : budgetHit ? 'budget' : 'completed',
    stopDetail: stop ? stop.detail : null,
  };
}
