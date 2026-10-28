// Mock mode: an in-memory stand-in for the /api server, so the client runs and can be checked with no backend.
// Loaded only when import.meta.env.VITE_MOCK === '1' (dynamic import in main.tsx), so it never ships in production.
// Searches really "run": each request advances a small simulation (cities go queued → running → done, the export
// builds, leads appear).
import type {
  AreaProgress,
  Catalog,
  CreateJobBody,
  CreateUserBody,
  JobArea,
  JobAreaStatus,
  JobDetail,
  JobSettings,
  JobStatus,
  JobSummary,
  LeadCounts,
  LeadRow,
  LoginBody,
  Me,
  Overview,
  StateCode,
  UpdateUserBody,
  UserRow,
} from '../../shared/api';
import { DEFAULT_JOB_SETTINGS } from '../../shared/api';
import { installMock } from '../api';
import type { TransportResponse } from '../api';
import { CITIES, CITY, makeLeads, sourcesFor, STATES, USERS } from './data';

const MIN = 60_000;
const DAY = 86_400_000;
const STATE_NAME: Record<StateCode, string> = { CA: 'California', TX: 'Texas', NJ: 'New Jersey' };

interface MArea {
  id: number;
  areaId: string;
  status: JobAreaStatus;
  runId: number | null;
  attempts: number;
  message: string | null;
  notBefore: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 0..1 through the city's pipeline */
  frac: number;
  /** fraction per second while running */
  speed: number;
}

interface MJob {
  id: number;
  name: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  createdBy: string;
  settings: JobSettings;
  error: string | null;
  exportStatus: JobSummary['exportStatus'];
  exportError: string | null;
  exportBuiltAt: number | null;
  exportReadyAt: number | null;
  areas: MArea[];
  cancelRequested: boolean;
  /** Seeded "no free worker" job: stays queued. */
  hold?: boolean;
  leads: LeadRow[] | null;
  leadTotal: number;
  lastTick: number;
}

let areaSeq = 1;
let runSeq = 900;
const now = () => Date.now();

function area(areaId: string, status: JobAreaStatus, frac: number, extra: Partial<MArea> = {}): MArea {
  const city = CITY.get(areaId);
  const zips = city?.zipCount ?? 10;
  const t = now();
  return {
    id: areaSeq++,
    areaId,
    status,
    runId: status === 'queued' || status === 'cancelled' ? null : runSeq++,
    attempts: status === 'queued' ? 0 : 1,
    message: null,
    notBefore: null,
    startedAt: status === 'queued' || status === 'cancelled' ? null : t - 50 * MIN,
    finishedAt: status === 'done' || status === 'reused' || status === 'failed' ? t - 20 * MIN : null,
    frac,
    speed: 1 / (zips * 2.2),
    ...extra,
  };
}

function job(j: Partial<MJob> & Pick<MJob, 'id' | 'name' | 'status' | 'createdAt' | 'createdBy' | 'areas'>): MJob {
  return {
    startedAt: j.createdAt + 30_000,
    finishedAt: null,
    settings: { ...DEFAULT_JOB_SETTINGS },
    error: null,
    exportStatus: 'none',
    exportError: null,
    exportBuiltAt: null,
    exportReadyAt: null,
    cancelRequested: false,
    leads: null,
    leadTotal: 0,
    lastTick: now(),
    ...j,
  };
}

