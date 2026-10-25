import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfigPath, isSourceEnabled, loadConfig } from '../src/config/load';

const REPO_CONFIG = defaultConfigPath();

function tempConfig(mutate: (c: Record<string, any>) => void): string {
  const json = JSON.parse(readFileSync(REPO_CONFIG, 'utf8'));
  mutate(json);
  const dir = mkdtempSync(path.join(tmpdir(), 'pp-config-'));
  const file = path.join(dir, 'pp.config.json');
  writeFileSync(file, JSON.stringify(json));
  return file;
}

describe('config (QUAL-04)', () => {
  it('loads the repo pp.config.json with the agreed thresholds and switches', () => {
    const c = loadConfig(REPO_CONFIG);
    expect(c.qualification).toMatchObject({ minRating: 4.7, minReviews: 10, maxReviews: 99 });
    expect(c.search.terms).toHaveLength(5);
    expect(isSourceEnabled(c, 'tx_comptroller')).toBe(false);
    expect(isSourceEnabled(c, 'maps')).toBe(true);
    expect(c.fetch.dnsOverrides['*.texas.gov']).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  it('a changed threshold in the file changes loadConfig output with no code change', () => {
    const file = tempConfig((c) => {
      c.qualification.minRating = 4.9;
    });
    expect(loadConfig(file).qualification.minRating).toBe(4.9);
  });

  it('refuses a file missing qualification.maxReviews and names the key path', () => {
    const file = tempConfig((c) => {
      delete c.qualification.maxReviews;
    });
    expect(() => loadConfig(file)).toThrow(/qualification\.maxReviews/);
  });

  it('refuses minReviews above maxReviews and names the key path', () => {
    const file = tempConfig((c) => {
      c.qualification.minReviews = 120;
    });
    expect(() => loadConfig(file)).toThrow(/qualification\.minReviews/);
  });

  it('refuses unknown keys (strict) and lists every failing path', () => {
    const file = tempConfig((c) => {
      c.qualification.surprise = true;
      delete c.fetch.timeoutMs;
    });
    let message = '';
    try {
      loadConfig(file);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/qualification/);
    expect(message).toMatch(/fetch\.timeoutMs/);
  });

  it('refuses a missing file and invalid JSON', () => {
    expect(() => loadConfig(path.join(tmpdir(), 'does-not-exist-pp.json'))).toThrow(/Cannot read config/);
    const dir = mkdtempSync(path.join(tmpdir(), 'pp-config-'));
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, '{ not json');
    expect(() => loadConfig(file)).toThrow(/not valid JSON/);
  });
});
