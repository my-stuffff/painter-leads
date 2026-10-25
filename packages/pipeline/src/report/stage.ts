import path from 'node:path';
import { REPO_ROOT, type Db, type PpConfig, type ReportInput, type ReportResult, type Stage } from '@pp/core';
import { writeCsvFiles } from './csv';
import { buildReportData } from './rows';
import { byCityRows, completenessRows, summaryRows } from './summary';
import { writeWorkbook } from './workbook';

/** config.report.outDir as an absolute path (relative values hang off the repository root). */
export function resolveOutDir(config: PpConfig, override?: string): string {
  const dir = override ?? config.report.outDir;
  return path.isAbsolute(dir) ? dir : path.join(REPO_ROOT, dir);
}

export function runOutputDir(base: string, runId: number): string {
  return path.join(base, String(runId));
}

/** Builds the six tabs and both CSVs for a run into <base>/<run-id>/ (workbook = <area-id>.xlsx). */
export async function generateReport(db: Db, config: PpConfig, runId: number, base: string): Promise<ReportResult> {
  const data = await buildReportData(db, config, runId);
  const dir = runOutputDir(base, runId);
  const xlsxPath = path.join(dir, `${data.run.areaId}.xlsx`);

  const summary = await summaryRows(db, config, {
    runId,
    areaId: data.run.areaId,
    runDate: data.run.createdAt.toISOString().slice(0, 10),
    companies: data.companies,
  });

  await writeWorkbook(xlsxPath, {
    companies: data.companies,
    sources: data.sources,
    byCity: byCityRows(data.companies),
    completeness: completenessRows(data.companies),
    summary,
  });
  const { masterCsvPath, qualifiedCsvPath } = await writeCsvFiles(dir, data.companies);

  return {
    xlsxPath,
    masterCsvPath,
    qualifiedCsvPath,
    counts: {
      companies: data.companies.length,
      qualified: data.companies.filter((c) => c.qualified).length,
      notPainters: data.companies.filter((c) => c.painterStatus === 'not_painter').length,
      sources: data.sources.length,
    },
  };
}

export const reportStage: Stage<ReportInput, ReportResult> = {
  name: 'report',
  async run(ctx, input) {
    return generateReport(ctx.db, ctx.config, input.runId, input.outDir);
  },
};
