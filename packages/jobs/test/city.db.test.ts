import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, truncateAll, type StageRegistry, type StopInfo } from '@pp/core';
import { resolveStages } from '@pp/pipeline';
import { runCity, nextUtcMidnight } from '../src/city';
import { claimNext, finishArea, registerWorker, type ClaimedArea } from '../src/queue';
import { Worker } from '../src/worker';
import { createDbFakeStagesForTest } from './fake-block';
import { areaRow, createJob, jobRow, makeEnv, tempDir } from './helpers';

const handle = getTestDb();
const db = handle.db;

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
  await registerWorker(db, 'w1');
});

const stop = (signal: StopInfo['signal']): StopInfo => ({ signal, searchId: null, listingId: null, at: new Date(), detail: 'test' });

/** Fake stages whose discover always stops with this signal. */
function stoppingStages(signal: StopInfo['signal']): StageRegistry {
  return {
    ...resolveStages({ fake: true }),
    discover: {
      name: 'discover',
      run: async () => ({ searchesDone: 0, searchesRemaining: 1, cardsSeen: 0, newListings: 0, stopped: stop(signal) }),
    },
  };
}

async function claimEdison(o: { attempts?: number; reuseDays?: number } = {}): Promise<ClaimedArea> {
  const { areaIds } = await createJob(db, [{ areaId: 'edison_nj', state: 'NJ', label: 'Edison, NJ' }], {
    settings: { reuseDays: o.reuseDays ?? 30 },
  });
  if (o.attempts) await db.$client.query(`UPDATE job_areas SET attempts = $2 WHERE id = $1`, [areaIds[0], o.attempts - 1]);
  const area = await claimNext(db, 'w1');
  if (!area) throw new Error('nothing claimed');
  return area;
}

async function insertRun(status: string, finishedDaysAgo: number | null): Promise<number> {
  const r = await db.$client.query(
    `INSERT INTO runs (area_id, state, status, config_snapshot, finished_at)
     VALUES ('edison_nj', 'NJ', $1, '{}'::jsonb, CASE WHEN $2::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $2::float8 * 86400) END)
     RETURNING id`,
    [status, finishedDaysAgo],
  );
  return r.rows[0].id as number;
}

