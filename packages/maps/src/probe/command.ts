import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, REPO_ROOT, type CommandSpec, type LaunchedBrowser, type PpConfig } from '@pp/core';
import { PlaywrightDriver } from '../driver/playwright';
import { buildRamp, parsePauseRange, parseRampJson, type ProbeMode, type ProbeStep } from './ramp';
import { runProbe } from './run';

export interface ProbeSettings {
  mode: ProbeMode;
  steps: ProbeStep[];
  maxRequests: number;
  scrolls: number;
  limitedStreak: number;
  errorStreak: number;
  harvest: { maxSearches: number; pauseMs: [number, number] };
  recovery: { checks: number; waitMs: number };
  inputFile: string;
}

export interface ProbeInput {
  queries: string[];
  places?: string[];
}

type Env = Record<string, string | undefined>;

function intEnv(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number >= ${min}, got "${raw}"`);
  return n;
}

/**
 * Reads the probe's knobs from the environment. Defaults start from the pipeline's own config: step A
 * uses maps.searchPauseMs (search mode) or maps.placePauseMs (place mode), i.e. the current local pace.
 */
export function readProbeSettings(env: Env, config: PpConfig): ProbeSettings {
  const modeRaw = (env.PROBE_MODE ?? 'search').trim();
  if (modeRaw !== 'search' && modeRaw !== 'place') throw new Error(`PROBE_MODE must be search or place, got "${modeRaw}"`);
  const mode: ProbeMode = modeRaw;
  const localPace = mode === 'search' ? config.maps.searchPauseMs : config.maps.placePauseMs;
  const basePauseMs = env.PAUSE_MS?.trim() ? parsePauseRange(env.PAUSE_MS) : ([localPace[0], localPace[1]] as [number, number]);
  const steps = env.RAMP?.trim()
    ? parseRampJson(env.RAMP)
    : buildRamp({
        basePauseMs,
        maxConcurrency: intEnv(env, 'CONCURRENCY', 4, 1),
        steps: intEnv(env, 'STEPS', 6, 1),
        stepRequests: intEnv(env, 'STEP_REQUESTS', 25, 1),
      });
  return {
    mode,
    steps,
    maxRequests: intEnv(env, 'MAX_REQUESTS', 200, 1),
    scrolls: intEnv(env, 'SCROLLS', config.maps.maxScrolls),
    limitedStreak: intEnv(env, 'LIMITED_STREAK', config.maps.limitedViewStreakStop),
    errorStreak: intEnv(env, 'ERROR_STREAK', 5),
    harvest: {
      maxSearches: intEnv(env, 'HARVEST_SEARCHES', 10, 1),
      pauseMs: [config.maps.searchPauseMs[0], config.maps.searchPauseMs[1]],
    },
    recovery: { checks: intEnv(env, 'RECOVERY_CHECKS', 4), waitMs: intEnv(env, 'RECOVERY_MINUTES', 15) * 60_000 },
    inputFile: env.PROBE_INPUT?.trim() ? path.resolve(env.PROBE_INPUT) : path.join(REPO_ROOT, 'ops', 'probe', 'queries.json'),
  };
}

export function readProbeInput(file: string): ProbeInput {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProbeInput>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
  if (!strings(raw.queries) || raw.queries.length === 0) throw new Error(`${file}: "queries" must be a non-empty string array`);
  if (raw.places !== undefined && !strings(raw.places)) throw new Error(`${file}: "places" must be a string array`);
  return { queries: raw.queries, ...(raw.places && raw.places.length > 0 ? { places: raw.places } : {}) };
}

interface Egress {
  type: 'egress';
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  org: string | null;
  source: string | null;
  error?: string;
}

/** The server's public IP and country, read through the same Chromium the probe uses (same egress). */
async function lookupEgress(launched: LaunchedBrowser): Promise<Egress> {
  const page = await launched.context.newPage();
  const empty: Egress = { type: 'egress', ip: null, country: null, region: null, city: null, org: null, source: null };
  try {
    const sources: [string, (j: Record<string, unknown>) => Partial<Egress>][] = [
      ['https://ipinfo.io/json', (j) => ({ ip: s(j.ip), country: s(j.country), region: s(j.region), city: s(j.city), org: s(j.org) })],
      ['https://api.ipify.org?format=json', (j) => ({ ip: s(j.ip) })],
    ];
    const errors: string[] = [];
    for (const [url, pick] of sources) {
      try {
        const res = await page.goto(url, { timeout: 20_000 });
        if (!res || !res.ok()) throw new Error(`HTTP ${res?.status() ?? 'none'}`);
        const json = (await res.json()) as Record<string, unknown>;
        return { ...empty, ...pick(json), source: url };
      } catch (e) {
        errors.push(`${url}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    return { ...empty, error: errors.join('; ') };
  } finally {
    await page.close().catch(() => undefined);
  }
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const probeCommand: CommandSpec = {
  name: 'probe maps-rate',
  description:
    'Rate probe: ramps Maps searches or place pages from this server until Google blocks or degrades; JSON lines on stdout; needs PP_LIVE=1 (knobs: env, see PROBE.md)',
  options: [{ flags: '--dry-run', description: 'print the settings and the ramp, send nothing' }],
  async run(ctx, _args, opts) {
    const config = ctx.config();
    const settings = readProbeSettings(process.env, config);
    const input = readProbeInput(settings.inputFile);
    const out = (line: object): void => ctx.out(JSON.stringify(line));
    out({
      type: 'start',
      t: new Date().toISOString(),
      mode: settings.mode,
      steps: settings.steps,
      maxRequests: settings.maxRequests,
      scrolls: settings.scrolls,
      limitedStreak: settings.limitedStreak,
      errorStreak: settings.errorStreak,
      harvest: settings.harvest,
      recovery: settings.recovery,
      input: { file: path.relative(REPO_ROOT, settings.inputFile), queries: input.queries.length, places: input.places?.length ?? 0 },
    });
    if (opts.dryRun === true) return;
    if (process.env.PP_LIVE !== '1') {
      throw new Error('probe maps-rate drives a real browser against Google Maps: set PP_LIVE=1 to allow it');
    }

    const launched = await launchBrowser({ purpose: 'maps', config });
    try {
      out(await lookupEgress(launched));
      await runProbe({
        mode: settings.mode,
        steps: settings.steps,
        queries: input.queries,
        ...(input.places ? { places: input.places } : {}),
        maxRequests: settings.maxRequests,
        scrolls: settings.scrolls,
        limitedStreak: settings.limitedStreak,
        errorStreak: settings.errorStreak,
        harvest: settings.harvest,
        recovery: settings.recovery,
        driver: async () => new PlaywrightDriver(await launched.context.newPage()),
        sleep,
        now: () => new Date(),
        emit: out,
      });
    } finally {
      await launched.close();
    }
  },
};
