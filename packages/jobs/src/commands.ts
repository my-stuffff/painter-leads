import { hostname } from 'node:os';
import type { CommandSpec } from '@pp/core';
import { envFromCommand } from '@pp/pipeline';
import { rebuildJobExport } from './finish';
import { Worker } from './worker';

const workerCommand: CommandSpec = {
  name: 'worker',
  description: 'Run queued cities of the web app\'s jobs with the pipeline and build each finished job\'s export (runs until stopped)',
  options: [
    { flags: '--id <name>', description: 'worker id (default: this machine\'s host name)' },
    { flags: '--once', description: 'run one city (or one idle pass) and exit' },
    { flags: '--fake-stages', description: 'use stand-in stages for maps / sites / registries (no network; local trials only)' },
  ],
  async run(ctx, _args, opts) {
    const workerId = typeof opts.id === 'string' && opts.id.trim() ? opts.id.trim() : hostname();
    const fake = Boolean(opts.fakeStages);
    const env = await envFromCommand(ctx, { needFetcher: !fake });
    const worker = new Worker({
      workerId,
      env,
      deps: { fake },
      once: Boolean(opts.once),
      note: `pid ${process.pid} on ${hostname()}`,
    });
    // Railway stops a container with SIGTERM: claim nothing new, hand a running city back, exit 0.
    const onSignal = (signal: string) => {
      env.log.info({ worker: workerId, signal }, 'stop requested');
      void worker
        .stop()
        .catch((e: Error) => env.log.error({ err: e.message }, 'could not hand the city back'))
        .finally(() => process.exit(0));
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
    await worker.run();
    return 0;
  },
};

const exportCommand: CommandSpec = {
  name: 'jobs export',
  description: 'Rebuild a job\'s export now (XLSX, CSV, rows) from its finished cities and store it with the job',
  args: [{ name: 'jobId', required: true, description: 'job id' }],
  async run(ctx, args) {
    const jobId = Number(args[0]);
    if (!Number.isInteger(jobId) || jobId <= 0) throw new Error(`"${args[0] ?? ''}" is not a job id`);
    const r = await rebuildJobExport(await ctx.db(), ctx.config(), jobId, (line) => ctx.out(line));
    ctx.out(`job ${jobId}: export ${r.exportStatus}${r.exportError ? ` (${r.exportError})` : ''}, job ${r.status}`);
    return r.exportStatus === 'ready' ? 0 : 1;
  },
};

export const jobCommands: CommandSpec[] = [workerCommand, exportCommand];