describe('running a city', () => {
  it('reuses a finished run younger than reuseDays (newest first) instead of scraping', async () => {
    await insertRun('done', 40);
    const fresh = await insertRun('done', 3);
    await insertRun('done', 10);
    const area = await claimEdison({ reuseDays: 30 });
    const outcome = await runCity(makeEnv(db), 'w1', area, { stages: stoppingStages('captcha') });
    expect(outcome).toMatchObject({ status: 'reused', runId: fresh });
    expect(outcome.message).toMatch(/^Used data from \d{4}-\d{2}-\d{2}$/);
  });

  it('does not reuse a run older than reuseDays, nor any run when reuseDays is 0', async () => {
    await insertRun('done', 40);
    const old = await runCity(makeEnv(db), 'w1', await claimEdison({ reuseDays: 30 }), { stages: stoppingStages('captcha') });
    expect(old.status).toBe('waiting');

    await truncateAll(db);
    await registerWorker(db, 'w1');
    await insertRun('done', 1);
    const never = await runCity(makeEnv(db), 'w1', await claimEdison({ reuseDays: 0 }), { stages: stoppingStages('captcha') });
    expect(never.status).toBe('waiting');
  });

  it('plans a new run, saves its id on the city at once, and finishes it with the engine', async () => {
    const area = await claimEdison({ reuseDays: 0 });
    const outcome = await runCity(makeEnv(db), 'w1', area, { fake: true, outDir: tempDir() });
    expect(outcome).toMatchObject({ status: 'done', message: null });
    expect((await areaRow(db, area.id)).run_id).toBe(outcome.runId);
    const run = (await db.$client.query(`SELECT status, config_snapshot FROM runs WHERE id = $1`, [outcome.runId])).rows[0];
    expect(run.status).toBe('done');
    // the job's terms reach the pipeline; the thresholds stay the base config's
    expect(run.config_snapshot.search.terms).toEqual(area.settings.terms);
    expect(run.config_snapshot.qualification.minRating).toBe(4.7);
  });

  it('resumes the newest unfinished run of the area instead of planning another', async () => {
    const unfinished = await insertRun('blocked', null);
    const area = await claimEdison({ reuseDays: 0 });
    const outcome = await runCity(makeEnv(db), 'w1', area, { fake: true, outDir: tempDir() });
    expect(outcome).toMatchObject({ status: 'done', runId: unfinished });
    expect(Number((await db.$client.query(`SELECT COUNT(*) AS n FROM runs`)).rows[0].n)).toBe(1);
  });

  it('on a block: one retry-limited detail pass, then the run again (here it gets through)', async () => {
    const area = await claimEdison({ reuseDays: 0 });
    const retryLimited = vi.fn(async (_env: unknown, _runId: number) => ({ done: 0, limitedView: 0, failed: 0, stopped: null }));
    const outcome = await runCity(makeEnv(db), 'w1', area, { stages: createDbFakeStagesForTest(), retryLimited, outDir: tempDir() });
    expect(retryLimited).toHaveBeenCalledTimes(1);
    expect(retryLimited.mock.calls[0]?.[1]).toBe(outcome.runId);
    expect(outcome.status).toBe('done');
  });

  it('still blocked: waiting 30 minutes with the time in plain words', async () => {
    const area = await claimEdison({ reuseDays: 0 });
    const retryLimited = vi.fn(async () => ({ done: 0, limitedView: 0, failed: 0, stopped: null }));
    const before = Date.now();
    const outcome = await runCity(makeEnv(db), 'w1', area, { stages: stoppingStages('limited_view_streak'), retryLimited });
    expect(retryLimited).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('waiting');
    const wait = (outcome.notBefore as Date).getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(wait).toBeLessThan(31 * 60_000);
    expect(outcome.message).toMatch(/^Google is limiting views — trying again at \d\d:\d\d UTC$/);
    expect(outcome.runId).not.toBeNull();
  });

  it('the 6th blocked try finishes the run with what it has', async () => {
    const area = await claimEdison({ reuseDays: 0, attempts: 6 });
    expect(area.attempts).toBe(6);
    const outcome = await runCity(makeEnv(db), 'w1', area, {
      stages: stoppingStages('captcha'),
      retryLimited: async () => ({ done: 0, limitedView: 0, failed: 0, stopped: null }),
      outDir: tempDir(),
    });
    expect(outcome.status).toBe('done');
    expect(outcome.message).toMatch(/^Finished with 0 listings Google kept hidden; \d+ searches not done$/);
    expect((await db.$client.query(`SELECT status FROM runs WHERE id = $1`, [outcome.runId])).rows[0].status).toBe('done');
  });

  it('the daily cap waits until the next midnight UTC', async () => {
    const area = await claimEdison({ reuseDays: 0 });
    const outcome = await runCity(makeEnv(db), 'w1', area, { stages: stoppingStages('daily_cap') });
    expect(outcome.status).toBe('waiting');
    expect((outcome.notBefore as Date).toISOString()).toBe(nextUtcMidnight(new Date()).toISOString());
    expect(outcome.message).toBe('Daily limit reached — continuing at 00:00 UTC');
    expect(nextUtcMidnight(new Date('2026-10-28T23:59:00Z')).toISOString()).toBe('2026-10-29T00:00:00.000Z');
  });

  it('an error waits 5 minutes, and fails the city on the 3rd try', async () => {
    const throwing: StageRegistry = {
      ...resolveStages({ fake: true }),
      discover: {
        name: 'discover',
        run: async () => {
          throw new Error('browser crashed');
        },
      },
    };
    const first = await runCity(makeEnv(db), 'w1', await claimEdison({ reuseDays: 0 }), { stages: throwing });
    expect(first.status).toBe('waiting');
    expect(first.message).toMatch(/^Error: browser crashed — trying again at \d\d:\d\d UTC$/);

    await truncateAll(db);
    await registerWorker(db, 'w1');
    const third = await runCity(makeEnv(db), 'w1', await claimEdison({ reuseDays: 0, attempts: 3 }), { stages: throwing });
    expect(third).toMatchObject({ status: 'failed', message: 'Stopped after 3 tries: browser crashed' });
  });

  it('a city claimed more than 10 times (its worker kept dying) is failed without running', async () => {
    const area = await claimEdison({ reuseDays: 0, attempts: 11 });
    const outcome = await runCity(makeEnv(db), 'w1', area, { stages: stoppingStages('captcha') });
    expect(outcome).toMatchObject({ status: 'failed', message: 'Stopped after 10 tries: the worker kept stopping during this city' });
    expect(Number((await db.$client.query(`SELECT COUNT(*) AS n FROM runs`)).rows[0].n)).toBe(0);
  });

  it('a blocked city of a cancelled job is cancelled, not put back to wait', async () => {
    const area = await claimEdison({ reuseDays: 0 });
    await db.$client.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [area.jobId]);
    const outcome = await runCity(makeEnv(db), 'w1', area, {
      stages: stoppingStages('captcha'),
      retryLimited: async () => ({ done: 0, limitedView: 0, failed: 0, stopped: null }),
    });
    expect(outcome).toMatchObject({ status: 'cancelled', message: 'Cancelled' });
    expect(await finishArea(db, 'w1', area.id, outcome)).toBe(true);
    expect((await areaRow(db, area.id)).finished_at).not.toBeNull();
  });
});

