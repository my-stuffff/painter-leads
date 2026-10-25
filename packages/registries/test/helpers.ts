import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAgent } from 'undici';
import {
  createFetcher,
  createLogger,
  DbEvidenceStore,
  loadConfig,
  type CompanyRef,
  type Db,
  type Fetcher,
  type PpConfig,
  type SourceId,
  type StageContext,
  type StateCode,
} from '@pp/core';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, 'fixtures');
export const PUBLIC_IP = '93.184.216.34';

export function fixture(...parts: string[]): string {
  return readFileSync(path.join(FIXTURES, ...parts), 'utf8');
}

export function tempDir(prefix = 'pp-reg-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** The repo config with every source un-throttled and robots overridden (tests never wait or fetch robots.txt).
 * The Comptroller starts from its code default (off) whatever the shipped switch says; tests turn it on explicitly. */
export function testConfig(over: Partial<Record<SourceId, { enabled?: boolean; robots?: 'respect' | 'override' }>> = {}): PpConfig {
  const base = loadConfig();
  const sources = { ...base.sources };
  for (const id of Object.keys(sources) as SourceId[]) {
    sources[id] = { ...sources[id], minIntervalMs: 0, robots: over[id]?.robots ?? 'override', enabled: over[id]?.enabled ?? (id === 'tx_comptroller' ? false : sources[id].enabled) };
  }
  return { ...base, sources };
}

export function makeFetcher(config: PpConfig = testConfig()): {
  fetcher: Fetcher;
  agent: MockAgent;
  config: PpConfig;
  dataDir: string;
  /** Hosts the mock agent was asked to reach, in order. */
  hosts(): string[];
  /** Full call history lines "METHOD host/path". */
  calls(): string[];
} {
  const agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  const dataDir = tempDir();
  const fetcher = createFetcher({
    config,
    db: null,
    dispatcher: agent,
    dataDir,
    now: () => new Date('2026-10-25T12:00:00Z'),
    sleep: async () => undefined,
    resolveHost: async () => [PUBLIC_IP],
  });
  const calls = () =>
    agent
      .getCallHistory()
      ?.calls()
      .map((c) => `${c.method} ${c.origin}${c.path}`) ?? [];
  return { fetcher, agent, config, dataDir, calls, hosts: () => calls().map((c) => c.split(' ')[1]?.replace(/^https?:\/\//, '').split('/')[0] ?? '') };
}

export function stageContext(db: Db, fetcher: Fetcher, config: PpConfig): StageContext {
  return {
    runId: 1,
    config,
    db,
    evidence: new DbEvidenceStore(db),
    fetcher,
    log: createLogger('registries-test'),
    now: () => new Date('2026-10-25T12:00:00Z'),
    sleep: async () => undefined,
  };
}

/** Inserts a company row (all the stage needs) and returns its CompanyRef. */
export async function insertCompany(
  db: Db,
  c: Partial<CompanyRef> & { name: string; state: StateCode },
): Promise<CompanyRef> {
  const res = await db.$client.query('INSERT INTO companies (display_name, state) VALUES ($1, $2) RETURNING id', [c.name, c.state]);
  return {
    companyId: res.rows[0].id as number,
    name: c.name,
    state: c.state,
    city: c.city ?? null,
    zip: c.zip ?? null,
    street: c.street ?? null,
    websiteUrl: c.websiteUrl ?? null,
    phoneE164: c.phoneE164 ?? null,
    categories: c.categories ?? ['Painter'],
  };
}
