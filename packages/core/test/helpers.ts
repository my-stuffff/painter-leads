import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockAgent } from 'undici';
import { loadConfig } from '../src/config/load';
import type { PpConfig } from '../src/config/schema';
import { createFetcher } from '../src/fetch/fetcher';
import type { Db } from '../src/db/client';

export const PUBLIC_IP = '93.184.216.34';

export function tempDir(prefix = 'pp-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function testConfig(over: {
  websitesIntervalMs?: number;
  websitesRobots?: 'respect' | 'override';
  maxBodyBytes?: number;
  maxDownloadBytes?: number;
  maxRedirects?: number;
} = {}): PpConfig {
  const base = loadConfig();
  return {
    ...base,
    sources: {
      ...base.sources,
      websites: {
        enabled: true,
        minIntervalMs: over.websitesIntervalMs ?? 0,
        robots: over.websitesRobots ?? 'override',
      },
    },
    fetch: {
      ...base.fetch,
      maxBodyBytes: over.maxBodyBytes ?? base.fetch.maxBodyBytes,
      maxDownloadBytes: over.maxDownloadBytes ?? base.fetch.maxDownloadBytes,
      maxRedirects: over.maxRedirects ?? base.fetch.maxRedirects,
    },
  };
}

/** A fetcher wired to a private MockAgent, a fake clock whose sleep advances time, and a stub resolver. */
export function makeTestFetcher(
  over: Parameters<typeof testConfig>[0] & {
    db?: Db | null;
    hosts?: Record<string, string[]>;
    dataDir?: string;
  } = {},
) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  let t = Date.parse('2026-10-25T12:00:00Z');
  const clock = {
    now: () => new Date(t),
    ms: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
  const dataDir = over.dataDir ?? tempDir();
  const fetcher = createFetcher({
    config: testConfig(over),
    db: over.db ?? null,
    dispatcher: agent,
    dataDir,
    now: clock.now,
    sleep: clock.sleep,
    resolveHost: async (host) => over.hosts?.[host] ?? [PUBLIC_IP],
  });
  return { fetcher, agent, clock, dataDir };
}
