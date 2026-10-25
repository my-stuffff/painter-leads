import { EXIT_BLOCKED, type CommandContext, type CommandSpec } from '@pp/core';
import { loadRun } from './data';
import { envFromCommand } from './env';
import { planSearches } from './plan';
import { qualifyRun } from './qualify';
import { generateReport, resolveOutDir, runOutputDir } from './report/stage';
import { runPilot } from './run';
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
  args: [{ name: 'area', required: true, description: 'edison_nj | austin_tx | san_diego_ca' }],
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

export const pilotCommands: CommandSpec[] = [
  planCommand,
  runCommand,
  resumeCommand,
  reportCommand,
  latestRunCommand,
  yieldsCommand,
];
