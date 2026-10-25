/**
 * Per-host spacing between request starts. Calls for one host are serialised, so two concurrent
 * callers still start at least `minIntervalMs` apart; different hosts never delay each other.
 */
export class HostRateLimiter {
  private readonly last = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly now: () => Date,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  wait(host: string, minIntervalMs: number): Promise<void> {
    const prev = this.tails.get(host) ?? Promise.resolve();
    const turn = prev.then(async () => {
      const last = this.last.get(host);
      if (last !== undefined) {
        const remaining = last + minIntervalMs - this.now().getTime();
        if (remaining > 0) await this.sleep(remaining);
      }
      this.last.set(host, this.now().getTime());
    });
    this.tails.set(
      host,
      turn.catch(() => undefined),
    );
    return turn;
  }
}
