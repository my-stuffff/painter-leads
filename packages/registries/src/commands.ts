import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createLogger, SOURCE_IDS, type CommandContext, type CommandSpec, type SourceId, type StageContext } from '@pp/core';
import { checkMasterComplete } from './cslb/completeness';
import { downloadCslbFile, IncompleteDownloadError, type CslbKind } from './cslb/download';
import { loadCslbMaster } from './cslb/master';
import { loadRunInputs } from './inputs';
import { fetchNjOwner } from './nj/detail-flow';
import { townsFor } from './nj/match';
import { ensureNjRosterForTown } from './nj/roster-ensure';
import { createRegistriesStage } from './stage';

const log = createLogger('registries');

export async function stageContext(ctx: CommandContext, runId: number): Promise<StageContext> {
  return {
    runId,
    config: ctx.config(),
    db: await ctx.db(),
    evidence: await ctx.evidence(),
    fetcher: await ctx.fetcher(),
    log: ctx.log,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The date a downloaded file stands for: the portal's "as of" date from the sidecar, else the date in its name, else its mtime. */
export async function capturedAtOf(file: string): Promise<Date> {
  try {
    const side = JSON.parse(await readFile(`${file}.json`, 'utf8')) as { asOf?: string | null; downloadedAt?: string };
    if (side.asOf) return new Date(`${side.asOf}T00:00:00Z`);
    if (side.downloadedAt) return new Date(side.downloadedAt);
  } catch {
    /* no sidecar */
  }
  const m = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(file));
  if (m) return new Date(`${m[1]}T00:00:00Z`);
  return (await stat(file)).mtime;
}

const cslbDownload: CommandSpec = {
  name: 'registries cslb download',
  description: 'Download the CSLB statewide master (or personnel) CSV from the official data portal',
  options: [{ flags: '--kind <kind>', description: 'master or personnel', defaultValue: 'master' }],
  async run(ctx, _args, opts) {
    const kind = (str(opts.kind) ?? 'master') as CslbKind;
    if (kind !== 'master' && kind !== 'personnel') throw new Error(`--kind must be master or personnel, got "${kind}"`);
    try {
      const r = await downloadCslbFile(await ctx.fetcher(), ctx.config(), kind);
      ctx.out(`downloaded ${kind}: ${r.path}`);
      ctx.out(`bytes ${r.bytes}, rows ${r.verdict.rows}, sha256 ${r.sha256}, portal as-of ${r.asOf ?? 'unknown'}`);
    } catch (e) {
      if (e instanceof IncompleteDownloadError) {
        ctx.out(`REFUSED: ${e.message}`);
        ctx.out(`server headers: ${JSON.stringify(e.download.serverHeaders)}`);
        return 1;
      }
      throw e;
    }
  },
};

const cslbLoad: CommandSpec = {
  name: 'registries cslb load',
  description: 'Load a downloaded CSLB master CSV (--master FILE) into the registry tables',
  options: [
    { flags: '--master <file>', description: 'path of the master CSV' },
    { flags: '--captured <date>', description: 'the date the file stands for (YYYY-MM-DD); default: from the download sidecar or file name' },
  ],
  async run(ctx, _args, opts) {
    const master = str(opts.master);
    if (!master) throw new Error('give --master FILE (personnel files load with --personnel FILE)');
    const verdict = await checkMasterComplete(master);
    if (!verdict.ok) {
      ctx.out(`REFUSED: ${master} is not a complete CSLB master file: ${verdict.reason}`);
      return 1;
    }
    const db = await ctx.db();
    const given = str(opts.captured);
    if (given && !/^\d{4}-\d{2}-\d{2}$/.test(given)) throw new Error('--captured must look like 2026-10-23');
    const capturedAt = given ? new Date(`${given}T00:00:00Z`) : await capturedAtOf(master);
    const started = Date.now();
    const r = await loadCslbMaster(db, master, {
      capturedAt,
      onProgress: (n) => {
        if (n % 20000 < 1000) log.info({ rows: n }, 'cslb master load progress');
      },
    });
    ctx.out(`loaded ${r.rows} master rows (${r.soleOwners} sole owners with a readable name) in ${Math.round((Date.now() - started) / 1000)}s`);
  },
};

const match: CommandSpec = {
  name: 'registries match',
  description: 'Run the registries-match stage for every company of a run',
  options: [
    { flags: '--run <id>', description: 'run id' },
    { flags: '--source <source>', description: `only this source (${SOURCE_IDS.join(', ')})` },
    { flags: '--offline', description: 'replay from the page cache only (no network)' },
  ],
  async run(ctx, _args, opts) {
    const runId = Number(str(opts.run));
    if (!Number.isInteger(runId) || runId <= 0) throw new Error('give --run <id>');
    const only = str(opts.source);
    if (only && !(SOURCE_IDS as readonly string[]).includes(only)) throw new Error(`unknown source "${only}"`);
    const stage = createRegistriesStage({
      only: only ? new Set([only as SourceId]) : undefined,
      offline: opts.offline === true,
    });
    const sctx = await stageContext(ctx, runId);
    const inputs = await loadRunInputs(sctx.db, runId);
    const tally: Record<string, number> = {};
    let owners = 0;
    for (const input of inputs) {
      const r = await stage.run(sctx, input);
      owners += r.owners;
      for (const [src, status] of Object.entries(r.status)) tally[`${src}:${status}`] = (tally[`${src}:${status}`] ?? 0) + 1;
    }
    ctx.out(`registries-match run ${runId}: ${inputs.length} companies, ${owners} owners`);
    for (const [k, v] of Object.entries(tally).sort()) ctx.out(`  ${k} ${v}`);
  },
};

const njRoster: CommandSpec = {
  name: 'registries nj roster',
  description: 'Pull (or reuse, if under 7 days old) the free NJ Home Improvement Contractor roster of one or more towns and load it',
  options: [
    { flags: '--town <town...>', description: 'town name (repeat the flag or list several)' },
    { flags: '--from-run <id>', description: 'every distinct listing city of that run (NJ companies), plus the area town' },
  ],
  async run(ctx, _args, opts) {
    const towns = new Set<string>(Array.isArray(opts.town) ? (opts.town as string[]) : typeof opts.town === 'string' ? [opts.town] : []);
    const sctx = await stageContext(ctx, Number(str(opts.fromRun) ?? 0));
    if (str(opts.fromRun)) {
      const runId = Number(str(opts.fromRun));
      if (!Number.isInteger(runId) || runId <= 0) throw new Error('--from-run needs a run id');
      for (const input of await loadRunInputs(sctx.db, runId)) {
        if (input.company.state !== 'NJ') continue;
        for (const t of await townsFor(sctx, input)) towns.add(t);
      }
    }
    if (towns.size === 0) throw new Error('give --town <town> or --from-run <id>');
    for (const town of towns) {
      const r = await ensureNjRosterForTown(sctx, town);
      ctx.out(`${town}: ${r.how}, ${r.rows} registrations loaded`);
    }
  },
};

const njOwner: CommandSpec = {
  name: 'registries nj owner',
  description: 'Read the registered owner of one HIC registration (e.g. 13VH06161800) from the NJ verification site',
  args: [{ name: 'licenceNo', required: true, description: 'HIC registration number, 13VH...' }],
  async run(ctx, args) {
    const no = (args[0] ?? '').trim();
    if (!/^\d{2}VH\d+$/i.test(no)) throw new Error('licence number must look like 13VH06161800');
    const d = await fetchNjOwner(await ctx.fetcher(), no.toUpperCase());
    ctx.out(
      `${d.licenceNo}: ${d.fullName ?? '?'} - owner ${d.ownerName ?? '(none shown)'} - ${d.status ?? '?'} - issued ${d.issueDate ?? '?'} - expires ${d.expirationDate ?? '?'}`,
    );
  },
};

export const commands: CommandSpec[] = [cslbDownload, cslbLoad, njRoster, njOwner, match];