const T = now();
const JOBS: MJob[] = [
  job({
    id: 9,
    name: 'New Jersey refresh',
    status: 'queued',
    createdAt: T - 6 * MIN,
    startedAt: null,
    createdBy: 'Priya Shah',
    hold: true,
    areas: [area('newark_nj', 'queued', 0), area('jersey_city_nj', 'queued', 0), area('paterson_nj', 'queued', 0), area('elizabeth_nj', 'queued', 0)],
    settings: { ...DEFAULT_JOB_SETTINGS, reuseDays: 0 },
  }),
  job({
    id: 8,
    name: 'Central Valley',
    status: 'running',
    createdAt: T - 42 * MIN,
    createdBy: 'Maya Collins',
    areas: [
      area('fresno_ca', 'running', 0.34, { speed: 1 / 420, startedAt: T - 38 * MIN }),
      area('sacramento_ca', 'queued', 0),
      area('bakersfield_ca', 'queued', 0),
    ],
    settings: { ...DEFAULT_JOB_SETTINGS, minRating: 4.6 },
  }),
  job({
    id: 7,
    name: 'Texas big cities',
    status: 'running',
    createdAt: T - 2.3 * 60 * MIN,
    createdBy: 'Jordan Reyes',
    areas: [
      area('houston_tx', 'reused', 1, { startedAt: T - 2.3 * 60 * MIN, finishedAt: T - 2.3 * 60 * MIN }),
      area('san_antonio_tx', 'running', 0.58, { speed: 1 / 1500, startedAt: T - 2.2 * 60 * MIN }),
      area('dallas_tx', 'waiting', 0.62, {
        attempts: 2,
        notBefore: T + 22 * MIN,
        message: 'Google is limiting views. Trying again soon.',
      }),
      area('austin_tx_city', 'queued', 0),
      area('fort_worth_tx', 'queued', 0),
      area('el_paso_tx', 'queued', 0),
    ],
  }),
  job({
    id: 6,
    name: 'New Jersey — 4 cities',
    status: 'done',
    createdAt: T - 1.2 * DAY,
    finishedAt: T - 1.0 * DAY,
    createdBy: 'Maya Collins',
    exportStatus: 'ready',
    exportBuiltAt: T - 1.0 * DAY,
    leadTotal: 62,
    areas: [area('newark_nj', 'done', 1), area('jersey_city_nj', 'reused', 1), area('paterson_nj', 'done', 1), area('elizabeth_nj', 'done', 1)],
  }),
  job({
    id: 5,
    name: 'California top 5',
    status: 'done',
    createdAt: T - 2.4 * DAY,
    finishedAt: T - 1.4 * DAY,
    createdBy: 'Maya Collins',
    exportStatus: 'ready',
    exportBuiltAt: T - 1.4 * DAY,
    leadTotal: 148,
    areas: [
      area('los_angeles_ca', 'done', 1),
      area('san_diego_ca_city', 'done', 1),
      area('san_jose_ca', 'done', 1),
      area('san_francisco_ca', 'reused', 1),
      area('fresno_ca', 'failed', 0.3, { attempts: 3, message: 'Google blocked every try. Use "Retry failed cities" later.' }),
    ],
  }),
  job({
    id: 4,
    name: 'Lubbock test',
    status: 'cancelled',
    createdAt: T - 4 * DAY,
    finishedAt: T - 4 * DAY + 3 * MIN,
    createdBy: 'Jordan Reyes',
    areas: [area('lubbock_tx', 'cancelled', 0)],
  }),
  job({
    id: 3,
    name: 'Corpus Christi',
    status: 'failed',
    createdAt: T - 5 * DAY,
    finishedAt: T - 5 * DAY + 50 * MIN,
    createdBy: 'Priya Shah',
    error: 'No city finished, so there are no leads.',
    areas: [area('corpus_christi_tx', 'failed', 0.12, { attempts: 3, message: "Couldn't open Google Maps after 3 tries." })],
  }),
  job({
    id: 2,
    name: 'Dallas–Fort Worth',
    status: 'done',
    createdAt: T - 41.5 * DAY,
    finishedAt: T - 41 * DAY,
    createdBy: 'Maya Collins',
    exportStatus: 'ready',
    exportBuiltAt: T - 41 * DAY,
    leadTotal: 96,
    areas: [area('dallas_tx', 'done', 1), area('fort_worth_tx', 'done', 1), area('arlington_tx', 'done', 1), area('plano_tx', 'done', 1)],
  }),
];
let jobSeq = 10;

// --- simulation ---------------------------------------------------------------------------------------------------

const terminal = (s: JobAreaStatus) => s === 'done' || s === 'reused' || s === 'failed' || s === 'cancelled';

function reusable(j: MJob, areaId: string, t: number) {
  const lr = CITY.get(areaId)?.lastRun;
  return !!lr && j.settings.reuseDays > 0 && t - new Date(lr.finishedAt).getTime() < j.settings.reuseDays * DAY;
}

