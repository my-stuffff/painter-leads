import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT_BLOCKED, REPO_ROOT, type CommandContext, type CommandSpec } from '@pp/core';
import { buildAdjudicationSheet } from './accuracy/adjudication';
import { compareRun } from './accuracy/compare';
import { exportGolden } from './accuracy/golden-export';
import { drawSample } from './accuracy/sample';
import { loadRun } from './data';
import { envFromCommand } from './env';
import { planSearches } from './plan';
import { computeFillRates, fillRateLines, writeFillRates } from './fillrates';
import { qualifyRun } from './qualify';
import { LIVE_REGISTRIES_NEEDS_PP_LIVE, REPROCESS_STEPS, reprocessRun, type ReprocessStep } from './reprocess';
import { generateReport, resolveOutDir, runOutputDir } from './report/stage';
import { verifyReport } from './report/verify';
import { runPilot } from './run';
import { allReplayers } from './stages';
import { q1 } from './sql';
import { computeYields, writeYieldCsv, yieldLines } from './yields';

const FAKE_OPTION = { flags: '--fake-stages', description: 'Use stand-in stages for maps / sites / registries (no network)' };

function runIdArg(args: string[]): number {
  const raw = args[0];
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) throw new Error(`"${raw ?? ''}" is not a run id`);
  return n;
}

async function latestRun(ctx: CommandContext, areaId: string, onlyUnfinished: boolean): Promise<number | null> {
  const db = await ctx.db();
  const row = await q1<{ id: number }>(
    db,
    onlyUnfinished
      ? `SELECT id FROM runs WHERE area_id = $1 AND status <> 'done' ORDER BY id DESC LIMIT 1`
      : `SELECT id FROM runs WHERE area_id = $1 ORDER BY id DESC LIMIT 1`,
    [areaId],
  );
  return row?.id ?? null;
}

const planCommand: CommandSpec = {
  name: 'pilot plan',
  description: 'Plan the searches of an area (terms x ZIPs, term-major); re-planning the same run adds nothing',
  args: [{ name: 'area', required: true, description: 'area id from data/geo/pilot-areas.json (pilots, or whole cities like los_angeles_ca)' }],
  async run(ctx, args) {
    const area = args[0] as string;
    const db = await ctx.db();
    const planned = await q1<{ id: number }>(db, `SELECT id FROM runs WHERE area_id = $1 AND status = 'planned' ORDER BY id DESC LIMIT 1`, [area]);
    const r = await planSearches(db, ctx.config(), area, 'pilot', planned?.id);
    ctx.out(`run ${r.runId}: ${r.total} searches planned (${r.inserted} new)`);
  },
};

const runCommand: CommandSpec = {
  name: 'pilot run',
  description: 'Run the whole pipeline for one or more areas; exits 3 when stopped on a block',
  args: [{ name: 'areas', variadic: true, description: 'area ids (or use --all)' }],
  options: [
    { flags: '--all', description: 'edison_nj, austin_tx, san_diego_ca in the configured order' },
    FAKE_OPTION,
    { flags: '--resume', description: 'continue the newest unfinished run of each area instead of planning a new one' },
    { flags: '--refresh', description: 'redo site-enrich and registries-match even where they already have a status' },
  ],
  async run(ctx, args, opts) {
    const areas = opts.all ? ctx.config().areas.pilotOrder : args;
    if (areas.length === 0) throw new Error('name an area or use --all');
    const fake = Boolean(opts.fakeStages);
    const env = await envFromCommand(ctx, { needFetcher: !fake });
    for (const area of areas) {
      const runId = opts.resume ? ((await latestRun(ctx, area, true)) ?? undefined) : undefined;
      const outcome = await runPilot(env, area, { fake, runId, refresh: Boolean(opts.refresh) });
      if (outcome.exitCode !== 0) return outcome.exitCode;
    }
    return 0;
  },
};

