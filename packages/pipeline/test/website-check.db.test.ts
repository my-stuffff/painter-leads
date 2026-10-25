import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll } from '@pp/core';
import { MASTER_COLUMNS } from '../src/report/columns';
import { reprocessRun } from '../src/reprocess';
import { runPilot } from '../src/run';
import { q } from '../src/sql';
import { makeEnv, publicResolver, readSheets, tempDir } from './helpers';

const handle = getTestDb();
const db = handle.db;

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const SITE = 'fakepainting-one.test';
const WEBSITE = `https://${SITE}`;
const MISSING_TEXT = 'website listed on Google does not exist (checked 2026-10-25)';

async function crawlLog(runId: number, outcome: string, note: string | null, host = SITE): Promise<void> {
  await q(
    db,
    `INSERT INTO request_log (source, host, method, url, outcome, run_id, note) VALUES ('websites', $1, 'GET', $2, $3, $4, $5)`,
    [host, `https://${host}/`, outcome, runId, note],
  );
}

/** A finished fake run, so there are companies, Google website evidence and a report to rebuild. */
async function finishedRun(): Promise<{ runId: number; out: string; env: ReturnType<typeof makeEnv> }> {
  const env = makeEnv(db);
  const out = tempDir();
  const first = await runPilot(env, 'edison_nj', { fake: true, outDir: out });
  return { runId: first.runId, out, env };
}

async function masterRow(file: string, company: string): Promise<Record<string, unknown>> {
  const sheets = await readSheets(file);
  const [header, ...rows] = sheets['Master list'] as unknown[][];
  const row = rows.find((r) => r[0] === company);
  if (!row) throw new Error(`no Master row for ${company}`);
  return Object.fromEntries((header as string[]).map((h, i) => [h, row[i]]));
}

const websiteEvidence = (): Promise<{ status: string; reject_reason: string | null; source_type: string }[]> =>
  q(db, `SELECT status, reject_reason, source_type FROM evidence WHERE field = 'website' AND value = $1 ORDER BY id`, [WEBSITE]);

