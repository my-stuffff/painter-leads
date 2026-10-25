import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll, type Fetcher } from '@pp/core';
import { exportGolden, nameSlug, slimHtml } from '../src/accuracy/golden-export';
import { loadGoldenCases, replayCase } from '../src/accuracy/golden-replay';
import { drawSample } from '../src/accuracy/sample';
import { q } from '../src/sql';
import { correctReplayers } from './golden-fakes';
import { makeEnv, tempDir } from './helpers';
import { buildScenario, type Scenario } from './scenario';

const handle = getTestDb();
const db = handle.db;
const env = makeEnv(db);

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const SHA = 'a'.repeat(64);
const PAGE = `<!doctype html><html><head><style>body{color:red}</style><script>var tracker = 1;</script>
<script type="application/ld+json">{"@type":"Organization","name":"Alpha Painting"}</script></head>
<body><!-- builder comment --><svg><path d="M0 0"/></svg>
<h1>Alpha Painting</h1><a href="mailto:info@alphapainting.com">Email</a><p>Meet Jane Alpha, owner of Alpha Painting.</p></body></html>`;

const cache = (html: string = PAGE): Pick<Fetcher, 'readCached'> => ({
  readCached: async (sha) => (sha === SHA ? Buffer.from(html) : null),
});

function truthCsv(sampleId: string, over: Record<string, string> = {}): string {
  const rows: Record<string, string> = {
    name: 'Alpha Painting',
    phone: '+17325550101',
    website: 'https://alphapainting.com',
    email: 'info@alphapainting.com',
    owner_name: 'Jane Alpha',
    owner_title: 'Owner',
    rating: '4.8',
    review_count: '25',
    address: '1 Oak St, Edison, NJ 08817',
    zip: '08817',
    category: 'Painter',
    residential_status: 'residential_only',
    is_painter: 'yes',
    ...over,
  };
  return [
    'sample_id,field,value,source_url,checked_at,notes',
    ...Object.entries(rows).map(([f, v]) => `${sampleId},${f},${v},https://truth.test,2026-10-26T09:00:00Z,`),
  ].join('\n');
}

/** The scenario, finished, with a page in the cache, a Maps card, a registry match and a drawn sample. */
async function prepare(): Promise<{ s: Scenario; alphaSample: string }> {
  const s = await buildScenario(env);
  await q(db, `UPDATE runs SET status = 'done' WHERE id = $1`, [s.runId]);

  const [alpha] = await q<{ id: number; listing: number }>(db, `SELECT c.id, l.id AS listing FROM companies c JOIN listings l ON l.company_id = c.id WHERE c.display_name = 'Alpha Painting'`);
  await q(db, `INSERT INTO pages (url, host, sha256, source, rendered) VALUES ('https://alphapainting.com/', 'alphapainting.com', $1, 'websites', false)`, [SHA]);
  await q(db, `UPDATE evidence SET page_sha256 = $2 WHERE company_id = $1 AND extractor = 'seed-site'`, [alpha?.id, SHA]);
  await q(
    db,
    `UPDATE listings SET card_raw = $2::jsonb WHERE id = $1`,
    [alpha?.listing, JSON.stringify({ name: 'Alpha Painting', rating: '4.8', review_count: '25', phone: '+17325550101', category: 'Painter', website: 'https://alphapainting.com' })],
  );

  const [rec] = await q<{ id: number }>(
    db,
    `INSERT INTO registry_records (source_type, source_key, state, legal_name, status, city, zip, raw, source_url)
     VALUES ('nj_hic_roster', '13VH00000100', 'NJ', 'Alpha Painting LLC', 'Active', 'Edison', '08817', '{"secret_roster_column":"SHOULD-NOT-BE-EXPORTED"}'::jsonb, 'https://newjersey.mylicense.com/seed/1') RETURNING id`,
  );
  await q(db, `INSERT INTO registry_people (registry_record_id, source_type, full_name, title) VALUES ($1, 'nj_hic_detail', 'Jane Alpha', 'Owner')`, [rec?.id]);
  await q(db, `INSERT INTO registry_matches (company_id, registry_record_id, rung, strength) VALUES ($1, $2, 'name_zip', 'strong')`, [alpha?.id, rec?.id]);

  const drawn = await drawSample(db, env.config, s.runId, 42, s.base);
  const sample = drawn.samples.find((x) => x.company === 'Alpha Painting');
  return { s, alphaSample: sample?.sampleId as string };
}