const resumeCommand: CommandSpec = {
  name: 'pilot resume',
  description: 'Continue a stopped run from where it stopped (finished work is not repeated)',
  args: [{ name: 'runId', required: true, description: 'run id' }],
  options: [FAKE_OPTION, { flags: '--refresh', description: 'redo site-enrich and registries-match' }],
  async run(ctx, args, opts) {
    const runId = runIdArg(args);
    const fake = Boolean(opts.fakeStages);
    const env = await envFromCommand(ctx, { needFetcher: !fake });
    const run = await loadRun(env.db, runId);
    const outcome = await runPilot(env, run.areaId, { runId, fake, refresh: Boolean(opts.refresh) });
    return outcome.exitCode === 0 ? 0 : EXIT_BLOCKED;
  },
};

const reportCommand: CommandSpec = {
  name: 'pilot report',
  description: 'Re-qualify a run against the current pp.config.json and rewrite its workbook and CSVs',
  args: [{ name: 'runId', required: true, description: 'run id' }],
  async run(ctx, args) {
    const runId = runIdArg(args);
    const db = await ctx.db();
    const config = ctx.config();
    await qualifyRun(db, config, runId);
    const r = await generateReport(db, config, runId, resolveOutDir(config));
    ctx.out(`xlsx: ${r.xlsxPath}`);
    ctx.out(`master csv: ${r.masterCsvPath}`);
    ctx.out(`qualified csv: ${r.qualifiedCsvPath}`);
    ctx.out(`companies ${r.counts.companies}, qualified ${r.counts.qualified}`);
  },
};

const latestRunCommand: CommandSpec = {
  name: 'pilot latest-run',
  description: 'Print only the newest run id of an area',
  args: [{ name: 'area', required: true, description: 'area id' }],
  async run(ctx, args) {
    const id = await latestRun(ctx, args[0] as string, false);
    if (id === null) return 1;
    ctx.out(String(id));
    return 0;
  },
};

const yieldsCommand: CommandSpec = {
  name: 'pilot yields',
  description: 'New companies added by each search term and each ZIP (writes yield.csv)',
  args: [{ name: 'runId', required: true, description: 'run id' }],
  async run(ctx, args) {
    const runId = runIdArg(args);
    const db = await ctx.db();
    const y = await computeYields(db, runId);
    for (const line of yieldLines(y)) ctx.out(line);
    const file = await writeYieldCsv(runOutputDir(resolveOutDir(ctx.config()), runId), y);
    ctx.out(`yield.csv: ${file}`);
  },
};

const reprocessCommand: CommandSpec = {
  name: 'pilot reprocess',
  description: 'Re-apply the painter filter, then re-run site-enrich, registries-match, classify, qualify and report from the page cache only (the fix loop)',
  args: [{ name: 'runId', required: true, description: 'run id' }],
  options: [
    { flags: '--stages <list>', description: 'comma-separated subset of site-enrich,registries-match,classify (default: all)' },
    FAKE_OPTION,
    {
      flags: '--live-registries',
      description: 'let registries-match (only) go to the registry sites, for companies whose lookup errored or skipped NJ towns; needs PP_LIVE=1',
    },
  ],
  async run(ctx, args, opts) {
    const runId = runIdArg(args);
    const fake = Boolean(opts.fakeStages);
    const liveRegistries = Boolean(opts.liveRegistries);
    if (liveRegistries && process.env.PP_LIVE !== '1') throw new Error(LIVE_REGISTRIES_NEEDS_PP_LIVE);
    if (liveRegistries && fake) throw new Error('--live-registries cannot be combined with --fake-stages');
    let steps: Set<ReprocessStep> | undefined;
    if (typeof opts.stages === 'string') {
      steps = new Set();
      for (const part of opts.stages.split(',').map((p) => p.trim()).filter((p) => p.length > 0)) {
        if (!REPROCESS_STEPS.includes(part as ReprocessStep)) {
          throw new Error(`unknown stage "${part}"; choose from ${REPROCESS_STEPS.join(', ')}`);
        }
        steps.add(part as ReprocessStep);
      }
    }
    const env = await envFromCommand(ctx, { needFetcher: !fake });
    await reprocessRun(env, runId, { steps, fake, liveRegistries });
  },
};