describe('a website listed on Google whose domain does not exist', () => {
  it('is confirmed on the public resolver, blanked in the report, and explained on the Sources tab (through reprocess)', async () => {
    const { runId, out, env } = await finishedRun();
    expect((await masterRow(`${out}/${runId}/edison_nj.xlsx`, 'Fake Painting One'))['Website']).toBe(WEBSITE);

    await crawlLog(runId, 'dns_error', `getaddrinfo ENOTFOUND ${SITE}`);
    const resolver = publicResolver({});
    const result = await reprocessRun(env, runId, { fake: true, outDir: out, resolver });

    // the Google-listed value stays as evidence, rejected with the reason; nothing is deleted
    const rows = await websiteEvidence();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'rejected' && r.reject_reason === MISSING_TEXT && r.source_type === 'google_maps')).toBe(true);
    expect(resolver.calls).toEqual([`a:${SITE}`, `aaaa:${SITE}`]);

    const sheets = await readSheets(result.report.xlsxPath);
    const websiteCol = MASTER_COLUMNS.indexOf('Website');
    for (const tab of ['Master list', 'Qualified']) {
      const [, ...body] = sheets[tab] as unknown[][];
      expect(body.every((r) => !String(r[websiteCol] ?? '').includes(SITE))).toBe(true);
    }
    expect((await masterRow(result.report.xlsxPath, 'Fake Painting One'))['Website'] ?? null).toBeNull();
    const noteRows = (sheets['Sources'] as unknown[][]).filter((r) => r[0] === 'Fake Painting One' && r[1] === 'Website');
    expect(noteRows.map((r) => r[2])).toEqual([MISSING_TEXT]);

    // the other fake companies keep their websites
    expect((await masterRow(result.report.xlsxPath, 'Fake Painting Two'))['Website']).toBe('https://fakepainting-two.test');

    // asked again, nothing is looked up a second time and the answer is the same
    await reprocessRun(env, runId, { fake: true, outDir: out, resolver });
    expect(resolver.calls).toHaveLength(2);
    expect(((await readSheets(result.report.xlsxPath))['Sources'] as unknown[][]).filter((r) => r[0] === 'Fake Painting One' && r[1] === 'Website')).toHaveLength(1);
  });

  it('is also settled when the live run itself finds it (runPilot with the same crawl log)', async () => {
    const env = makeEnv(db);
    const out = tempDir();
    const resolver = publicResolver({});
    // plan the run up front so the crawl log can name it
    const first = await runPilot(env, 'edison_nj', { fake: true, outDir: out, resolver });
    await crawlLog(first.runId, 'dns_error', `getaddrinfo ENOTFOUND ${SITE}`);
    await runPilot(env, 'edison_nj', { fake: true, outDir: out, runId: first.runId, refresh: true, resolver });
    expect((await websiteEvidence()).every((r) => r.status === 'rejected')).toBe(true);
  });

  it('is kept when this laptop says ENOTFOUND but the public resolver finds the domain', async () => {
    const { runId, out, env } = await finishedRun();
    await crawlLog(runId, 'dns_error', `getaddrinfo ENOTFOUND ${SITE}`);
    const resolver = publicResolver({ [SITE]: { a: ['93.184.216.34'] } });
    const result = await reprocessRun(env, runId, { fake: true, outDir: out, resolver });

    expect(resolver.calls.length).toBeGreaterThan(0);
    expect((await websiteEvidence()).every((r) => r.status === 'accepted' && r.reject_reason === null)).toBe(true);
    expect((await masterRow(result.report.xlsxPath, 'Fake Painting One'))['Website']).toBe(WEBSITE);
    const sources = (await readSheets(result.report.xlsxPath))['Sources'] as unknown[][];
    expect(sources.some((r) => String(r[2]).includes('does not exist'))).toBe(false);
  });

  it('is kept on EAI_AGAIN (a temporary failure): no second lookup, nothing changes', async () => {
    const { runId, out, env } = await finishedRun();
    await crawlLog(runId, 'dns_error', `getaddrinfo EAI_AGAIN ${SITE}`);
    const resolver = publicResolver({});
    const result = await reprocessRun(env, runId, { fake: true, outDir: out, resolver });

    expect(resolver.calls).toEqual([]);
    expect((await websiteEvidence()).every((r) => r.status === 'accepted')).toBe(true);
    expect((await masterRow(result.report.xlsxPath, 'Fake Painting One'))['Website']).toBe(WEBSITE);
  });

  it.each([
    ['an HTTP error (403)', 'http_error', 'HTTP 403'],
    ['a timeout', 'timeout', 'The operation was aborted due to timeout'],
  ])('is kept on %s: that is not "does not exist"', async (_label, outcome, note) => {
    const { runId, out, env } = await finishedRun();
    await crawlLog(runId, outcome, note);
    const resolver = publicResolver({});
    const result = await reprocessRun(env, runId, { fake: true, outDir: out, resolver });
    expect(resolver.calls).toEqual([]);
    expect((await masterRow(result.report.xlsxPath, 'Fake Painting One'))['Website']).toBe(WEBSITE);
  });

  it('is kept when the public resolver itself fails (timeout): only a confirmed NXDOMAIN blanks it', async () => {
    const { runId, out, env } = await finishedRun();
    await crawlLog(runId, 'dns_error', `getaddrinfo ENOTFOUND ${SITE}`);
    const resolver = publicResolver({ [SITE]: { a: 'ETIMEOUT', aaaa: 'ETIMEOUT' } });
    const result = await reprocessRun(env, runId, { fake: true, outDir: out, resolver });
    expect(resolver.calls.length).toBeGreaterThan(0);
    expect((await masterRow(result.report.xlsxPath, 'Fake Painting One'))['Website']).toBe(WEBSITE);
  });

  it('uses the latest crawl result: a later successful fetch cancels an earlier ENOTFOUND', async () => {
    const { runId, out, env } = await finishedRun();
    await crawlLog(runId, 'dns_error', `getaddrinfo ENOTFOUND ${SITE}`);
    await crawlLog(runId, 'ok', null);
    const resolver = publicResolver({});
    await reprocessRun(env, runId, { fake: true, outDir: out, resolver });
    expect(resolver.calls).toEqual([]);
  });
});
