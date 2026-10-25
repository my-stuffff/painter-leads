import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/paths';
import { tempDir } from './helpers';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-guards.mjs');

function repoWith(files: Record<string, string | Buffer>): string {
  const dir = tempDir('pp-guards-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  git('add', '-A');
  return dir;
}

function run(dir: string) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('scripts/check-guards.mjs', () => {
  it('passes a clean repo and the real repo', () => {
    expect(run(repoWith({ 'src/a.ts': 'export const a = 1;\n' }))).toMatchObject({ code: 0, out: 'guards: ok\n' });
    expect(run(REPO_ROOT)).toMatchObject({ code: 0, out: 'guards: ok\n' });
  });

  it('refuses a file over 1 MB but allows the pilot geojson up to 5 MB', () => {
    const big = Buffer.alloc(1_200_000, 'a');
    expect(run(repoWith({ 'data/big.json': big })).code).toBe(1);
    expect(run(repoWith({ 'data/geo/pilot-zcta.geojson': big })).code).toBe(0);
    expect(run(repoWith({ 'data/geo/pilot-zcta.geojson': Buffer.alloc(5_200_000, 'a') })).code).toBe(1);
  });

  it('refuses raw roster / personnel / export file names', () => {
    for (const name of ['Data.txt', 'x/PersonnelData.csv', 'MasterLicenseData.txt', 'Export_Contacts_All.csv']) {
      const r = run(repoWith({ [name]: 'x' }));
      expect(r.code, name).toBe(1);
      expect(r.err).toContain(name);
    }
  });

  it('refuses csv/xlsx outside test or fixtures folders', () => {
    expect(run(repoWith({ 'data/list.csv': 'a,b' })).code).toBe(1);
    expect(run(repoWith({ 'report.xlsx': 'x' })).code).toBe(1);
    expect(run(repoWith({ 'packages/x/test/fixtures/list.csv': 'a,b' })).code).toBe(0);
    expect(run(repoWith({ 'fixtures/golden/list.csv': 'a,b' })).code).toBe(0);
  });

  it("refuses content that mentions the owner's Downloads folder", () => {
    const bad = ['C:', 'Users', 'bigsh', 'Downloads', 'file.csv'].join('\\');
    const badSlash = ['C:', 'Users', 'bigsh', 'Downloads'].join('/');
    expect(run(repoWith({ 'src/a.ts': `const p = ${JSON.stringify(bad)};` })).code).toBe(1);
    expect(run(repoWith({ 'src/a.ts': `// ${badSlash}` })).code).toBe(1);
  });

  it('ignores .planning/', () => {
    const bad = ['C:', 'Users', 'bigsh', 'Downloads'].join('\\');
    expect(run(repoWith({ '.planning/notes.md': bad })).code).toBe(0);
  });
});