export const verifyCommandSpec: CommandSpec = {
  name: 'report verify',
  description: 'Check a written report: tabs, exact headers, sources behind every value, ZIP as text, CSV headers; exit 1 on any violation',
  args: [{ name: 'runId', required: true, description: 'run id' }],
  async run(ctx, args) {
    const runId = runIdArg(args);
    const violations = await verifyReport(await ctx.db(), ctx.config(), runId);
    for (const v of violations) ctx.out(`violation: ${v}`);
    ctx.out(violations.length === 0 ? 'report verify: ok' : `report verify: ${violations.length} violation(s)`);
    return violations.length === 0 ? 0 : 1;
  },
};

// ---- accuracy tools (ACC-01..03) ----------------------------------------------------------------------------------

function required(opts: Record<string, unknown>, name: string): string {
  const v = opts[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`--${name} is required`);
  return v;
}

function readOptional(opts: Record<string, unknown>, name: string): string | undefined {
  const v = opts[name];
  return typeof v === 'string' && v.length > 0 ? readFileSync(v, 'utf8') : undefined;
}

async function checkState(ctx: CommandContext, runId: number, opts: Record<string, unknown>): Promise<void> {
  if (typeof opts.state !== 'string') return;
  const run = await loadRun(await ctx.db(), runId);
  if (run.state.toLowerCase() !== opts.state.toLowerCase()) {
    throw new Error(`Run ${runId} is a ${run.state} run, not ${opts.state}`);
  }
}

const STATE_OPTION = { flags: '--state <state>', description: 'NJ | TX | CA (checked against the run; a run has one state)' };
const TRUTH_OPTION = { flags: '--truth <file>', description: "the checker's truth.csv (sample_id, field, value, source_url, checked_at, notes)" };
const ADJ_OPTION = { flags: '--adjudication <file>', description: 'verdicts (correct | wrong) for the unverifiable rows' };

const sampleCommand: CommandSpec = {
  name: 'accuracy sample',
  description: 'Draw the seeded, stratified blind sample of a finished run; writes sample.csv (id, company, Google link only)',
  args: [{ name: 'runId', required: true, description: 'run id (status done)' }],
  options: [{ flags: '--seed <n>', description: 'integer seed, recorded with the sample' }, STATE_OPTION],
  async run(ctx, args, opts) {
    const runId = runIdArg(args);
    const seed = Number(required(opts, 'seed'));
    if (!Number.isInteger(seed)) throw new Error('--seed must be a whole number');
    await checkState(ctx, runId, opts);
    const r = await drawSample(await ctx.db(), ctx.config(), runId, seed);
    const by = (s: string): number => r.samples.filter((x) => x.stratum === s).length;
    ctx.out(`${r.state}: ${r.samples.length} companies (${by('qualified')} qualified, ${by('non_qualified')} other painters, ${by('non_painter')} filtered out), seed ${seed}`);
    ctx.out(`give the checker ONLY: ${r.files.sample}`);
    ctx.out(`truth form: ${r.files.truthTemplate}`);
    ctx.out(`key (keep apart): ${r.files.key}`);
  },
};

