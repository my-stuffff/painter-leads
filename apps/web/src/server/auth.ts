import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type pg from 'pg';
import type { Me, Role } from '../shared/api';
import { q, q1 } from './sql';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const SESSION_COOKIE = 'pp_session';
export const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/** `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}

export const tokenId = (token: string): string => createHash('sha256').update(token).digest('hex');

export async function createSession(pool: pg.Pool, userId: number): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await q(pool, `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [tokenId(token), userId, expires]);
  return { token, expires };
}

export function setSessionCookie(c: Context, token: string, expires: Date, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

interface UserRowDb {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
}

/** The signed-in user of a request, or null. Touches the session at most once a minute. */
export async function sessionUser(pool: pg.Pool, token: string | undefined): Promise<Me | null> {
  if (!token) return null;
  const row = await q1<UserRowDb & { last_seen_at: Date }>(
    pool,
    `SELECT u.id, u.email, u.name, u.role, u.disabled, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [tokenId(token)],
  );
  if (!row || row.disabled) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await q(pool, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [tokenId(token)]);
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export type AppEnv = { Variables: { me: Me } };

/** 401 unless signed in; puts the user on the context as `me`. */
export function requireUser(pool: pg.Pool): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const me = await sessionUser(pool, getCookie(c, SESSION_COOKIE));
    if (!me) return c.json({ error: 'Please sign in' }, 401);
    c.set('me', me);
    await next();
  };
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (RANK[c.get('me').role] < RANK[min]) return c.json({ error: 'You do not have access to this' }, 403);
    await next();
  };
}

/** Sign-in throttle: 10 failed tries per email + address in 15 minutes. */
export class LoginThrottle {
  private readonly fails = new Map<string, number[]>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}
  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, recent);
    return recent.length >= this.max;
  }
  fail(key: string, now = Date.now()): void {
    this.fails.set(key, [...(this.fails.get(key) ?? []), now]);
  }
  clear(key: string): void {
    this.fails.delete(key);
  }
}

/** First start: when there are no users and ADMIN_EMAIL / ADMIN_PASSWORD are set, creates that admin. */
export async function bootstrapAdmin(pool: pg.Pool, email: string | undefined, password: string | undefined): Promise<boolean> {
  if (!email || !password) return false;
  const n = await q1<{ n: string }>(pool, `SELECT count(*)::text AS n FROM users`);
  if (Number(n?.n ?? 0) > 0) return false;
  await q(pool, `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin')`, [
    email.trim().toLowerCase(),
    'Admin',
    await hashPassword(password),
  ]);
  return true;
}
