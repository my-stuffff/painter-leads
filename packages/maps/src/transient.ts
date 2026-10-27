import type { Db, StageContext } from '@pp/core';
import { logRequest, type RequestKind } from './cap';
import type { OpenResult, PageDriver } from './driver/types';
import { randomPause } from './throttle';

/** A page that never loads is retried once after a pause in this range (ms). */
export const TRANSIENT_PAUSE_MS: readonly [number, number] = [30_000, 60_000];

/** This many items in a row that never loaded (each tried twice) look like a network outage: the run stops, resumable. */
export const MAX_TRANSIENT_STREAK = 3;

/** A navigation that ran out of time or hit a network error: Playwright's TimeoutError or a `net::ERR_*` message. A block is not one. */
export function isTransientNavError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || /net::ERR_/.test(e.message));
}

/** This many browser crashes in a row stop the stage with the error; fewer are survived by starting a fresh browser. */
export const MAX_CRASH_STREAK = 5;

/** The browser or its tab died under the page (out of memory in a small container), as opposed to a page or parse error. */
export function isBrowserCrash(e: unknown): boolean {
  return (
    e instanceof Error &&
    /Target crashed|Page crashed|Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(
      e.message,
    )
  );
}

export type OpenAttempt = { ok: true; opened: OpenResult; started: number } | { ok: false; error: Error };

/**
 * Opens `url`. A transient error is logged, waited out and retried once on the same page; a second transient
 * error comes back as `{ ok: false }` so the caller can skip the item. Any other error is logged and thrown as before.
 * `started` is the time the successful attempt began (the caller logs that request itself).
 */
export async function openWithRetry(
  driver: PageDriver,
  url: string,
  o: {
    db: Db;
    runId: number;
    kind: RequestKind;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    rng?: () => number;
    log: StageContext['log'];
  },
): Promise<OpenAttempt> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      return { ok: true, opened: await driver.open(url), started };
    } catch (e) {
      const transient = isTransientNavError(e);
      await logRequest(o.db, {
        runId: o.runId,
        url,
        status: null,
        ms: Date.now() - started,
        outcome: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'http_error',
        note: o.kind,
        at: o.now(),
      });
      if (!transient) throw e;
      const message = (e as Error).message.split('\n')[0];
      if (attempt >= 2) {
        o.log.warn({ url, message }, `${o.kind} page did not load after a retry; skipping it for now`);
        return { ok: false, error: e as Error };
      }
      o.log.warn({ url, message }, `${o.kind} page did not load; retrying once after a pause`);
      await o.sleep(randomPause(TRANSIENT_PAUSE_MS, o.rng));
    }
  }
}
