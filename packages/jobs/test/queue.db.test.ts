import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll } from '@pp/core';
import { finishReadyJobs } from '../src/finish';
import {
  claimNext,
  finishArea,
  heartbeat,
  jobsReadyToFinish,
  registerWorker,
  releaseArea,
  sweepCancelled,
} from '../src/queue';
import { areaRow, createJob, jobRow, testConfig } from './helpers';

const handle = getTestDb();
const db = handle.db;

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
  for (const w of ['w1', 'w2', 'w3']) await registerWorker(db, w);
});

const claimId = async (worker: string): Promise<number | null> => (await claimNext(db, worker))?.id ?? null;

describe('claiming cities', () => {
  it('takes the oldest job first, then position, and marks the city and the job running', async () => {
    const a = await createJob(db, [
      { areaId: 'fresno_ca', state: 'CA' },
      { areaId: 'houston_tx', state: 'TX' },
    ]);
    const b = await createJob(db, [{ areaId: 'newark_nj', state: 'NJ' }]);

    const first = await claimNext(db, 'w1');
    expect(first).toMatchObject({ id: a.areaIds[0], jobId: a.jobId, areaId: 'fresno_ca', state: 'CA', attempts: 1, runId: null });
    expect(first?.settings.minRating).toBe(4.7);
    expect(await claimId('w2')).toBe(a.areaIds[1]);
    expect(await claimId('w3')).toBe(b.areaIds[0]);
    expect(await claimId('w3')).toBeNull();

    const area = await areaRow(db, a.areaIds[0] as number);
    expect(area).toMatchObject({ status: 'running', worker_id: 'w1', attempts: 1 });
    expect(area.heartbeat_at).not.toBeNull();
    expect(area.started_at).not.toBeNull();
    const job = await jobRow(db, a.jobId);
    expect(job.status).toBe('running');
    expect(job.started_at).not.toBeNull();
    expect((await db.$client.query(`SELECT job_area_id FROM workers WHERE id = 'w1'`)).rows[0].job_area_id).toBe(a.areaIds[0]);
  });

  it('runs one city per state at a time, across jobs', async () => {
    const a = await createJob(db, [
      { areaId: 'houston_tx', state: 'TX' },
      { areaId: 'dallas_tx', state: 'TX' },
      { areaId: 'fresno_ca', state: 'CA' },
    ]);
    const b = await createJob(db, [{ areaId: 'austin_tx_city', state: 'TX' }]);

    expect(await claimId('w1')).toBe(a.areaIds[0]); // Houston
    expect(await claimId('w2')).toBe(a.areaIds[2]); // Dallas waits for Houston: Fresno instead
    expect(await claimId('w3')).toBeNull(); // Austin (job b) is TX too

    await finishArea(db, 'w1', a.areaIds[0] as number, { status: 'done', runId: null });
    expect(await claimId('w1')).toBe(a.areaIds[1]); // Dallas now
    expect(await claimId('w3')).toBeNull();
    await finishArea(db, 'w1', a.areaIds[1] as number, { status: 'done' });
    expect(await claimId('w3')).toBe(b.areaIds[0]);
  });

  it('two workers claiming at once never get the same city', async () => {
    await createJob(db, [
      { areaId: 'houston_tx', state: 'TX' },
      { areaId: 'fresno_ca', state: 'CA' },
      { areaId: 'newark_nj', state: 'NJ' },
    ]);
    const got = await Promise.all(['w1', 'w2', 'w3'].map((w) => claimId(w)));
    expect(got.every((id) => id !== null)).toBe(true);
    expect(new Set(got).size).toBe(3);
  });

  it('takes over a running city whose heartbeat is older than 10 minutes; the old worker can no longer record it', async () => {
    const a = await createJob(db, [
      { areaId: 'houston_tx', state: 'TX' },
      { areaId: 'dallas_tx', state: 'TX' },
    ]);
    expect(await claimId('w1')).toBe(a.areaIds[0]);
    expect(await claimId('w2')).toBeNull();

    // a live heartbeat keeps it
    await db.$client.query(`UPDATE job_areas SET heartbeat_at = now() - interval '9 minutes' WHERE id = $1`, [a.areaIds[0]]);
    expect(await claimId('w2')).toBeNull();

    await db.$client.query(`UPDATE job_areas SET heartbeat_at = now() - interval '11 minutes' WHERE id = $1`, [a.areaIds[0]]);
    const taken = await claimNext(db, 'w2');
    expect(taken).toMatchObject({ id: a.areaIds[0], attempts: 2 });
    expect(await areaRow(db, a.areaIds[0] as number)).toMatchObject({ status: 'running', worker_id: 'w2' });

    expect(await finishArea(db, 'w1', a.areaIds[0] as number, { status: 'done' })).toBe(false);
    expect((await areaRow(db, a.areaIds[0] as number)).status).toBe('running');
    await heartbeat(db, 'w1', a.areaIds[0] as number); // the old worker's heartbeat does not touch it either
    expect(await finishArea(db, 'w2', a.areaIds[0] as number, { status: 'done' })).toBe(true);
  });

  it('a restarted worker puts the cities it held back in the queue', async () => {
    const a = await createJob(db, [
      { areaId: 'houston_tx', state: 'TX' },
      { areaId: 'fresno_ca', state: 'CA' },
    ]);
    await claimId('w1');
    await claimId('w2');
    expect(await registerWorker(db, 'w1')).toBe(1);
    expect(await areaRow(db, a.areaIds[0] as number)).toMatchObject({ status: 'queued', worker_id: null, heartbeat_at: null });
    expect((await areaRow(db, a.areaIds[1] as number)).status).toBe('running'); // w2's city untouched
    expect(await claimId('w3')).toBe(a.areaIds[0]);
  });

  it('a waiting city is picked up only once its time has come', async () => {
    const a = await createJob(db, [{ areaId: 'houston_tx', state: 'TX' }]);
    await claimId('w1');
    await finishArea(db, 'w1', a.areaIds[0] as number, {
      status: 'waiting',
      notBefore: new Date(Date.now() + 30 * 60_000),
      message: 'Google is limiting views — trying again at 12:30 UTC',
    });
    expect(await areaRow(db, a.areaIds[0] as number)).toMatchObject({ status: 'waiting', finished_at: null });
    expect(await claimId('w2')).toBeNull();
    await db.$client.query(`UPDATE job_areas SET not_before = now() - interval '1 second' WHERE id = $1`, [a.areaIds[0]]);
    const again = await claimNext(db, 'w2');
    expect(again).toMatchObject({ id: a.areaIds[0], attempts: 2 });
    expect(await areaRow(db, a.areaIds[0] as number)).toMatchObject({ message: null, not_before: null });
  });

  it('a stopping worker hands its city back without counting the try', async () => {
    const a = await createJob(db, [{ areaId: 'houston_tx', state: 'TX' }]);
    await claimId('w1');
    await releaseArea(db, 'w1', a.areaIds[0] as number);
    expect(await areaRow(db, a.areaIds[0] as number)).toMatchObject({ status: 'queued', worker_id: null, attempts: 0 });
  });
});