function leadsFor(j: MJob): LeadRow[] {
  if (!j.leads) {
    const ok = j.areas.filter((a) => a.status === 'done' || a.status === 'reused');
    const runIds = new Map(ok.map((a) => [a.areaId, a.runId ?? 0]));
    const total = j.leadTotal || Math.min(400, ok.reduce((n, a) => n + Math.round((CITY.get(a.areaId)?.zipCount ?? 5) * 0.9) + 3, 0));
    j.leads = makeLeads(j.id * 7919, ok.map((a) => a.areaId), total, runIds);
  }
  return j.leads;
}

function tick(j: MJob, t: number) {
  const dt = Math.max(0, (t - j.lastTick) / 1000);
  j.lastTick = t;

  if ((j.status === 'queued' && !j.hold) || j.status === 'running') {
    for (const a of j.areas) {
      if (a.status === 'waiting' && a.notBefore != null && a.notBefore <= t) {
        a.status = 'queued';
        a.message = null;
        a.notBefore = null;
      }
      if (a.status === 'running') {
        a.frac = Math.min(1, a.frac + dt * a.speed);
        if (a.frac >= 1) {
          a.status = 'done';
          a.finishedAt = t;
        }
      }
    }
    if (!j.cancelRequested && !j.areas.some((a) => a.status === 'running')) {
      for (const a of j.areas) {
        if (a.status !== 'queued') continue;
        if (reusable(j, a.areaId, t)) {
          a.status = 'reused';
          a.frac = 1;
          a.runId = CITY.get(a.areaId)?.lastRun?.runId ?? runSeq++;
          a.startedAt = a.finishedAt = t;
          continue;
        }
        a.status = 'running';
        a.startedAt = t;
        a.attempts += 1;
        a.runId = runSeq++;
        break;
      }
    }
    if (j.areas.some((a) => a.status === 'running' || a.status === 'reused' || a.status === 'done')) {
      j.status = 'running';
      j.startedAt ??= t;
    }
    if (j.areas.every((a) => terminal(a.status))) {
      const anyOk = j.areas.some((a) => a.status === 'done' || a.status === 'reused');
      j.status = !anyOk ? (j.cancelRequested ? 'cancelled' : 'failed') : j.cancelRequested ? 'cancelled' : 'done';
      j.finishedAt = t;
      if (!anyOk && !j.cancelRequested) j.error = 'No city finished, so there are no leads.';
      if (anyOk) {
        j.exportStatus = 'building';
        j.exportReadyAt = t + 6000;
        j.leads = null;
      }
    }
  }
  if (j.exportStatus === 'building' && j.exportReadyAt != null && j.exportReadyAt <= t) {
    leadsFor(j);
    j.exportStatus = 'ready';
    j.exportBuiltAt = t;
    j.exportReadyAt = null;
  }
}

function tickAll() {
  const t = now();
  for (const j of JOBS) tick(j, t);
}

// --- views ------------------------------------------------------------------------------------------------------

const isoOf = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

function progressOf(a: MArea, terms: number): AreaProgress | null {
  if (a.frac <= 0 && (a.status === 'queued' || a.status === 'cancelled')) return null;
  const zips = CITY.get(a.areaId)?.zipCount ?? 10;
  const f = a.frac;
  const searchesTotal = zips * terms;
  const sFrac = Math.min(1, f / 0.5);
  const placesTotal = Math.round(zips * 11 * (0.35 + 0.65 * sFrac));
  const pFrac = Math.max(0, Math.min(1, (f - 0.5) / 0.35));
  const placesDone = Math.round(placesTotal * pFrac);
  const companies = Math.round(placesDone * 0.78);
  const painters = Math.round(companies * 0.52);
  const stage: AreaProgress['stage'] =
    f >= 1 ? 'done' : f < 0.5 ? 'searching' : f < 0.85 ? 'reading listings' : f < 0.97 ? 'checking websites' : 'finishing';
  return {
    searchesDone: Math.round(searchesTotal * sFrac),
    searchesTotal,
    placesDone,
    placesTotal,
    companies,
    painters,
    qualified: Math.round(painters * 0.21),
    stage,
  };
}

