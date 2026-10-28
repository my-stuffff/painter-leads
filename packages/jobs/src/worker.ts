import type { PilotEnv } from '@pp/pipeline';
import { runCity, type CityDeps } from './city';
import { finishJob, finishReadyJobs } from './finish';
import {
  claimNext,
  finishArea,
  heartbeat,
  registerWorker,
  releaseArea,
  sweepCancelled,
  type ClaimedArea,
} from './queue';

export const HEARTBEAT_MS = 30_000;
export const IDLE_MS = 10_000;

export interface WorkerOptions {
  workerId: string;
  /** The base env (config = the base pp config; each city gets its job's search terms). */
  env: PilotEnv;
  deps?: CityDeps;
  heartbeatMs?: number;
  idleMs?: number;
  /** Stop after one city (or at the first idle tick). */
  once?: boolean;
  /** Written into workers.note. */
  note?: string;
}

/**
 * The worker loop (pp worker): claim a city, run it with the existing engine, record how it ended, build the
 * job's export once all its cities are finished; when there is nothing to claim, finish due exports and idle.
 * A city error never stops the loop. stop() ends it: a city in progress is handed back to the queue.
 */
export class Worker {
  private stopping = false;
  private current: ClaimedArea | null = null;
  private wake: (() => void) | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: WorkerOptions) {}

  private get db() {
    return this.o.env.db;
  }

  private log(fields: Record<string, unknown>, msg: string): void {
    this.o.env.log.info({ worker: this.o.workerId, ...fields }, msg);
  }

  private async sleep(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    this.wake = null;
  }

  private async tick(): Promise<void> {
    try {
      await heartbeat(this.db, this.o.workerId, this.current?.id ?? null);
    } catch (e) {
      this.o.env.log.warn({ worker: this.o.workerId, err: (e as Error).message }, 'heartbeat failed');
    }
  }

  /** Runs until stop() (or one city with `once`). */
  async run(): Promise<void> {
    const reset = await registerWorker(this.db, this.o.workerId, this.o.note ?? null);
    this.log({ reset }, reset > 0 ? `worker started; ${reset} city(ies) it held put back in the queue` : 'worker started');
    this.beat = setInterval(() => void this.tick(), this.o.heartbeatMs ?? HEARTBEAT_MS);
    try {
      while (!this.stopping) {
        const worked = await this.step();
        if (this.o.once) break;
        if (!worked) await this.sleep(this.o.idleMs ?? IDLE_MS);
      }
    } finally {
      if (this.beat) clearInterval(this.beat);
      this.beat = null;
    }
  }

  /** One pass: sweep cancelled cities, claim and run one city (true), or finish due exports (false). */
  async step(): Promise<boolean> {
    try {
      const swept = await sweepCancelled(this.db);
      if (swept > 0) this.log({ swept }, 'cities of cancelled jobs marked cancelled');
      if (this.stopping) return false;

      const area = await claimNext(this.db, this.o.workerId);
      if (!area) {
        for (const r of await finishReadyJobs(this.db, this.o.env.config, (l) => this.log({}, l))) {
          this.log({ ...r }, `job ${r.jobId} finished: ${r.status}, export ${r.exportStatus}`);
        }
        return false;
      }

      this.current = area;
      this.log(
        { jobId: area.jobId, jobAreaId: area.id, areaId: area.areaId, attempt: area.attempts },
        `claimed ${area.label} (job ${area.jobId})`,
      );
      const outcome = await runCity(this.o.env, this.o.workerId, area, this.o.deps);
      if (this.stopping) return true; // stop() already handed the city back
      const ours = await finishArea(this.db, this.o.workerId, area.id, outcome);
      this.current = null;
      this.log(
        { jobId: area.jobId, jobAreaId: area.id, ...outcome, recorded: ours },
        `${area.label}: ${outcome.status}${outcome.message ? ` (${outcome.message})` : ''}`,
      );
      const finished = await finishJob(this.db, this.o.env.config, area.jobId, (l) => this.log({ jobId: area.jobId }, l));
      if (finished) this.log({ ...finished }, `job ${finished.jobId} finished: ${finished.status}, export ${finished.exportStatus}`);
      return true;
    } catch (e) {
      // Queue / database trouble: log it and carry on after the idle pause.
      this.o.env.log.error({ worker: this.o.workerId, err: (e as Error).message }, 'worker step failed');
      this.current = null;
      return false;
    }
  }

  /** Stops the loop; a city in progress goes back to the queue (its run is resumed by the next claim). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    if (this.beat) clearInterval(this.beat);
    const area = this.current;
    this.current = null;
    if (area) {
      await releaseArea(this.db, this.o.workerId, area.id);
      this.log({ jobAreaId: area.id }, `stopping: ${area.label} handed back to the queue`);
    }
  }
}
