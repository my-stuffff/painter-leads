import robotsParser from 'robots-parser';

export const ROBOTS_AGENT = 'PainterLeadsBot';

type Robots = ReturnType<typeof robotsParser>;

interface Entry {
  /** null = disallow everything (robots.txt 5xx / unreachable, RFC 9309 2.3.1.4). */
  robots: Robots | null;
  /** true = allow everything (robots.txt 4xx, RFC 9309 2.3.1.3). */
  allowAll: boolean;
  expiresAt: number;
}

export interface RobotsFetchResult {
  status: number;
  text: string;
}

/**
 * robots.txt per origin, cached for `cacheHours`. 2xx: parse. 4xx: allow all. 5xx or unreachable
 * (fetch returns null): disallow all.
 */
export class RobotsCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly fetchRobots: (origin: string) => Promise<RobotsFetchResult | null>,
    private readonly cacheHours: number,
    private readonly now: () => Date,
  ) {}

  async allowed(url: string): Promise<boolean> {
    const origin = new URL(url).origin;
    let entry = this.entries.get(origin);
    if (!entry || entry.expiresAt <= this.now().getTime()) {
      entry = await this.load(origin);
      this.entries.set(origin, entry);
    }
    if (entry.allowAll) return true;
    if (!entry.robots) return false;
    return entry.robots.isAllowed(url, ROBOTS_AGENT) !== false;
  }

  private async load(origin: string): Promise<Entry> {
    const expiresAt = this.now().getTime() + this.cacheHours * 3_600_000;
    const res = await this.fetchRobots(origin);
    if (res === null || res.status >= 500) return { robots: null, allowAll: false, expiresAt };
    if (res.status >= 400) return { robots: null, allowAll: true, expiresAt };
    return { robots: robotsParser(`${origin}/robots.txt`, res.text), allowAll: false, expiresAt };
  }
}
