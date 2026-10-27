import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT_BLOCKED, type CommandContext, type CommandSpec, type StageContext, type StopInfo } from '@pp/core';
import { isBlockSignal } from './blocks';
import { logRequest } from './cap';
import { runDatacentreTest } from './datacentre';
import { createDetailStage } from './detail';
import { probeCommand } from './probe/command';
import { discoverStage } from './discover';
import { PlaywrightDriver } from './driver/playwright';
import { QUERY_FORM, type QueryForm } from './query';
import { runSmoke } from './smoke';
import { collectStatus } from './status';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function requireLive(what: string): void {
  if (process.env.PP_LIVE !== '1') {
    throw new Error(`${what} drives a real browser against Google Maps: set PP_LIVE=1 to allow it`);
  }
}

function runIdFrom(opts: Record<string, unknown>): number {
  const n = Number(opts.run);
  if (!Number.isInteger(n) || n <= 0) throw new Error('--run <n> is required (the run id)');
  return n;
}

function intOption(v: unknown, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`expected a whole number, got "${String(v)}"`);
  return n;
}

async function stageContext(ctx: CommandContext, runId: number): Promise<StageContext> {
  return {
    runId,
    config: ctx.config(),
    db: await ctx.db(),
    evidence: await ctx.evidence(),
    fetcher: await ctx.fetcher(),
    log: ctx.log,
    now: () => new Date(),
    sleep,
  };
}

/** Prints the stop and returns the exit code: EXIT_BLOCKED for a block, 0 for a clean stop (daily cap). */
function reportStop(ctx: CommandContext, stopped: StopInfo | null): number | undefined {
  if (!stopped) return undefined;
  ctx.out(`stopped: ${stopped.signal} - ${stopped.detail}`);
  return isBlockSignal(stopped.signal) ? EXIT_BLOCKED : undefined;
}

const smokeCommand: CommandSpec = {
  name: 'maps smoke',
  description: 'Live smoke: one Maps search (and a few place pages) under the per-worker budget; needs PP_LIVE=1',
  options: [
    { flags: '--zip <zip>', description: 'ZIP to search' },
    { flags: '--term <term>', description: 'search term, e.g. "house painter"' },
    { flags: '--form <form>', description: 'zip_text or viewport (default: the adopted QUERY_FORM)' },
    { flags: '--places <n>', description: 'place pages to open after the search', defaultValue: '0' },
    { flags: '--save-fixtures <dir>', description: 'write the snapshots as fixture files into this folder' },
  ],
  async run(ctx, _args, opts) {
    requireLive('maps smoke');
    const zip = typeof opts.zip === 'string' ? opts.zip : '';
    const term = typeof opts.term === 'string' ? opts.term : '';
    if (!/^\d{5}$/.test(zip) || term.length === 0) throw new Error('--zip <5 digits> and --term <text> are required');
    const form = (opts.form ?? QUERY_FORM) as QueryForm;
    if (form !== 'zip_text' && form !== 'viewport') throw new Error('--form must be zip_text or viewport');
    const config = ctx.config();
    const report = await runSmoke({
      config,
      zip,
      term,
      form,
      places: intOption(opts.places, 0),
      saveFixturesDir: typeof opts.saveFixtures === 'string' ? path.resolve(opts.saveFixtures) : undefined,
      driverFactory: () => PlaywrightDriver.launch(config),
      sleep,
    });
    ctx.out(JSON.stringify(report, null, 2));
    return report.blocked ? EXIT_BLOCKED : undefined;
  },
};

const discoverCommand: CommandSpec = {
  name: 'maps discover',
  description: 'Run the pending Maps searches of a run (resumable; stops on a block with exit code 3)',
  options: [{ flags: '--run <n>', description: 'run id' }],
  async run(ctx, _args, opts) {
    requireLive('maps discover');
    const result = await discoverStage.run(await stageContext(ctx, runIdFrom(opts)), { runId: runIdFrom(opts) });
    ctx.out(JSON.stringify({ ...result, stopped: result.stopped?.signal ?? null }));
    return reportStop(ctx, result.stopped);
  },
};

const detailCommand: CommandSpec = {
  name: 'maps detail',
  description: 'Open the place page of each listing a run found (limited views are retried with --retry-limited)',
  options: [
    { flags: '--run <n>', description: 'run id' },
    { flags: '--retry-limited', description: 'also retry listings whose last place page showed no review count' },
    { flags: '--limit <n>', description: 'process at most this many listings' },
  ],
  async run(ctx, _args, opts) {
    requireLive('maps detail');
    const runId = runIdFrom(opts);
    const stage = createDetailStage();
    const result = await stage.run(await stageContext(ctx, runId), {
      runId,
      retryLimited: opts.retryLimited === true,
      ...(opts.limit !== undefined ? { limit: intOption(opts.limit, 0) } : {}),
    });
    ctx.out(JSON.stringify({ ...result, stopped: result.stopped?.signal ?? null }));
    return reportStop(ctx, result.stopped);
  },
};

const statusCommand: CommandSpec = {
  name: 'maps status',
  description: 'Searches by status, listings by detail status, uncaptured counts, requests today vs caps, last block',
  options: [{ flags: '--run <n>', description: 'run id' }],
  async run(ctx, _args, opts) {
    const status = await collectStatus(await ctx.db(), runIdFrom(opts), ctx.config(), new Date());
    ctx.out(JSON.stringify(status, null, 2));
  },
};

const datacentreCommand: CommandSpec = {
  name: 'maps datacentre-test',
  description: 'Small scripted Maps batch that prints attempted vs ok vs blocked/limited counts as JSON; needs PP_LIVE=1',
  options: [
    { flags: '--label <name>', description: 'where this runs, e.g. laptop or railway' },
    { flags: '--searches <n>', description: 'queries to run (from config maps.dcTest.queries)', defaultValue: '5' },
    { flags: '--places <n>', description: 'place pages to open (first card of a search)', defaultValue: '5' },
    { flags: '--no-db', description: 'do not read or write the database' },
    { flags: '--out <file>', description: 'also write the JSON summary to this file' },
  ],
  async run(ctx, _args, opts) {
    requireLive('maps datacentre-test');
    const label = typeof opts.label === 'string' && opts.label.length > 0 ? opts.label : '';
    if (!label) throw new Error('--label <name> is required');
    const config = ctx.config();
    const useDb = opts.db !== false && opts.noDb !== true;
    const db = useDb ? await ctx.db() : null;
    const driver = await PlaywrightDriver.launch(config);
    try {
      const summary = await runDatacentreTest({
        label,
        config,
        searches: intOption(opts.searches, 5),
        places: intOption(opts.places, 5),
        driver,
        sleep,
        ...(db ? { log: (entry) => logRequest(db, entry) } : {}),
      });
      const json = JSON.stringify(summary, null, 2);
      ctx.out(json);
      if (typeof opts.out === 'string') writeFileSync(path.resolve(opts.out), `${json}\n`);
    } finally {
      await driver.close();
    }
  },
};

export const commands: CommandSpec[] = [
  smokeCommand,
  discoverCommand,
  detailCommand,
  statusCommand,
  datacentreCommand,
  probeCommand,
];
