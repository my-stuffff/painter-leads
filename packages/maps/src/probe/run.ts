import { detectBlock } from '../blocks';
import type { PageDriver } from '../driver/types';
import { scrollFeedToEnd } from '../feed';
import { parseCard } from '../parse/card';
import { parsePlace } from '../parse/place';
import { withLocale } from '../parse/url';
import { buildTextSearchUrl } from '../query';
import { randomPause } from '../throttle';
import {
  BLOCK_OUTCOMES,
  StepMonitor,
  summarizeStep,
  type ProbeKind,
  type ProbeMode,
  type ProbeOutcome,
  type ProbeRecord,
  type ProbeStep,
  type StepSummary,
  type StopReason,
} from './ramp';

export interface ProbeRunOptions {
  mode: ProbeMode;
  steps: ProbeStep[];
  /** Free-text Maps searches, used in order (wrapping round when the budget is larger). */
  queries: string[];
  /** Place mode: ready place URLs. When absent the probe harvests them from its own searches first. */
  places?: string[];
  /** Hard cap on requests across harvest + ramp (recovery checks are extra, at most recovery.checks). */
  maxRequests: number;
  /** Feed scrolls per search (0 = read the first screen of cards only). */
  scrolls: number;
  limitedStreak: number;
  errorStreak: number;
  /** Place mode harvest: at most this many searches, at this pause. */
  harvest: { maxSearches: number; pauseMs: [number, number] };
  /** After a stop: wait, then try one request; repeat up to `checks` times or until one is ok. */
  recovery: { checks: number; waitMs: number };
  /** One page per worker index; created on first use and reused across steps. */
  driver(worker: number): Promise<PageDriver>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  rng?: () => number;
  /** Receives every JSON line (request records, step summaries, the final verdict). */
  emit(line: object): void;
}

export interface RecoveryCheck {
  type: 'recovery';
  check: number;
  minutesAfterStop: number;
  outcome: ProbeOutcome;
}

export interface ProbeResult {
  type: 'final';
  mode: ProbeMode;
  steps: StepSummary[];
  totalRequests: number;
  /** The step that stopped the ramp (null when every step completed or the budget ran out). */
  stoppedAt: string | null;
  stop: StopReason | null;
  /** The fastest step that finished with no block and no streak stop. */
  fastestClean: { step: string; concurrency: number; pauseMs: [number, number]; effectivePerHour: number | null; limitedPct: number } | null;
  recovery: RecoveryCheck[];
  recoveredAfterMinutes: number | null;
  verdict: string;
}

interface RequestResult {
  outcome: ProbeOutcome;
  status: number | null;
  cards?: number;
  detail?: string;
  placeUrls?: string[];
}

function asOutcome(signal: string): ProbeOutcome {
  return (BLOCK_OUTCOMES as readonly string[]).includes(signal) ? (signal as ProbeOutcome) : 'unusual_traffic';
}

/** One navigation, classified only by the pipeline's own code (detectBlock, parsePlace, scrollFeedToEnd). */
export async function probeOne(driver: PageDriver, kind: ProbeKind, target: string, scrolls: number): Promise<RequestResult> {
  let status: number | null = null;
  try {
    const url = kind === 'search' ? buildTextSearchUrl(target) : target;
    const opened = await driver.open(url);
    status = opened.status;
    const signals = await driver.pageSignals();
    const block = detectBlock(signals, opened.status);
    if (block) return { outcome: asOutcome(block), status };

    if (kind === 'search') {
      if (signals.hasFeed) {
        if (scrolls > 0) await scrollFeedToEnd(driver, scrolls);
        const cards = await driver.snapshotCards();
        const placeUrls: string[] = [];
        for (const c of cards) {
          try {
            placeUrls.push(withLocale(parseCard(c).profileUrl));
          } catch {
            // a card without a usable link: skip it
          }
        }
        if (cards.length === 0) return { outcome: 'empty', status, cards: 0, detail: 'results list with no cards' };
        return { outcome: 'ok', status, cards: cards.length, placeUrls };
      }
      // One exact match opens straight on its place page.
      if (signals.hasPlacePanel) return { outcome: 'ok', status, cards: 1 };
      return { outcome: 'empty', status, detail: `no results list: ${signals.landedUrl}` };
    }

    const parsed = parsePlace(await driver.snapshotPlace());
    if (parsed.limitedView) return { outcome: 'limited_view', status };
    if (parsed.loaded) return { outcome: 'ok', status };
    return { outcome: 'empty', status, detail: `no place heading: ${signals.landedUrl}` };
  } catch (e) {
    return { outcome: 'error', status, detail: (e as Error).message.split('\n')[0]?.slice(0, 200) };
  }
}

