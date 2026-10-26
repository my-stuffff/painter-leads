import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createLogger, EXIT_BLOCKED, SOURCE_IDS, type CommandContext, type CommandSpec, type SourceId, type StageContext } from '@pp/core';
import { captureBbb, importBbb, parseBbbDir } from './bbb/capture';
import { checkMasterComplete } from './cslb/completeness';
import { downloadCslbFile, IncompleteDownloadError, type CslbKind } from './cslb/download';
import { loadCslbMaster } from './cslb/master';
import { lookupCslbPersonnel } from './cslb/lookup';
import { IncompletePersonnelError, loadCslbPersonnel, masterMaxLicence } from './cslb/personnel';
import { loadRunInputs } from './inputs';
import { fetchNjOwner } from './nj/detail-flow';
import { townsFor } from './nj/match';
import { ensureNjRosterForTown } from './nj/roster-ensure';
import { restoreSupersededRegistryEvidence } from './restore';
import { createRegistriesStage } from './stage';
import { queryTxTaxpayers, txStatus } from './tx/opendata';

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
  description: 'Load a downloaded CSLB master CSV (--master FILE) or a COMPLETE personnel CSV (--personnel FILE)',
  options: [
    { flags: '--master <file>', description: 'path of the master CSV' },
    { flags: '--personnel <file>', description: 'path of the personnel CSV (refused unless complete; the master must be loaded first)' },
    { flags: '--captured <date>', description: 'the date the file stands for (YYYY-MM-DD); default: from the download sidecar or file name' },
  ],
  async run(ctx, _args, opts) {
    const personnel = str(opts.personnel);
    const given0 = str(opts.captured);
    if (given0 && !/^\d{4}-\d{2}-\d{2}$/.test(given0)) throw new Error('--captured must look like 2026-10-23');
    if (personnel) {
      const db = await ctx.db();
      const masterMax = await masterMaxLicence(db);
      if (!masterMax) {
        ctx.out('REFUSED: load the CSLB master first (the personnel file is checked against its highest licence number)');
        return 1;
      }
      try {
        const capturedAt = given0 ? new Date(`${given0}T00:00:00Z`) : await capturedAtOf(personnel);
        const r = await loadCslbPersonnel(db, personnel, { capturedAt, masterMax });
        ctx.out(`loaded ${r.people} roles of ${r.licences} licences from ${r.rows} rows (${r.skippedUnknownLicence} rows on licences not in the master)`);
      } catch (e) {
        if (e instanceof IncompletePersonnelError) {
          ctx.out(`REFUSED: ${personnel} is not a complete CSLB personnel file: ${e.verdict.reason}`);
          return 1;
        }
        throw e;
      }
      return;
    }
    const master = str(opts.master);
    if (!master) throw new Error('give --master FILE or --personnel FILE');
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

const cslbLookup: CommandSpec = {
  name: 'registries cslb lookup',
  description: 'Per-licence CSLB lookup for one matched licence (fallback; reports lookup_unavailable when the page needs interaction)',
  args: [{ name: 'licenceNo', required: true, description: 'CSLB licence number' }],
  async run(ctx, args) {
    const r = await lookupCslbPersonnel(await ctx.fetcher(), (args[0] ?? '').trim());
    ctx.out(`${r.licenceNo}: ${r.status} (${r.pages} pages) - ${r.reason}`);
  },
};

const txLookup: CommandSpec = {
  name: 'registries tx lookup',
  description: 'Search data.texas.gov Active Franchise Taxpayers by ZIP and a name word (no Comptroller request)',
  options: [
    { flags: '--zip <zip>', description: '5-digit ZIP' },
    { flags: '--name <word>', description: 'a word of the company name' },
  ],
  async run(ctx, _args, opts) {
    const zip = str(opts.zip);
    const name = str(opts.name);
    if (!zip || !name) throw new Error('give --zip Z and --name WORD');
    const r = await queryTxTaxpayers(await ctx.fetcher(), { zip, nameToken: name });
    ctx.out(`${r.rows.length} taxpayers in ${zip} with "${name.toUpperCase()}" in the name`);
    for (const t of r.rows) ctx.out(`  ${t.taxpayer_number}  ${t.taxpayer_name}  ${t.taxpayer_city ?? ''} ${t.taxpayer_zip ?? ''}  ${txStatus(t)}`);
  },
};

const bbbCapture: CommandSpec = {
  name: 'registries bbb capture',
  description: 'Capture BBB profile pages (run where bbb.org loads, e.g. the Railway test service) into a folder for offline import',
  options: [
    { flags: '--urls <file>', description: 'text file with one profile URL per line' },
    { flags: '--from-sitemaps', description: 'walk the business-profile sitemaps instead' },
    { flags: '--state <st>', description: 'state code with --from-sitemaps' },
    { flags: '--city <city...>', description: 'city name(s) with --from-sitemaps' },
    { flags: '--out <dir>', description: 'output folder (gets <sha256>.html.gz files and manifest.json)' },
    { flags: '--note <text>', description: 'where this capture ran (stored in the manifest)' },
  ],
  async run(ctx, _args, opts) {
    const out = str(opts.out);
    if (!out) throw new Error('give --out DIR');
    const urlsFile = str(opts.urls);
    const cities = Array.isArray(opts.city) ? (opts.city as string[]) : str(opts.city) ? [str(opts.city) as string] : [];
    const state = str(opts.state);
    let source: { urls: string[] } | { state: string; cities: string[] };
    if (urlsFile) {
      source = { urls: (await readFile(urlsFile, 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('https://www.bbb.org/')) };
    } else if (opts.fromSitemaps === true && state && cities.length > 0) {
      source = { state: state.toUpperCase(), cities };
    } else {
      throw new Error('give --urls FILE, or --from-sitemaps --state ST --city CITY');
    }
    const r = await captureBbb(await ctx.fetcher(), source, out, { note: str(opts.note) ?? null });
    const ok = r.manifest.entries.filter((e) => e.status === 200).length;
    ctx.out(`captured ${ok} of ${r.manifest.entries.length} entries into ${out}${r.blocked ? ' - STOPPED: bbb.org blocked this network (Cloudflare)' : ''}`);
    return r.blocked ? EXIT_BLOCKED : undefined;
  },
};

const bbbParse: CommandSpec = {
  name: 'registries bbb parse',
  description: 'Parse a captured BBB folder offline and print the profiles as JSON',
  args: [{ name: 'dir', required: true, description: 'capture folder' }],
  async run(ctx, args) {
    const pages = await parseBbbDir(args[0] as string);
    ctx.out(JSON.stringify(pages.map((p) => ({ ...p.page.profile, capturedAt: p.page.capturedAt })), null, 2));
  },
};

const bbbImport: CommandSpec = {
  name: 'registries bbb import',
  description: "Offline: match a run's companies against a captured BBB folder and store owner evidence",
  args: [{ name: 'dir', required: true, description: 'capture folder' }],
  options: [{ flags: '--run <id>', description: 'run id' }],
  async run(ctx, args, opts) {
    const runId = Number(str(opts.run));
    if (!Number.isInteger(runId) || runId <= 0) throw new Error('give --run <id>');
    const sctx = await stageContext(ctx, runId);
    const inputs = await loadRunInputs(sctx.db, runId);
    const r = await importBbb(sctx, args[0] as string, inputs);
    ctx.out(`imported ${r.profiles} profiles: ${r.matched} of ${r.companies} companies matched, ${r.owners} owners`);
  },
};

const status: CommandSpec = {
  name: 'registries status',
  description: "Per-source registry status counts for a run's companies (from companies.registry_status)",
  options: [{ flags: '--run <id>', description: 'run id' }],
  async run(ctx, _args, opts) {
    const runId = Number(str(opts.run));
    if (!Number.isInteger(runId) || runId <= 0) throw new Error('give --run <id>');
    const db = await ctx.db();
    const res = await db.$client.query('SELECT state, registry_status FROM companies WHERE run_id = $1', [runId]);
    const tally = new Map<string, number>();
    for (const row of res.rows as { state: string | null; registry_status: Record<string, unknown> }[]) {
      for (const [k, v] of Object.entries(row.registry_status ?? {})) {
        const key = `${row.state ?? '?'}  ${k}=${String(v)}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    ctx.out(`registry status for run ${runId}: ${res.rows.length} companies`);
    for (const [k, n] of [...tally].sort()) ctx.out(`  ${k}  ${n}`);
  },
};

const restoreSuperseded: CommandSpec = {
  name: 'registries restore-superseded',
  description: "Put back a run's registry evidence that a reprocess retired ('superseded') and did not write again (safe to repeat)",
  options: [{ flags: '--run <id>', description: 'run id' }],
  async run(ctx, _args, opts) {
    const runId = Number(str(opts.run));
    if (!Number.isInteger(runId) || runId <= 0) throw new Error('give --run <id>');
    const r = await restoreSupersededRegistryEvidence(await ctx.db(), { runId });
    ctx.out(`run ${runId}: ${r.restored} registry values put back on ${r.companies} companies`);
    for (const [k, n] of Object.entries(r.byKind).sort()) ctx.out(`  ${k}  ${n}`);
  },
};

export const commands: CommandSpec[] = [
  cslbDownload,
  cslbLoad,
  cslbLookup,
  njRoster,
  njOwner,
  txLookup,
  bbbCapture,
  bbbParse,
  bbbImport,
  match,
  status,
  restoreSuperseded,
];