function areaView(j: MJob, a: MArea): JobArea {
  const city = CITY.get(a.areaId);
  let message = a.message;
  if (a.status === 'waiting' && a.notBefore) {
    const at = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(a.notBefore));
    message = `Google is limiting views — trying again at ${at}`;
  }
  return {
    id: a.id,
    areaId: a.areaId,
    label: city ? `${city.name}, ${city.state}` : a.areaId,
    state: city?.state ?? 'CA',
    status: a.status,
    runId: a.runId,
    attempts: a.attempts,
    message,
    notBefore: isoOf(a.notBefore),
    startedAt: isoOf(a.startedAt),
    finishedAt: isoOf(a.finishedAt),
    progress: progressOf(a, j.settings.terms.length),
  };
}

function countsOf(rows: LeadRow[]): LeadCounts {
  const c: LeadCounts = { painting: 0, check: 0, likely: 0 };
  for (const r of rows) c[r.list]++;
  return c;
}

function summaryView(j: MJob): JobSummary {
  const states = [...new Set(j.areas.map((a) => CITY.get(a.areaId)?.state).filter((s): s is StateCode => !!s))];
  const fracSum = j.areas.reduce((n, a) => n + (terminal(a.status) ? 1 : a.status === 'running' || a.status === 'waiting' ? a.frac : 0), 0);
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    states,
    createdAt: new Date(j.createdAt).toISOString(),
    startedAt: isoOf(j.startedAt),
    finishedAt: isoOf(j.finishedAt),
    createdBy: j.createdBy,
    cityCount: j.areas.length,
    citiesDone: j.areas.filter((a) => a.status === 'done' || a.status === 'reused').length,
    progress: j.areas.length ? fracSum / j.areas.length : 0,
    exportStatus: j.exportStatus,
    counts: j.exportStatus === 'ready' ? countsOf(leadsFor(j)) : null,
  };
}

function detailView(j: MJob): JobDetail {
  const remainingZips = j.areas.reduce((n, a) => {
    const z = CITY.get(a.areaId)?.zipCount ?? 0;
    if (a.status === 'queued' || a.status === 'waiting') return n + (reusable(j, a.areaId, now()) ? 0 : z);
    if (a.status === 'running') return n + z * (1 - a.frac);
    return n;
  }, 0);
  const live = j.status === 'queued' || j.status === 'running';
  return {
    ...summaryView(j),
    settings: j.settings,
    error: j.error,
    exportError: j.exportError,
    exportBuiltAt: isoOf(j.exportBuiltAt),
    areas: j.areas.map((a) => areaView(j, a)),
    etaMinutes: live ? Math.round(remainingZips * 1.5) : null,
  };
}

// --- session ------------------------------------------------------------------------------------------------------

const SESSION_KEY = 'pp-mock-session';
function sessionUser(): UserRow | null {
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(SESSION_KEY);
  } catch {
    /* no storage */
  }
  const u = USERS.find((x) => String(x.id) === id);
  return u && !u.disabled ? u : null;
}
const meOf = (u: UserRow): Me => ({ id: u.id, email: u.email, name: u.name, role: u.role });

// --- routing ------------------------------------------------------------------------------------------------------

const ok = (data: unknown, status = 200): TransportResponse => ({ status, data });
const err = (status: number, error: string): TransportResponse => ({ status, data: { error } });