interface StepRun {
  summary: StepSummary;
  stop: StopReason | null;
  records: ProbeRecord[];
}

/**
 * Runs the probe: (place mode) a harvest of place links from searches, then the ramp steps in order.
 * A step stops at the first block page, on a limited-view streak or on an error streak, and then the
 * ramp ends there (a faster step would only be blocked harder). Optional recovery checks follow.
 */
export async function runProbe(o: ProbeRunOptions): Promise<ProbeResult> {
  const rng = o.rng ?? Math.random;
  const drivers = new Map<number, PageDriver>();
  const budget = { used: 0, max: o.maxRequests };
  let seq = 0;
  let queryCursor = 0;
  let placeCursor = 0;
  const placePool: string[] = [...(o.places ?? [])];
  const placeSeen = new Set(placePool);
  const summaries: StepSummary[] = [];

  const getDriver = async (w: number): Promise<PageDriver> => {
    let d = drivers.get(w);
    if (!d) {
      d = await o.driver(w);
      drivers.set(w, d);
    }
    return d;
  };
  const nextQuery = (): string | null => {
    if (o.queries.length === 0) return null;
    const q = o.queries[queryCursor % o.queries.length] as string;
    queryCursor++;
    return q;
  };
  const nextPlace = (): string | null => {
    if (placePool.length === 0) return null;
    const p = placePool[placeCursor % placePool.length] as string;
    placeCursor++;
    return p;
  };

  const runStep = async (
    step: ProbeStep,
    kind: ProbeKind,
    opts: { useBudget: boolean; until?: () => boolean },
  ): Promise<StepRun> => {
    const monitor = new StepMonitor({ limitedStreak: o.limitedStreak, errorStreak: o.errorStreak });
    const records: ProbeRecord[] = [];
    let issued = 0;
    let budgetHit = false;
    const started = o.now().getTime();
    const next = kind === 'search' ? nextQuery : nextPlace;

    const worker = async (w: number): Promise<void> => {
      const driver = await getDriver(w);
      while (!monitor.stopped) {
        if (issued >= step.requests) return;
        if (opts.until?.()) return;
        if (opts.useBudget && budget.used >= budget.max) {
          budgetHit = true;
          return;
        }
        const target = next();
        if (target === null) return;
        issued++;
        if (opts.useBudget) budget.used++;
        const t0 = o.now();
        const r = await probeOne(driver, kind, target, o.scrolls);
        const rec: ProbeRecord = {
          type: 'request',
          t: t0.toISOString(),
          step: step.name,
          kind,
          outcome: r.outcome,
          ms: o.now().getTime() - t0.getTime(),
          status: r.status,
          worker: w,
          seq: ++seq,
          ...(r.cards !== undefined ? { cards: r.cards } : {}),
          ...(r.detail !== undefined ? { detail: r.detail } : {}),
        };
        records.push(rec);
        o.emit(rec);
        for (const u of r.placeUrls ?? []) {
          if (!placeSeen.has(u)) {
            placeSeen.add(u);
            placePool.push(u);
          }
        }
        if (monitor.record(r.outcome)) return;
        if (opts.until?.()) return;
        await o.sleep(randomPause(step.pauseMs, rng));
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, step.concurrency) }, (_, w) => worker(w)));
    const summary = summarizeStep(step, kind, records, o.now().getTime() - started, monitor.stopped, budgetHit);
    o.emit(summary);
    return { summary, stop: monitor.stopped, records };
  };

  let stop: StopReason | null = null;
  let stoppedAt: string | null = null;

  try {
    if (o.mode === 'place' && placePool.length === 0) {
      const needed = Math.min(
        o.maxRequests,
        o.steps.reduce((a, s) => a + s.requests, 0),
      );
      const harvestStep: ProbeStep = { name: 'harvest', pauseMs: o.harvest.pauseMs, concurrency: 1, requests: o.harvest.maxSearches };
      const h = await runStep(harvestStep, 'search', { useBudget: true, until: () => placePool.length >= needed });
      summaries.push(h.summary);
      if (h.stop) {
        stop = h.stop;
        stoppedAt = harvestStep.name;
      } else if (placePool.length === 0) {
        stop = { reason: 'error_streak', detail: 'harvest found no place links' };
        stoppedAt = harvestStep.name;
      }
    }

    if (!stop) {
      for (const step of o.steps) {
        if (budget.used >= budget.max) break;
        const r = await runStep(step, o.mode, { useBudget: true });
        summaries.push(r.summary);
        if (r.stop) {
          stop = r.stop;
          stoppedAt = step.name;
          break;
        }
      }
    }

    const recovery: RecoveryCheck[] = [];
    let recoveredAfterMinutes: number | null = null;
    // Recovery checks are only meaningful after a real stop, and only when something is left to request.
    const canRecover = stop !== null && (o.mode === 'search' || placePool.length > 0);
    if (canRecover) {
      for (let k = 1; k <= o.recovery.checks; k++) {
        await o.sleep(o.recovery.waitMs);
        const step: ProbeStep = { name: `recovery-${k}`, pauseMs: [0, 0], concurrency: 1, requests: 1 };
        const r = await runStep(step, o.mode, { useBudget: false });
        const outcome = r.records[0]?.outcome ?? 'error';
        const minutes = Math.round((k * o.recovery.waitMs) / 60_000);
        const check: RecoveryCheck = { type: 'recovery', check: k, minutesAfterStop: minutes, outcome };
        recovery.push(check);
        o.emit(check);
        if (outcome === 'ok') {
          recoveredAfterMinutes = minutes;
          break;
        }
      }
    }

    const result = finalResult(o.mode, summaries, budget.used, stoppedAt, stop, recovery, recoveredAfterMinutes, o.recovery.checks);
    o.emit(result);
    return result;
  } finally {
    for (const d of drivers.values()) await d.close().catch(() => undefined);
  }
}