const compareCommand: CommandSpec = {
  name: 'accuracy compare',
  description: "Score the checker's truth against the system: correct / wrong / missed / unverifiable, drift rule, Wilson 95% intervals",
  args: [{ name: 'runId', required: true, description: 'run id' }],
  options: [TRUTH_OPTION, ADJ_OPTION, STATE_OPTION],
  async run(ctx, args, opts) {
    const runId = runIdArg(args);
    await checkState(ctx, runId, opts);
    const r = await compareRun(await ctx.db(), ctx.config(), runId, {
      truthText: readFileSync(required(opts, 'truth'), 'utf8'),
      adjudicationText: readOptional(opts, 'adjudication'),
    });
    const counts = (f: string): string => {
      const c = r.summary.counts[f]?.shown;
      return c ? `${c.correct}/${c.correct + c.wrong}` : '0/0';
    };
    ctx.out(`owner ${counts('owner_name')}, email ${counts('email')}, phone ${counts('phone')}, website ${counts('website')} correct among shown values`);
    const unverifiable = r.rows.filter((x) => x.cls === 'unverifiable').length;
    if (unverifiable > 0) ctx.out(`${unverifiable} unverifiable values need an adjudication verdict: pp accuracy adjudication-sheet ${runId}`);
    if (r.summary.unchecked > 0) ctx.out(`${r.summary.unchecked} truth rows were left blank and not scored`);
    if (r.summary.stale > 0) ctx.out(`${r.summary.stale} truth rows were checked more than ${ctx.config().accuracy.truthWithinHours} hours after the run (flagged)`);
    ctx.out(`results: ${r.files.results}`);
    ctx.out(`summary: ${r.files.summaryMd}`);
  },
};

const adjudicationCommand: CommandSpec = {
  name: 'accuracy adjudication-sheet',
  description: 'List the values the checker could not find but the system filled, with their source URL and snippet, for a second look',
  args: [{ name: 'runId', required: true, description: 'run id' }],
  options: [TRUTH_OPTION, ADJ_OPTION, STATE_OPTION],
  async run(ctx, args, opts) {
    const runId = runIdArg(args);
    await checkState(ctx, runId, opts);
    const r = await buildAdjudicationSheet(await ctx.db(), ctx.config(), runId, {
      truthText: readFileSync(required(opts, 'truth'), 'utf8'),
      adjudicationText: readOptional(opts, 'adjudication'),
    });
    ctx.out(`${r.rows} values to adjudicate: ${r.file}`);
  },
};

const goldenExportCommand: CommandSpec = {
  name: 'accuracy golden-export',
  description: "Save the sampled companies' pages, Maps card, registry rows and adjudicated truth as golden fixtures",
  args: [{ name: 'runId', required: true, description: 'run id' }],
  options: [TRUTH_OPTION, ADJ_OPTION, STATE_OPTION, { flags: '--out <dir>', description: 'default: <repo>/fixtures/golden' }],
  async run(ctx, args, opts) {
    const runId = runIdArg(args);
    await checkState(ctx, runId, opts);
    const r = await exportGolden(await ctx.db(), ctx.config(), runId, {
      truthText: readFileSync(required(opts, 'truth'), 'utf8'),
      adjudicationText: readOptional(opts, 'adjudication'),
      outDir: typeof opts.out === 'string' ? opts.out : path.join(REPO_ROOT, 'fixtures', 'golden'),
      fetcher: await ctx.fetcher(),
      replayers: allReplayers(),
    });
    for (const w of r.warnings) ctx.out(`warning: ${w}`);
    ctx.out(`${r.cases.length} golden cases, ${(r.totalBytes / 1_000_000).toFixed(1)} MB in total (target <= 50 MB)`);
  },
};

const fillRatesCommand: CommandSpec = {
  name: 'fillrates',
  description: 'How often owner, email, phone and website are filled, per state (writes fillrates.json per run)',
  args: [{ name: 'runIds', required: true, variadic: true, description: 'run ids' }],
  async run(ctx, args) {
    const db = await ctx.db();
    for (const raw of args) {
      const runId = runIdArg([raw]);
      const r = await computeFillRates(db, ctx.config(), runId);
      for (const line of fillRateLines(r)) ctx.out(line);
      ctx.out(`  written: ${await writeFillRates(ctx.config(), r)}`);
    }
  },
};

export const pilotCommands: CommandSpec[] = [
  planCommand,
  runCommand,
  resumeCommand,
  reportCommand,
  latestRunCommand,
  yieldsCommand,
  reprocessCommand,
  verifyCommandSpec,
  sampleCommand,
  compareCommand,
  adjudicationCommand,
  goldenExportCommand,
  fillRatesCommand,
];