function handle(method: string, path: string, body: unknown): TransportResponse {
  const url = new URL(path, 'http://mock');
  const p = url.pathname;

  if (method === 'POST' && p === '/api/auth/login') {
    const b = body as LoginBody;
    const email = (b.email ?? '').trim().toLowerCase();
    if (!email || !b.password || b.password === 'wrong') return err(401, 'Email or password is wrong.');
    const u =
      USERS.find((x) => x.email === email) ??
      (email.includes('viewer') ? USERS[3] : email.includes('operator') ? USERS[1] : USERS[0]);
    if (!u) return err(401, 'Email or password is wrong.');
    if (u.disabled) return err(401, 'This account is turned off. Ask an admin.');
    try {
      sessionStorage.setItem(SESSION_KEY, String(u.id));
    } catch {
      /* no storage */
    }
    u.lastLoginAt = new Date().toISOString();
    return ok(meOf(u));
  }

  const me = sessionUser();
  if (!me) return err(401, 'Please sign in.');

  if (method === 'POST' && p === '/api/auth/logout') {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* no storage */
    }
    return ok(null, 204);
  }
  if (method === 'GET' && p === '/api/auth/me') return ok(meOf(me));

  tickAll();

  if (method === 'GET' && p === '/api/catalog') return ok({ states: STATES, cities: CITIES } satisfies Catalog);

  if (method === 'GET' && p === '/api/overview') {
    const running = JOBS.filter((j) => j.status === 'running');
    const doing = JOBS.flatMap((j) =>
      j.areas.filter((a) => a.status === 'running').map((a) => `${CITY.get(a.areaId)?.name}, ${CITY.get(a.areaId)?.state} (job ${j.id})`),
    );
    const leads: LeadCounts = { painting: 0, check: 0, likely: 0 };
    for (const j of JOBS)
      if (j.exportStatus === 'ready') {
        const c = countsOf(leadsFor(j));
        leads.painting += c.painting;
        leads.check += c.check;
        leads.likely += c.likely;
      }
    const ov: Overview = {
      jobsRunning: running.length,
      jobsQueued: JOBS.filter((j) => j.status === 'queued').length,
      leads,
      workers: [
        { id: 'worker-1', lastSeenAt: new Date(now() - 12_000).toISOString(), online: true, doing: doing[0] ?? null },
        { id: 'worker-2', lastSeenAt: new Date(now() - 21_000).toISOString(), online: true, doing: doing[1] ?? null },
      ],
    };
    return ok(ov);
  }

  if (method === 'GET' && p === '/api/jobs') return ok([...JOBS].sort((a, b) => b.createdAt - a.createdAt).map(summaryView));

  if (method === 'POST' && p === '/api/jobs') {
    if (me.role === 'viewer') return err(403, 'Viewers can’t start searches.');
    const b = body as CreateJobBody;
    if (!b.areaIds?.length) return err(400, 'Pick at least one city.');
    const unknown = b.areaIds.find((id) => !CITY.has(id));
    if (unknown) return err(400, `Unknown city: ${unknown}`);
    const states = [...new Set(b.areaIds.map((id) => CITY.get(id)?.state as StateCode))];
    const t = now();
    const j = job({
      id: jobSeq++,
      name: b.name?.trim() || `${states.map((s) => STATE_NAME[s]).join(', ')} — ${b.areaIds.length} ${b.areaIds.length === 1 ? 'city' : 'cities'}`,
      status: 'queued',
      createdAt: t,
      startedAt: null,
      createdBy: me.name,
      settings: b.settings,
      areas: b.areaIds.map((id) => area(id, 'queued', 0)),
      lastTick: t,
    });
    JOBS.push(j);
    tick(j, t);
    return ok(detailView(j), 201);
  }

  const m = p.match(/^\/api\/jobs\/(\d+)(\/[a-z-]+)?$/);
  if (m) {
    const j = JOBS.find((x) => x.id === Number(m[1]));
    if (!j) return err(404, 'This search doesn’t exist.');
    const sub = m[2] ?? '';
    if (method === 'GET' && sub === '') return ok(detailView(j));
    if (method === 'GET' && sub === '/leads') {
      if (j.exportStatus !== 'ready') return err(404, 'The lead lists aren’t ready yet.');
      return ok(leadsFor(j));
    }
    if (method === 'POST' && me.role === 'viewer') return err(403, 'Viewers can only look.');
    if (method === 'POST' && sub === '/cancel') {
      j.cancelRequested = true;
      j.hold = false;
      for (const a of j.areas) if (a.status === 'queued' || a.status === 'waiting') a.status = 'cancelled';
      tick(j, now());
      return ok(detailView(j));
    }
    if (method === 'POST' && sub === '/retry') {
      let n = 0;
      for (const a of j.areas)
        if (a.status === 'failed' || a.status === 'cancelled') {
          a.status = 'queued';
          a.frac = 0;
          a.message = null;
          a.runId = null;
          n++;
        }
      if (!n) return err(400, 'No failed or cancelled cities to retry.');
      j.cancelRequested = false;
      j.status = 'queued';
      j.finishedAt = null;
      j.error = null;
      tick(j, now());
      return ok(detailView(j));
    }
    if (method === 'POST' && sub === '/rebuild-export') {
      if (!j.areas.some((a) => a.status === 'done' || a.status === 'reused')) return err(400, 'No finished city to build from.');
      j.exportStatus = 'building';
      j.exportReadyAt = now() + 5000;
      j.leads = null;
      return ok(detailView(j), 202);
    }
  }

  const s = p.match(/^\/api\/companies\/(\d+)\/sources$/);
  if (method === 'GET' && s) return ok(sourcesFor(Number(s[1])));

  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (me.role !== 'admin') return err(403, 'Only admins can manage users.');
    if (method === 'GET' && p === '/api/users') return ok(USERS);
    if (method === 'POST' && p === '/api/users') {
      const b = body as CreateUserBody;
      const email = b.email.trim().toLowerCase();
      if (USERS.some((u) => u.email === email)) return err(409, 'Someone already uses this email.');
      const u: UserRow = {
        id: Math.max(...USERS.map((x) => x.id)) + 1,
        email,
        name: b.name.trim(),
        role: b.role,
        disabled: false,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      };
      USERS.push(u);
      return ok(u, 201);
    }
    const um = p.match(/^\/api\/users\/(\d+)$/);
    if (method === 'PATCH' && um) {
      const u = USERS.find((x) => x.id === Number(um[1]));
      if (!u) return err(404, 'User not found.');
      const b = body as UpdateUserBody;
      if (u.id === me.id && (b.role || b.disabled)) return err(400, 'You can’t change your own role or turn yourself off.');
      if (b.name != null) u.name = b.name;
      if (b.role) u.role = b.role;
      if (b.disabled != null) u.disabled = b.disabled;
      return ok({ ...u });
    }
  }

  return err(404, `No mock for ${method} ${p}`);
}