describe('the worker loop', () => {
  it('claims, runs, records the city, builds the export and settles the job', async () => {
    const { jobId, areaIds } = await createJob(db, [{ areaId: 'edison_nj', state: 'NJ', label: 'Edison, NJ' }], {
      settings: { reuseDays: 0 },
    });
    const worker = new Worker({ workerId: 'w1', env: makeEnv(db), deps: { fake: true, outDir: tempDir() }, once: true });
    await worker.run();

    expect(await areaRow(db, areaIds[0] as number)).toMatchObject({ status: 'done', worker_id: 'w1' });
    const job = await jobRow(db, jobId);
    expect(job).toMatchObject({ status: 'done', export_status: 'ready', export_error: null });
    expect(job.finished_at).not.toBeNull();
    const exp = (await db.$client.query(`SELECT rows, summary, length(xlsx) AS x, length(csv) AS c FROM job_exports WHERE job_id = $1`, [jobId]))
      .rows[0];
    expect(exp.x).toBeGreaterThan(1000);
    expect(exp.c).toBeGreaterThan(100);
    const painting = (exp.rows as { list: string; company: string }[]).filter((r) => r.list === 'painting').map((r) => r.company);
    expect(painting.sort()).toEqual(['Fake Expansion Painting', 'Fake Painting One', 'Fake Service Area Painting']);
    expect(exp.summary.counts.painting).toBe(3);
    expect(exp.summary.citiesIncluded).toBe(1);
    expect((await db.$client.query(`SELECT job_area_id FROM workers WHERE id = 'w1'`)).rows[0].job_area_id).toBeNull();
  });

  it('an idle pass builds the export of a finished job whose export was set back to none (rebuild)', async () => {
    const { jobId } = await createJob(db, [{ areaId: 'edison_nj', state: 'NJ', label: 'Edison, NJ' }], { settings: { reuseDays: 0 } });
    await new Worker({ workerId: 'w1', env: makeEnv(db), deps: { fake: true, outDir: tempDir() }, once: true }).run();
    const built1 = (await db.$client.query(`SELECT built_at FROM job_exports WHERE job_id = $1`, [jobId])).rows[0].built_at as Date;

    await db.$client.query(`UPDATE jobs SET export_status = 'none' WHERE id = $1`, [jobId]);
    await new Worker({ workerId: 'w1', env: makeEnv(db), once: true }).run(); // nothing to claim: idle pass
    expect(await jobRow(db, jobId)).toMatchObject({ status: 'done', export_status: 'ready' });
    const built2 = (await db.$client.query(`SELECT built_at FROM job_exports WHERE job_id = $1`, [jobId])).rows[0].built_at as Date;
    expect(built2.getTime()).toBeGreaterThan(built1.getTime());
  });
});
