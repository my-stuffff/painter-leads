import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createDb, migrateDb } from '@pp/core';
import { createApp } from './app';
import { bootstrapAdmin } from './auth';
import { loadCatalogCities } from './catalog';

// Web service: the JSON API (src/server/app.ts) plus the built browser app (dist/client) on one port.
const CLIENT_DIR = path.resolve(fileURLToPath(new URL('../../dist/client', import.meta.url)));
const log = (o: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

async function migrateWithRetry(db: Parameters<typeof migrateDb>[0]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrateDb(db);
      return;
    } catch (e) {
      // A worker may be migrating the same database at the same moment; the second try sees its result.
      if (attempt >= 3) throw e;
      log({ type: 'migrate-retry', attempt, message: (e as Error).message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main(): Promise<void> {
  const { db, pool } = createDb();
  await migrateWithRetry(db);
  if (await bootstrapAdmin(pool, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD)) {
    log({ type: 'admin-created', email: process.env.ADMIN_EMAIL });
  }
  const cities = loadCatalogCities();
  const app = createApp({ pool, cities, secureCookies: process.env.NODE_ENV === 'production' });

  if (existsSync(CLIENT_DIR)) {
    const root = path.relative(process.cwd(), CLIENT_DIR);
    const indexHtml = readFileSync(path.join(CLIENT_DIR, 'index.html'), 'utf8');
    app.use(
      '/assets/*',
      serveStatic({ root, onFound: (_p, c) => c.header('cache-control', 'public, max-age=31536000, immutable') }),
    );
    app.use('*', serveStatic({ root }));
    // Every other path is a screen of the single-page app.
    app.get('*', (c) => {
      c.header('cache-control', 'no-cache');
      return c.html(indexHtml);
    });
  } else {
    log({ type: 'no-client-build', dir: CLIENT_DIR });
  }

  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => log({ type: 'listening', port, cities: cities.length }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