function describe(s: Pick<StepSummary, 'step' | 'concurrency' | 'pauseMs'>): string {
  return `step ${s.step} (${s.concurrency} page${s.concurrency === 1 ? '' : 's'}, ${s.pauseMs[0]}-${s.pauseMs[1]} ms pause)`;
}

export function finalResult(
  mode: ProbeMode,
  steps: StepSummary[],
  totalRequests: number,
  stoppedAt: string | null,
  stop: StopReason | null,
  recovery: RecoveryCheck[],
  recoveredAfterMinutes: number | null,
  plannedChecks: number,
): ProbeResult {
  const clean = steps.filter((s) => s.step !== 'harvest' && !s.step.startsWith('recovery-') && s.stopDetail === null && s.blocked === 0 && s.requests > 0);
  const best = clean.reduce<StepSummary | null>(
    (a, s) => (a === null || (s.effectivePerHour ?? 0) > (a.effectivePerHour ?? 0) ? s : a),
    null,
  );
  const fastestClean = best
    ? { step: best.step, concurrency: best.concurrency, pauseMs: best.pauseMs, effectivePerHour: best.effectivePerHour, limitedPct: best.limitedPct }
    : null;
  const parts: string[] = [];
  parts.push(
    best
      ? `Fastest clean ${mode} pace: ${describe(best)} at about ${best.effectivePerHour ?? '?'} requests/hour (${best.limitedPct}% limited view).`
      : `No ${mode} step finished cleanly.`,
  );
  const stopStep = steps.find((s) => s.step === stoppedAt);
  if (stop && stopStep) {
    parts.push(`Stopped at ${describe(stopStep)}: ${stop.detail}, after ${stopStep.requests} requests in that step.`);
  } else {
    parts.push('Never blocked: every step ran (or the request budget ran out) - raise CONCURRENCY / STEPS / MAX_REQUESTS to push harder.');
  }
  if (stop && plannedChecks > 0) {
    parts.push(
      recoveredAfterMinutes !== null
        ? `Recovered: a request was ok again about ${recoveredAfterMinutes} minutes after the stop.`
        : `Not recovered within ${recovery.length} check(s).`,
    );
  }
  return {
    type: 'final',
    mode,
    steps,
    totalRequests,
    stoppedAt,
    stop,
    fastestClean,
    recovery,
    recoveredAfterMinutes,
    verdict: parts.join(' '),
  };
}
