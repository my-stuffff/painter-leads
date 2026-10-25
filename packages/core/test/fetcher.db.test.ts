import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pages, requestLog } from '../src/db/schema';
import { getTestDb, truncateAll } from '../src/db/test-utils';
import { RobotsDisallowedError } from '../src/fetch/errors';
import { makeTestFetcher } from './helpers';

const handle = getTestDb();
const db = handle.db;
const HOST = 'https://example-painting.test';
const HTML = { headers: { 'content-type': 'text/html' } };

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

describe('fetcher with a database', () => {
  it('writes one request_log row per network request and a pages row for the stored body', async () => {
    const { fetcher, agent } = makeTestFetcher({ db });
    agent.get(HOST).intercept({ path: '/about' }).reply(200, '<html>About</html>', HTML);

    const res = await fetcher.get(`${HOST}/about`, { source: 'websites', runId: null });

    const log = await db.select().from(requestLog);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      source: 'websites',
      host: 'example-painting.test',
      method: 'GET',
      url: `${HOST}/about`,
      status: 200,
      outcome: 'ok',
    });
    expect(log[0]!.bytes).toBe('<html>About</html>'.length);
    expect(log[0]!.ms).toBeGreaterThanOrEqual(0);

    const stored = await db.select().from(pages).where(eq(pages.sha256, res.sha256));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      url: `${HOST}/about`,
      host: 'example-painting.test',
      statusCode: 200,
      bytes: '<html>About</html>'.length,
      rendered: false,
      source: 'websites',
      cachePath: res.cachePath,
    });
  });

  it('logs a cache_hit for a cached fetch and no extra pages row', async () => {
    const { fetcher, agent } = makeTestFetcher({ db });
    agent.get(HOST).intercept({ path: '/c' }).reply(200, 'cached', HTML);
    await fetcher.get(`${HOST}/c`, { source: 'websites' });
    await fetcher.get(`${HOST}/c`, { source: 'websites' });
    const log = await db.select().from(requestLog);
    expect(log.map((r) => r.outcome)).toEqual(['ok', 'cache_hit']);
    expect(await db.select().from(pages)).toHaveLength(1);
  });

  it('logs a redirect hop per request and the final response', async () => {
    const { fetcher, agent } = makeTestFetcher({ db });
    const pool = agent.get(HOST);
    pool.intercept({ path: '/a' }).reply(302, '', { headers: { location: '/b' } });
    pool.intercept({ path: '/b' }).reply(200, 'done', HTML);
    await fetcher.get(`${HOST}/a`, { source: 'websites' });
    const log = await db.select().from(requestLog);
    expect(log.map((r) => [r.url, r.status])).toEqual([
      [`${HOST}/a`, 302],
      [`${HOST}/b`, 200],
    ]);
  });

  it('logs robots_disallowed, ssrf_refused and offline_miss outcomes', async () => {
    const { fetcher, agent } = makeTestFetcher({ db, websitesRobots: 'respect' });
    agent.get(HOST).intercept({ path: '/robots.txt' }).reply(200, 'User-agent: *\nDisallow: /private', HTML);
    await expect(fetcher.get(`${HOST}/private/x`, { source: 'websites' })).rejects.toBeInstanceOf(RobotsDisallowedError);
    await expect(fetcher.get('http://127.0.0.1/x', { source: 'websites' })).rejects.toThrow();
    await expect(fetcher.get(`${HOST}/not-cached`, { source: 'websites', offline: true })).rejects.toThrow();
    const outcomes = (await db.select().from(requestLog)).map((r) => r.outcome);
    expect(outcomes).toContain('robots_disallowed');
    expect(outcomes).toContain('ssrf_refused');
    expect(outcomes).toContain('offline_miss');
  });

  it('never stores response bodies or cookies in request_log', async () => {
    const { fetcher, agent } = makeTestFetcher({ db });
    agent.get(HOST).intercept({ path: '/s' }).reply(200, 'SECRET-BODY', { headers: { 'content-type': 'text/html', 'set-cookie': 'sid=SECRET-COOKIE; path=/' } });
    await fetcher.session('s', 'websites').get(`${HOST}/s`);
    const dump = JSON.stringify(await db.select().from(requestLog));
    expect(dump).not.toContain('SECRET-BODY');
    expect(dump).not.toContain('SECRET-COOKIE');
  });

  it('storeRendered writes a pages row with rendered true', async () => {
    const { fetcher } = makeTestFetcher({ db });
    const stored = await fetcher.storeRendered(`${HOST}/spa`, '<html>rendered</html>', { source: 'websites' });
    const rows = await db.select().from(pages).where(eq(pages.sha256, stored.sha256));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rendered: true, url: `${HOST}/spa`, cachePath: stored.cachePath });
  });
});
