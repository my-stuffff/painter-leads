import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type pg from 'pg';
import { z } from 'zod';
import type {
  CreateUserBody,
  LeadCounts,
  LeadList,
  LeadRow,
  Me,
  Overview,
  Role,
  SourceRow,
  UpdateUserBody,
  UserRow,
  WorkerInfo,
} from '../shared/api';
import {
  type AppEnv,
  clearSessionCookie,
  createSession,
  hashPassword,
  LoginThrottle,
  requireRole,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
  tokenId,
  verifyPassword,
} from './auth';
import { buildCatalog, type CatalogFileCity } from './catalog';
import { csvForList } from './csv';
import { cancelJob, createJob, CreateJobSchema, getJob, listJobs, rebuildExport, retryJob, UserError } from './jobs';
import { iso, q, q1 } from './sql';

export interface AppDeps {
  pool: pg.Pool;
  cities: CatalogFileCity[];
  /** Secure cookies (true behind https in production). */
  secureCookies: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  google_maps: 'Google Maps',
  website: 'Company website',
  cslb_master: 'CSLB licence',
  cslb_personnel: 'CSLB licence',
  cslb_lookup: 'CSLB licence',
  nj_hic_roster: 'NJ HIC register',
  nj_hic_detail: 'NJ HIC register',
  nj_principal_search: 'NJ business register',
  tx_open_data: 'TX Comptroller',
  tx_comptroller: 'TX Comptroller',
  bbb: 'BBB',
};

const ROLES = ['admin', 'operator', 'viewer'] as const;
const CreateUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(ROLES),
  password: z.string().min(8).max(200),
});
const UpdateUserSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});
const LoginSchema = z.object({ email: z.string().trim().toLowerCase().min(3).max(200), password: z.string().min(1).max(200) });

const idParam = (raw: string | undefined): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UserError('Not found');
  return n;
};

const WORKER_ONLINE_MS = 2 * 60_000;

interface UserDb {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  created_at: Date;
  last_login_at: Date | null;
}
const toUser = (u: UserDb): UserRow => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  disabled: u.disabled,
  createdAt: iso(u.created_at) ?? '',
  lastLoginAt: iso(u.last_login_at),
});

