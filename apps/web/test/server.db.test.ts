import { getTestDb, truncateAll } from '@pp/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobDetail, JobSummary, LeadRow, Me, UserRow } from '../src/shared/api';
import { DEFAULT_JOB_SETTINGS } from '../src/shared/api';
import { createApp } from '../src/server/app';
import { bootstrapAdmin, hashPassword } from '../src/server/auth';
import type { CatalogFileCity } from '../src/server/catalog';

const BOM = String.fromCharCode(0xfeff);
const { db, close } = getTestDb();
const pool = db.$client;

const cities: CatalogFileCity[] = [
  { areaId: 'houston_tx', state: 'TX', name: 'Houston', population: 2390125, popYear: 2024, lat: 29.7, lng: -95.4, zipCount: 92 },
  { areaId: 'newark_nj', state: 'NJ', name: 'Newark', population: 317303, popYear: 2024, lat: 40.7, lng: -74.2, zipCount: 9 },
];
const app = createApp({ pool, cities, secureCookies: false });

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

const call = (cookie: string, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });

async function addUser(email: string, role: string): Promise<void> {
  await pool.query(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, $1, $2, $3)`, [
    email,
    role,
    await hashPassword('password-123'),
  ]);
}

beforeEach(async () => {
  await truncateAll(db);
  await bootstrapAdmin(pool, 'Admin@Example.com', 'admin-pass-1');
});
afterAll(close);

describe('sign-in', () => {
  it('creates the first admin once, signs in case-insensitively, refuses a wrong password and an unsigned call', async () => {
    expect(await bootstrapAdmin(pool, 'other@example.com', 'x')).toBe(false);
    const cookie = await signIn('admin@example.com', 'admin-pass-1');
    const me = (await (await call(cookie, '/api/auth/me')).json()) as Me;
    expect(me).toMatchObject({ email: 'admin@example.com', role: 'admin' });

    const wrong = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'nope' }),
    });
    expect(wrong.status).toBe(401);
    expect((await app.request('/api/jobs')).status).toBe(401);

    await call(cookie, '/api/auth/logout', { method: 'POST' });
    expect((await call(cookie, '/api/auth/me')).status).toBe(401);
  });

  it('refuses a change sent from another site', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass-1');
    const res = await call(cookie, '/api/jobs', {
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'localhost' },
      body: JSON.stringify({ areaIds: ['houston_tx'], settings: DEFAULT_JOB_SETTINGS }),
    });
    expect(res.status).toBe(403);
  });
});

describe('jobs', () => {
  it('queues cities in the order given, names the job, and lists it', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass-1');
    const res = await call(cookie, '/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ areaIds: ['newark_nj', 'houston_tx'], settings: DEFAULT_JOB_SETTINGS }),
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as JobDetail;
    expect(job.status).toBe('queued');
    expect(job.states).toEqual(['NJ', 'TX']);
    expect(job.name).toBe('NJ, TX · 2 cities');
    expect(job.areas.map((a) => [a.areaId, a.label, a.status])).toEqual([
      ['newark_nj', 'Newark, NJ', 'queued'],
      ['houston_tx', 'Houston, TX', 'queued'],
    ]);
    expect(job.etaMinutes).toBe(Math.round((9 + 92) * 1.5));
    const list = (await (await call(cookie, '/api/jobs')).json()) as JobSummary[];
    expect(list.map((j) => j.id)).toEqual([job.id]);
  });

  it('refuses an unknown city and an upside-down review range', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass-1');
    const unknown = await call(cookie, '/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ areaIds: ['atlantis_ca'], settings: DEFAULT_JOB_SETTINGS }),
    });
    expect(unknown.status).toBe(400);
    const range = await call(cookie, '/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ areaIds: ['houston_tx'], settings: { ...DEFAULT_JOB_SETTINGS, minReviews: 50, maxReviews: 10 } }),
    });
    expect(range.status).toBe(400);
  });

  it('cancel stops queued cities; retry puts them back', async () => {
    const cookie = await signIn('admin@example.com', 'admin-pass-1');
    const job = (await (
      await call(cookie, '/api/jobs', { method: 'POST', body: JSON.stringify({ areaIds: ['houston_tx'], settings: DEFAULT_JOB_SETTINGS }) })
    ).json()) as JobDetail;
    const cancelled = (await (await call(cookie, `/api/jobs/${job.id}/cancel`, { method: 'POST' })).json()) as JobDetail;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.areas[0]?.status).toBe('cancelled');
    const retried = (await (await call(cookie, `/api/jobs/${job.id}/retry`, { method: 'POST' })).json()) as JobDetail;
    expect(retried.status).toBe('running');
    expect(retried.areas[0]?.status).toBe('queued');
  });

  it('viewers can look but not start; leads and downloads come from the stored export', async () => {
    await addUser('viewer@example.com', 'viewer');
    const admin = await signIn('admin@example.com', 'admin-pass-1');
    const job = (await (
      await call(admin, '/api/jobs', { method: 'POST', body: JSON.stringify({ areaIds: ['houston_tx'], settings: DEFAULT_JOB_SETTINGS }) })
    ).json()) as JobDetail;
    const viewer = await signIn('viewer@example.com', 'password-123');
    const refused = await call(viewer, '/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ areaIds: ['houston_tx'], settings: DEFAULT_JOB_SETTINGS }),
    });
    expect(refused.status).toBe(403);
    expect((await call(viewer, `/api/jobs/${job.id}/leads`)).status).toBe(404);

    const row = { companyId: 1, list: 'painting', company: 'A Painting' } as LeadRow;
    const csv = BOM + '"List","Company"\r\n"Painting companies","A, Painting"\r\n"Likely fits","B Painting"\r\n';
    await pool.query(`INSERT INTO job_exports (job_id, xlsx, csv, rows, summary) VALUES ($1, $2, $3, $4, $5)`, [
      job.id,
      Buffer.from('xlsx-bytes'),
      Buffer.from(csv, 'utf8'),
      JSON.stringify([row]),
      JSON.stringify({ counts: { painting: 1, check: 0, likely: 1 } }),
    ]);
    const leads = (await (await call(viewer, `/api/jobs/${job.id}/leads`)).json()) as LeadRow[];
    expect(leads).toEqual([row]);
    // Bytes, not text(): text() drops the BOM that Excel needs.
    const body = async (r: Response) => Buffer.from(await r.arrayBuffer()).toString('utf8');
    const likely = await call(viewer, `/api/jobs/${job.id}/export.csv?list=likely`);
    expect(await body(likely)).toBe(BOM + 'List,Company\r\nLikely fits,B Painting\r\n');
    const painting = await call(viewer, `/api/jobs/${job.id}/export.csv?list=painting`);
    expect(await body(painting)).toBe(BOM + 'List,Company\r\nPainting companies,"A, Painting"\r\n');
    const xlsx = await call(viewer, `/api/jobs/${job.id}/export.xlsx`);
    expect(xlsx.headers.get('content-disposition')).toMatch(/attachment; filename="painter-leads-\d+-tx-houston\.xlsx"/);
    const summary = (await (await call(viewer, `/api/jobs/${job.id}`)).json()) as JobDetail;
    expect(summary.counts).toEqual({ painting: 1, check: 0, likely: 1 });
  });
});

describe('users', () => {
  it('admin adds a user who can then sign in; an admin cannot lock themselves out; others cannot manage users', async () => {
    const admin = await signIn('admin@example.com', 'admin-pass-1');
    const res = await call(admin, '/api/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'Op@Example.com', name: 'Op', role: 'operator', password: 'operator-pw' }),
    });
    expect(res.status).toBe(201);
    const op = (await res.json()) as UserRow;
    expect(op.email).toBe('op@example.com');
    const opCookie = await signIn('op@example.com', 'operator-pw');
    expect((await call(opCookie, '/api/users')).status).toBe(403);

    const me = (await (await call(admin, '/api/auth/me')).json()) as Me;
    const self = await call(admin, `/api/users/${me.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'viewer' }) });
    expect(self.status).toBe(400);

    const disabled = await call(admin, `/api/users/${op.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: true }) });
    expect(disabled.status).toBe(200);
    expect((await call(opCookie, '/api/auth/me')).status).toBe(401);
  });
});