// --- downloads ----------------------------------------------------------------------------------------------------

function csvOf(rows: LeadRow[]): string {
  const cols: [string, (r: LeadRow) => unknown][] = [
    ['List', (r) => r.list],
    ['Company', (r) => r.company],
    ['Owner', (r) => r.owner],
    ['Phone', (r) => r.phone],
    ['Email', (r) => r.email],
    ['Website', (r) => r.website],
    ['Google rating', (r) => r.rating],
    ['Reviews', (r) => r.reviews],
    ['City', (r) => r.city],
    ['State', (r) => r.state],
    ['Why not in main list', (r) => r.whyNot],
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => esc(c[1](r))).join(','))].join('\r\n');
}

function download(url: string) {
  const u = new URL(url, 'http://mock');
  const m = u.pathname.match(/^\/api\/jobs\/(\d+)\/export\.(xlsx|csv)$/);
  const j = m ? JOBS.find((x) => x.id === Number(m[1])) : null;
  if (!m || !j || j.exportStatus !== 'ready') return;
  const list = u.searchParams.get('list') ?? 'all';
  const rows = leadsFor(j).filter((r) => list === 'all' || r.list === list);
  const blob = new Blob([csvOf(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  // Mock mode has no workbook builder: the "XLSX" link gives the same rows as CSV.
  a.download = `${j.name.replace(/[^\w-]+/g, '-')}-${m[2] === 'xlsx' ? 'workbook-mock' : list}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function install() {
  installMock(async (method, path, body) => {
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 200));
    // Copy so the UI never holds references into the mock's state.
    const res = handle(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
    return { status: res.status, data: res.data == null ? null : JSON.parse(JSON.stringify(res.data)) };
  }, download);
  console.info('[mock] API answered in the browser. Sign in with any email; password "wrong" fails; an email with "viewer" signs in as a viewer.');
}