describe('slimming and slugs', () => {
  it('drops style, svg, comments and every script except application/ld+json', () => {
    const out = slimHtml(PAGE);
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('tracker');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('builder comment');
    expect(out).toContain('application/ld+json');
    expect(out).toContain('mailto:info@alphapainting.com');
    expect(out).toContain('Meet Jane Alpha');
  });

  it('makes tidy slugs', () => {
    expect(nameSlug('Café Muñoz Painting & Sons, LLC')).toBe('cafe-munoz-painting-sons-llc');
    expect(nameSlug('A'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe('pp accuracy golden-export (ACC-02)', () => {
  it('writes pages, pages.json, maps-card.json, registry.json and truth.json for a checked company', async () => {
    const { s, alphaSample } = await prepare();
    const out = tempDir();
    const r = await exportGolden(db, env.config, s.runId, { truthText: truthCsv(alphaSample), outDir: out, fetcher: cache() });

    expect(r.cases).toHaveLength(1); // only the company the checker gave truth for
    expect(r.warnings.some((w) => w.includes('no truth values'))).toBe(true);
    const c = r.cases[0]!;
    expect(c.state).toBe('NJ');
    expect(c.slug).toBe(`${alphaSample.toLowerCase()}-alpha-painting`);
    expect(c.dir).toBe(path.join(out, 'NJ', c.slug));

    // the page is slimmed, gzipped, named after its original sha, and described in pages.json
    const gz = path.join(c.dir, 'pages', `${SHA}.html.gz`);
    const html = gunzipSync(readFileSync(gz)).toString('utf8');
    expect(html).toContain('mailto:info@alphapainting.com');
    expect(html).not.toContain('tracker');
    expect(html).toContain('application/ld+json');
    expect(JSON.parse(readFileSync(path.join(c.dir, 'pages.json'), 'utf8'))).toEqual([{ url: 'https://alphapainting.com/', sha256: SHA, rendered: false }]);

    expect(JSON.parse(readFileSync(path.join(c.dir, 'maps-card.json'), 'utf8')).card_raw).toMatchObject({ name: 'Alpha Painting', rating: '4.8' });

    const truth = JSON.parse(readFileSync(path.join(c.dir, 'truth.json'), 'utf8'));
    expect(truth.company).toMatchObject({ name: 'Alpha Painting', state: 'NJ', websiteUrl: 'https://alphapainting.com', zip: '08817' });
    expect(truth.fields.emails).toEqual(['info@alphapainting.com']);
    expect(truth.fields.owners).toEqual({ expected: ['Jane Alpha'], ignore: [] });
    expect(truth.fields.residential).toBe('residential_only');
    expect(truth.fields.maps_card).toMatchObject({ name: 'Alpha Painting', rating: '4.8', review_count: '25', phone: '+17325550101', category: 'Painter' });
    expect(truth.fields.registry_match).toEqual([{ sourceKey: '13VH00000100', strength: 'strong' }]);

    const total = (dir: string): number =>
      readdirSync(dir).reduce((n, f) => {
        const p = path.join(dir, f);
        return n + (statSync(p).isDirectory() ? total(p) : statSync(p).size);
      }, 0);
    expect(r.totalBytes).toBe(total(c.dir));
    expect(r.totalBytes).toBeGreaterThan(0);
  });

  it('registry.json carries no raw roster columns, only the matcher fields and owner names', async () => {
    const { s, alphaSample } = await prepare();
    const r = await exportGolden(db, env.config, s.runId, { truthText: truthCsv(alphaSample), outDir: tempDir(), fetcher: cache() });
    const text = readFileSync(path.join(r.cases[0]!.dir, 'registry.json'), 'utf8');
    expect(text).not.toContain('SHOULD-NOT-BE-EXPORTED');
    expect(text).not.toContain('secret_roster_column');
    expect(text).not.toContain('"raw"');
    const reg = JSON.parse(text);
    expect(reg.candidates[0]).toMatchObject({ sourceKey: '13VH00000100', legalName: 'Alpha Painting LLC', status: 'Active', owners: [{ name: 'Jane Alpha', title: 'Owner' }] });
    expect(reg.matches).toEqual([{ sourceKey: '13VH00000100', strength: 'strong' }]);
  });

  it('the exported case replays to zero differences with correct replayers, and nothing to warn about', async () => {
    const { s, alphaSample } = await prepare();
    const out = tempDir();
    const r = await exportGolden(db, env.config, s.runId, { truthText: truthCsv(alphaSample), outDir: out, fetcher: cache(), replayers: correctReplayers() });
    expect(r.warnings.filter((w) => !w.includes('no truth values'))).toEqual([]);
    const cases = loadGoldenCases(out);
    expect(cases).toHaveLength(1);
    expect(replayCase(cases[0]!, correctReplayers())).toEqual([]);
  });

  it('warns when the replay of the slimmed page differs from what the system stored (slimming never silently changes an answer)', async () => {
    const { s, alphaSample } = await prepare();
    const broken = { ...correctReplayers(), emails: () => [] };
    const r = await exportGolden(db, env.config, s.runId, { truthText: truthCsv(alphaSample), outDir: tempDir(), fetcher: cache(), replayers: broken });
    expect(r.warnings.some((w) => w.includes('/emails: replay gives (none) but the system stored info@alphapainting.com'))).toBe(true);
  });

  it('a truth of NOT_FINDABLE becomes a golden field that fails if an extractor now fills it', async () => {
    const { s, alphaSample } = await prepare();
    const out = tempDir();
    await exportGolden(db, env.config, s.runId, {
      truthText: truthCsv(alphaSample, { owner_name: 'NOT_FINDABLE', email: 'NOT_FINDABLE' }),
      outDir: out,
      fetcher: cache(),
    });
    const [c] = loadGoldenCases(out);
    expect(c?.truth.fields.owners).toEqual({ expected: 'NOT_FINDABLE', ignore: [] });
    expect(c?.truth.fields.emails).toBe('NOT_FINDABLE');
    // the page really carries an email and an owner, so the correct fake replayers now "fill" them: both fail
    expect(replayCase(c!, correctReplayers()).map((d) => d.field)).toEqual(['emails', 'owners']);
  });

  it('refuses to write any file over the size limit', async () => {
    const { s, alphaSample } = await prepare();
    const big = `<html><body>${'x'.repeat(5000)}${Math.random()}</body></html>`; // random text does not compress away
    const noise = Array.from({ length: 3000 }, () => Math.random().toString(36)).join('');
    await expect(
      exportGolden(db, env.config, s.runId, {
        truthText: truthCsv(alphaSample),
        outDir: tempDir(),
        fetcher: cache(big + noise),
        maxFileBytes: 4000,
      }),
    ).rejects.toThrow(/over the 4000 byte limit/);
  });

  it('leaves a page that is not in the cache out with a warning, and never touches the network', async () => {
    const { s, alphaSample } = await prepare();
    const out = tempDir();
    const r = await exportGolden(db, env.config, s.runId, { truthText: truthCsv(alphaSample), outDir: out, fetcher: { readCached: async () => null } });
    expect(r.warnings.some((w) => w.includes('not in the cache'))).toBe(true);
    expect(existsSync(path.join(r.cases[0]!.dir, 'pages', `${SHA}.html.gz`))).toBe(false);
  });
});
