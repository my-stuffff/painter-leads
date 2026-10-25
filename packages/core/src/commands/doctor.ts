import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { cacheKey, PageCache } from '../fetch/cache';
import { createFetcher } from '../fetch/fetcher';
import { migrationsApplied } from '../db/migrate';
import { companies, listings, runs } from '../db/schema';
import { DbEvidenceStore, MemoryEvidenceStore } from '../evidence/store';
import { selectBest } from '../evidence/select';
import { createFakeStages } from '../stages/fakes';
import type { StageContext } from '../stages/types';
import type { CommandSpec } from './types';

class Rollback extends Error {}

export const doctorCommand: CommandSpec = {
  name: 'doctor',
  description: 'Check that config, database, migrations, evidence, fetcher and the stage chain work end to end',
  async run(ctx) {
    let failed = false;
    const check = async (label: string, fn: () => Promise<string | void>): Promise<void> => {
      try {
        const extra = await fn();
        ctx.out(`${label}: ok${extra ? ` (${extra})` : ''}`);
      } catch (e) {
        failed = true;
        ctx.out(`${label}: FAIL (${(e as Error).message.split('\n')[0]})`);
      }
    };

    await check('config', async () => {
      ctx.config();
    });

    await check('database', async () => {
      const db = await ctx.db();
      await db.$client.query('SELECT 1');
    });

    await check('migrations', async () => {
      const db = await ctx.db();
      if (!(await migrationsApplied(db))) throw new Error('migrations not applied; run: pp db migrate --create');
    });

    await check('evidence', async () => {
      const db = await ctx.db();
      try {
        await db.transaction(async (tx) => {
          const [run] = await tx
            .insert(runs)
            .values({ areaId: 'doctor', state: 'NJ', configSnapshot: ctx.config() })
            .returning({ id: runs.id });
          const [company] = await tx.insert(companies).values({ displayName: 'Doctor Painting', runId: run!.id }).returning({ id: companies.id });
          const [listing] = await tx
            .insert(listings)
            .values({
              placeId: 'doctor-place',
              profileUrl: 'https://www.google.com/maps/place/doctor',
              name: 'Doctor Painting',
              companyId: company!.id,
              rating: 4.8,
              ratingStatus: 'captured',
              reviewCount: 25,
              reviewCountStatus: 'captured',
            })
            .returning({ id: listings.id });
          const store = new DbEvidenceStore(tx);
          const base = {
            companyId: company!.id,
            listingId: listing!.id,
            field: 'rating' as const,
            sourceType: 'google_maps' as const,
            sourceUrl: 'https://www.google.com/maps/place/doctor',
            capturedAt: new Date('2026-01-01T00:00:00Z'),
            snippet: 'Doctor Painting 4.8',
            extractor: 'doctor',
            extractorVersion: '0',
          };
          await store.record({ ...base, value: '4.8', confidence: 'high' });
          await store.record({ ...base, value: '4.2', confidence: 'low' });
          const rows = await store.listForCompany(company!.id, 'rating');
          const best = selectBest(rows, 'rating');
          if (rows.length !== 2 || best?.value !== '4.8') throw new Error('evidence round-trip returned the wrong best value');
          const found = await tx.select().from(companies).where(eq(companies.id, company!.id));
          if (found.length !== 1) throw new Error('company not readable inside the transaction');
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
    });

    await check('fetcher', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'pp-doctor-'));
      try {
        const url = 'https://doctor.invalid/page';
        const body = Buffer.from('<html>doctor</html>');
        await new PageCache(dir).write(cacheKey('GET', url), body, {
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          contentType: 'text/html',
          fetchedAt: new Date().toISOString(),
          rendered: false,
        });
        const fetcher = createFetcher({ config: ctx.config(), db: null, dataDir: dir });
        const got = await fetcher.get(url, { source: 'websites', offline: true });
        if (!got.fromCache || !got.body.equals(body)) throw new Error('cached page did not round-trip');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    await check('stages(fake)', async () => {
      const stages = createFakeStages();
      const evidence = new MemoryEvidenceStore();
      const sctx: StageContext = {
        runId: 1,
        config: ctx.config(),
        db: undefined as never,
        evidence,
        fetcher: undefined as never,
        log: ctx.log,
        now: () => new Date('2026-01-01T00:00:00Z'),
        sleep: async () => {},
      };
      await stages.discover.run(sctx, { runId: 1 });
      await stages.detail.run(sctx, { runId: 1 });
      const merged = await stages.merge.run(sctx, { runId: 1 });
      const q1 = await stages.qualify.run(sctx, { companyId: 1 });
      const q2 = await stages.qualify.run(sctx, { companyId: 2 });
      if (merged.companies !== 2 || !q1.qualified || q2.qualified) throw new Error('fake stage chain gave unexpected results');
    });

    ctx.out(`modules: ${(ctx.moduleNames ?? ['core']).join(',')}`);
    return failed ? 1 : 0;
  },
};
