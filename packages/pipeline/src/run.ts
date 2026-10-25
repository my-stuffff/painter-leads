import { EXIT_BLOCKED, type DnsResolver, type ReportResult, type StageRegistry, type StopInfo } from '@pp/core';
import { assignArea } from './area';
import { loadRun, runCompanyIds } from './data';
import { stageContext, type PilotEnv } from './env';
import { enrichCompanies } from './enrich';
import { applyPainterFilter } from './filter';
import { planSearches } from './plan';
import { resolveOutDir, runOutputDir } from './report/stage';
import { resolveStages } from './stages';
import { q, q1 } from './sql';
import { computeYields, writeYieldCsv, yieldLines, type YieldResult } from './yields';

export interface RunOptions {
  /** Continue this run instead of planning a new one (pilot resume). */
  runId?: number;
  /** Stand-in stages for maps / sites / registries (no network). */
  fake?: boolean;
  /** Use this registry instead of resolving one (tests). */
  stages?: StageRegistry;
  /** Re-run site-enrich and registries-match even where they already have a status. */
  refresh?: boolean;
  /** Base directory for run outputs (default: config.report.outDir). */
  outDir?: string;
  /** Public resolver for the listed-website second lookup (tests inject a fake). */
  resolver?: DnsResolver;
}

export interface RunOutcome {
  runId: number;
  exitCode: number;
  status: 'done' | 'blocked' | 'stopped';
  stopped: StopInfo | null;
  report: ReportResult | null;
  yields: YieldResult | null;
}

/**
 * plan -> discover -> detail -> merge -> painter filter -> area -> (Edison expansion) -> site-enrich ->
 * site-finalize -> registries-match -> corroborate / resolve conflicts -> classify -> qualify -> report -> yields.
 * Every step is idempotent, so a run that stopped on a block continues from `runId` without repeating finished work.
 * A block anywhere sets runs.status and returns EXIT_BLOCKED.
 */
export async function runPilot(env: PilotEnv, areaId: string, opts: RunOptions = {}): Promise<RunOutcome> {
  const stages = opts.stages ?? resolveStages({ fake: opts.fake });

  let runId = opts.runId;
  if (runId === undefined) {
    runId = (await planSearches(env.db, env.config, areaId)).runId;
  } else {
    const existing = await loadRun(env.db, runId);
    if (existing.areaId !== areaId) throw new Error(`Run ${runId} is for ${existing.areaId}, not ${areaId}`);
    await planSearches(env.db, env.config, areaId, 'pilot', runId);
  }
  const id = runId;
  await q(
    env.db,
    `UPDATE runs SET status = 'running', stopped_reason = NULL, started_at = COALESCE(started_at, $2), finished_at = NULL WHERE id = $1`,
    [id, env.now()],
  );
  const ctx = stageContext(env, id);

  const stop = async (info: StopInfo): Promise<RunOutcome> => {
    const status = info.signal === 'daily_cap' ? 'stopped' : 'blocked';
    await q(env.db, `UPDATE runs SET status = $2, stopped_reason = $3 WHERE id = $1`, [id, status, `${info.signal}: ${info.detail}`]);
    env.out(`run ${id} ${status} (${info.signal}); continue with: pp pilot resume ${id}`);
    return { runId: id, exitCode: EXIT_BLOCKED, status, stopped: info, report: null, yields: null };
  };

  const discoverAndDetail = async (): Promise<StopInfo | null> => {
    for (let guard = 0; guard < 10000; guard++) {
      const d = await stages.discover.run(ctx, { runId: id });
      if (d.stopped) return d.stopped;
      if (d.searchesRemaining === 0 || d.searchesDone === 0) break;
    }
    const det = await stages.detail.run(ctx, { runId: id });
    return det.stopped;
  };

  const mergeFilterArea = async (): Promise<void> => {
    const merged = await stages.merge.run(ctx, { runId: id });
    env.log.info({ runId: id, ...merged }, 'merged');
    await applyPainterFilter(env.db, id);
    await assignArea(env.db, env.evidence, env.config, id, env.now());
  };

  try {
    let stopInfo = await discoverAndDetail();
    if (stopInfo) return await stop(stopInfo);
    await mergeFilterArea();

    // D-08: Edison adds the Metuchen / Woodbridge ZIPs only when it yields too few painting companies.
    const threshold = env.config.areas.expandIfPaintersBelow[areaId];
    if (threshold !== undefined) {
      const expanded = await q1<{ n: string }>(env.db, `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1 AND phase = 'expansion'`, [id]);
      if (Number(expanded?.n ?? 0) === 0) {
        const painters = await q1<{ n: string }>(
          env.db,
          `SELECT COUNT(*) AS n FROM companies WHERE painter_status = 'painter' AND in_area = true AND id = ANY($1::int[])`,
          [await runCompanyIds(env.db, id)],
        );
        if (Number(painters?.n ?? 0) < threshold) {
          const planned = await planSearches(env.db, env.config, areaId, 'expansion', id);
          env.out(`only ${painters?.n ?? 0} painting companies in ${areaId} (< ${threshold}): ${planned.inserted} expansion searches added`);
          if (planned.inserted > 0) {
            stopInfo = await discoverAndDetail();
            if (stopInfo) return await stop(stopInfo);
            await mergeFilterArea();
          }
        }
      }
    }

    await enrichCompanies(ctx, stages, id, { refresh: opts.refresh, resolver: opts.resolver });

    for (const companyId of await runCompanyIds(env.db, id)) {
      await stages.qualify.run(ctx, { companyId });
    }

    const base = resolveOutDir(env.config, opts.outDir);
    const report = await stages.report.run(ctx, { runId: id, outDir: base });
    const yields = await computeYields(env.db, id);
    await writeYieldCsv(runOutputDir(base, id), yields);

    await q(env.db, `UPDATE runs SET status = 'done', finished_at = $2 WHERE id = $1`, [id, env.now()]);
    env.out(`run ${id} done`);
    env.out(`xlsx: ${report.xlsxPath}`);
    env.out(`master csv: ${report.masterCsvPath}`);
    env.out(`qualified csv: ${report.qualifiedCsvPath}`);
    for (const line of yieldLines(yields)) env.log.debug(line);
    return { runId: id, exitCode: 0, status: 'done', stopped: null, report, yields };
  } catch (e) {
    await q(env.db, `UPDATE runs SET status = 'failed', stopped_reason = $2 WHERE id = $1`, [id, (e as Error).message.slice(0, 500)]);
    throw e;
  }
}