async function workers(pool: pg.Pool): Promise<WorkerInfo[]> {
  const rows = await q<{ id: string; last_seen_at: Date; label: string | null; job_id: number | null; status: string | null }>(
    pool,
    `SELECT w.id, w.last_seen_at, ja.label, ja.job_id, ja.status
       FROM workers w LEFT JOIN job_areas ja ON ja.id = w.job_area_id ORDER BY w.id`,
  );
  return rows.map((w) => {
    const online = Date.now() - new Date(w.last_seen_at).getTime() < WORKER_ONLINE_MS;
    return {
      id: w.id,
      lastSeenAt: iso(w.last_seen_at) ?? '',
      online,
      doing: online && w.label && w.status === 'running' ? `${w.label} (search ${w.job_id})` : null,
    };
  });
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { pool } = deps;
  const app = new Hono<AppEnv>();
  const throttle = new LoginThrottle();

  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, err.message === 'Not found' ? 404 : 400);
    if (err instanceof z.ZodError) return c.json({ error: err.issues[0]?.message ?? 'Invalid input' }, 400);
    console.error(JSON.stringify({ type: 'error', path: c.req.path, message: err.message, stack: err.stack }));
    return c.json({ error: 'Something went wrong on the server' }, 500);
  });

  // Changes must come from this site (cookies are SameSite=Lax; this closes the rest).
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
      if (origin && host && new URL(origin).host !== host) return c.json({ error: 'Cross-site request refused' }, 403);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // --- auth -------------------------------------------------------------------------------------------------
  app.post('/api/auth/login', async (c) => {
    const body = LoginSchema.parse(await c.req.json());
    const key = `${body.email}|${c.req.header('x-forwarded-for') ?? ''}`;
    if (throttle.blocked(key)) return c.json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    const u = await q1<UserDb & { password_hash: string }>(pool, `SELECT * FROM users WHERE email = $1`, [body.email]);
    if (!u || u.disabled || !(await verifyPassword(body.password, u.password_hash))) {
      throttle.fail(key);
      return c.json({ error: 'Wrong email or password' }, 401);
    }
    throttle.clear(key);
    const s = await createSession(pool, u.id);
    await q(pool, `UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    setSessionCookie(c, s.token, s.expires, deps.secureCookies);
    const me: Me = { id: u.id, email: u.email, name: u.name, role: u.role };
    return c.json(me);
  });

  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await q(pool, `DELETE FROM sessions WHERE id = $1`, [tokenId(token)]);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path.startsWith('/api/auth/login') || c.req.path === '/api/auth/logout') {
      return next();
    }
    return requireUser(pool)(c, next);
  });

  app.get('/api/auth/me', (c) => c.json(c.get('me')));

  // --- catalog + overview -----------------------------------------------------------------------------------
  app.get('/api/catalog', async (c) => c.json(await buildCatalog(pool, deps.cities)));

  app.get('/api/overview', async (c) => {
    const counts = await q1<{ running: string; queued: string }>(
      pool,
      `SELECT count(*) FILTER (WHERE status = 'running')::text AS running,
              count(*) FILTER (WHERE status = 'queued')::text AS queued FROM jobs`,
    );
    const lists = await q<{ list: LeadList; n: string }>(
      pool,
      `SELECT list, count(*)::text AS n FROM (
         SELECT DISTINCT ON (r->>'companyId') r->>'list' AS list
           FROM job_exports e, jsonb_array_elements(e.rows) r ORDER BY r->>'companyId', e.built_at DESC) x
        GROUP BY list`,
    );
    const leads: LeadCounts = { painting: 0, check: 0, likely: 0 };
    for (const l of lists) leads[l.list] = Number(l.n);
    const out: Overview = {
      jobsRunning: Number(counts?.running ?? 0),
      jobsQueued: Number(counts?.queued ?? 0),
      leads,
      workers: await workers(pool),
    };
    return c.json(out);
  });

  // --- jobs ---------------------------------------------------------------------------------------------------
  const onlineWorkers = async () => (await workers(pool)).filter((w) => w.online).length;
  const jobOr404 = async (id: number) => {
    const job = await getJob(pool, id, deps.cities, await onlineWorkers());
    if (!job) throw new UserError('Not found');
    return job;
  };

  app.get('/api/jobs', async (c) => c.json(await listJobs(pool)));

  app.post('/api/jobs', requireRole('operator'), async (c) => {
    const body = CreateJobSchema.parse(await c.req.json());
    const id = await createJob(pool, body, c.get('me').id, deps.cities);
    return c.json(await jobOr404(id), 201);
  });

  app.get('/api/jobs/:id', async (c) => c.json(await jobOr404(idParam(c.req.param('id')))));

  app.post('/api/jobs/:id/cancel', requireRole('operator'), async (c) => {
    const id = idParam(c.req.param('id'));
    await jobOr404(id);
    await cancelJob(pool, id);
    return c.json(await jobOr404(id));
  });

  app.post('/api/jobs/:id/retry', requireRole('operator'), async (c) => {
    const id = idParam(c.req.param('id'));
    await jobOr404(id);
    await retryJob(pool, id);
    return c.json(await jobOr404(id));
  });

  app.post('/api/jobs/:id/rebuild-export', requireRole('operator'), async (c) => {
    const id = idParam(c.req.param('id'));
    await jobOr404(id);
    await rebuildExport(pool, id);
    return c.json(await jobOr404(id), 202);
  });

  const exportOf = async (id: number) => {
    const e = await q1<{ xlsx: Buffer; csv: Buffer; rows: LeadRow[]; name: string }>(
      pool,
      `SELECT e.xlsx, e.csv, e.rows, j.name FROM job_exports e JOIN jobs j ON j.id = e.job_id WHERE e.job_id = $1`,
      [id],
    );
    if (!e) throw new UserError('Not found');
    return e;
  };
  const fileName = (name: string, id: number, ext: string) =>
    `painter-leads-${id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.${ext}`;

  app.get('/api/jobs/:id/leads', async (c) => c.json((await exportOf(idParam(c.req.param('id')))).rows));

  app.get('/api/jobs/:id/export.xlsx', async (c) => {
    const id = idParam(c.req.param('id'));
    const e = await exportOf(id);
    return c.body(new Uint8Array(e.xlsx), 200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${fileName(e.name, id, 'xlsx')}"`,
    });
  });

  app.get('/api/jobs/:id/export.csv', async (c) => {
    const id = idParam(c.req.param('id'));
    const raw = c.req.query('list') ?? 'all';
    const list = (['painting', 'check', 'likely', 'all'] as const).find((l) => l === raw);
    if (!list) throw new UserError('Unknown list');
    const e = await exportOf(id);
    const suffix = list === 'all' ? '' : `-${list}`;
    return c.body(csvForList(e.csv, list), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName(e.name + suffix, id, 'csv')}"`,
    });
  });

  app.get('/api/companies/:id/sources', async (c) => {
    const rows = await q<{
      field: string;
      value: string;
      source_type: string;
      source_url: string | null;
      captured_at: Date;
      confidence: string | null;
    }>(
      pool,
      `SELECT field, value, source_type, source_url, captured_at, confidence FROM evidence
        WHERE company_id = $1 AND status = 'accepted' ORDER BY field, captured_at DESC`,
      [idParam(c.req.param('id'))],
    );
    const out: SourceRow[] = rows.map((r) => ({
      field: r.field,
      value: r.value,
      sourceUrl: r.source_url,
      sourceLabel: SOURCE_LABEL[r.source_type] ?? r.source_type,
      capturedAt: iso(r.captured_at) ?? '',
      confidence: r.confidence,
    }));
    return c.json(out);
  });

  // --- users (admin) ----------------------------------------------------------------------------------------
  app.get('/api/users', requireRole('admin'), async (c) =>
    c.json((await q<UserDb>(pool, `SELECT * FROM users ORDER BY lower(name), id`)).map(toUser)),
  );

  app.post('/api/users', requireRole('admin'), async (c) => {
    const body: CreateUserBody = CreateUserSchema.parse(await c.req.json());
    const exists = await q1(pool, `SELECT 1 FROM users WHERE email = $1`, [body.email]);
    if (exists) throw new UserError('Someone already has that email');
    const u = await q1<UserDb>(
      pool,
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.email, body.name, body.role, await hashPassword(body.password)],
    );
    if (!u) throw new Error('could not add the user');
    return c.json(toUser(u), 201);
  });

  app.patch('/api/users/:id', requireRole('admin'), async (c) => {
    const id = idParam(c.req.param('id'));
    const body: UpdateUserBody = UpdateUserSchema.parse(await c.req.json());
    const me = c.get('me');
    if (id === me.id && (body.disabled === true || (body.role && body.role !== 'admin'))) {
      throw new UserError('You cannot remove your own admin access');
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.name !== undefined) add('name', body.name);
    if (body.role !== undefined) add('role', body.role);
    if (body.disabled !== undefined) add('disabled', body.disabled);
    if (body.password !== undefined) add('password_hash', await hashPassword(body.password));
    if (sets.length === 0) throw new UserError('Nothing to change');
    const u = await q1<UserDb>(pool, `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!u) throw new UserError('Not found');
    if (body.disabled === true || body.password !== undefined) {
      await q(pool, `DELETE FROM sessions WHERE user_id = $1`, [id]);
    }
    return c.json(toUser(u));
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  return app;
}