describe('cancel', () => {
  it('a cancelled job gets no new claims; its waiting / queued / orphaned cities are swept; the job stays cancelled', async () => {
    const a = await createJob(db, [
      { areaId: 'houston_tx', state: 'TX' },
      { areaId: 'fresno_ca', state: 'CA' },
      { areaId: 'newark_nj', state: 'NJ' },
      { areaId: 'dallas_tx', state: 'TX' },
    ]);
    const [houston, fresno, newark, dallas] = a.areaIds as [number, number, number, number];
    expect(await claimId('w1')).toBe(houston);
    expect(await claimId('w2')).toBe(fresno);
    await finishArea(db, 'w2', fresno, { status: 'waiting', notBefore: new Date(Date.now() - 1000) });
    await db.$client.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [a.jobId]);

    expect(await claimId('w3')).toBeNull(); // Fresno is due, Newark queued: neither is claimed
    expect(await sweepCancelled(db)).toBe(3); // Fresno (waiting), Newark and Dallas (queued)
    expect((await areaRow(db, newark)).status).toBe('cancelled');
    expect((await areaRow(db, dallas)).status).toBe('cancelled');
    expect((await areaRow(db, houston)).status).toBe('running'); // a running city finishes first
    expect(await jobsReadyToFinish(db)).toEqual([]);

    await finishArea(db, 'w1', houston, { status: 'done' });
    expect(await jobsReadyToFinish(db)).toEqual([a.jobId]);
    // Houston has no run in this test, so nothing feeds the export: it fails, the job stays cancelled.
    const [r] = await finishReadyJobs(db, testConfig());
    expect(r).toMatchObject({ jobId: a.jobId, status: 'cancelled', exportStatus: 'failed' });
    expect(await jobRow(db, a.jobId)).toMatchObject({ status: 'cancelled', export_status: 'failed' });
    expect((await jobRow(db, a.jobId)).finished_at).not.toBeNull();
  });
});

describe('finishing jobs', () => {
  it('a job whose cities all failed is failed, with no export, and is not picked up again', async () => {
    const a = await createJob(db, [{ areaId: 'houston_tx', state: 'TX' }]);
    await claimId('w1');
    await finishArea(db, 'w1', a.areaIds[0] as number, { status: 'failed', message: 'Stopped after 3 tries: boom' });
    expect(await jobsReadyToFinish(db)).toEqual([a.jobId]);
    const done = await finishReadyJobs(db, testConfig());
    expect(done).toEqual([{ jobId: a.jobId, status: 'failed', exportStatus: 'failed', exportError: 'No city finished' }]);
    expect(await jobRow(db, a.jobId)).toMatchObject({ status: 'failed', export_status: 'failed', error: 'No city finished' });
    expect(await jobsReadyToFinish(db)).toEqual([]);
  });
});
