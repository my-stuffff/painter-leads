import type { SourceId } from '../types';

export interface FetchOptions {
  source: SourceId;
  headers?: Record<string, string>;
  cache?: 'use' | 'refresh' | 'none';
  offline?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  runId?: number | null;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  sha256: string;
  cachePath: string | null;
  fromCache: boolean;
  fetchedAt: Date;
}

export interface FetchSession {
  get(url: string, o?: Partial<FetchOptions>): Promise<FetchResult>;
  post(
    url: string,
    form: Record<string, string> | URLSearchParams,
    o?: Partial<FetchOptions>,
  ): Promise<FetchResult>;
  cookies(): Record<string, string>;
}

export interface Fetcher {
  get(url: string, o: FetchOptions): Promise<FetchResult>;
  post(url: string, form: Record<string, string> | URLSearchParams, o: FetchOptions): Promise<FetchResult>;
  session(label: string, source: SourceId): FetchSession;
  download(
    url: string,
    destPath: string,
    o: FetchOptions & { method?: 'GET' | 'POST'; form?: Record<string, string> },
  ): Promise<{ path: string; bytes: number; sha256: string }>;
  robotsAllowed(url: string, source: SourceId): Promise<boolean>;
  readCached(sha256: string): Promise<Buffer | null>;
  /** Browser-rendered HTML goes to the same disk cache with a pages row (rendered true). */
  storeRendered(
    url: string,
    html: string,
    o: { source: SourceId; runId?: number | null },
  ): Promise<{ sha256: string; cachePath: string }>;
  /** SSRF pre-check for URLs opened outside the fetcher (Chromium). */
  assertPublicUrl(url: string): Promise<void>;
}
