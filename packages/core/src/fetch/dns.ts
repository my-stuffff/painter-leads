import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { PpConfig } from '../config/schema';
import { NetworkDisabledError, SsrfRefusedError } from './errors';
import { isPublicAddress } from './ssrf';

export interface DnsResolver {
  resolveMx(d: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(d: string): Promise<string[]>;
  resolve6(d: string): Promise<string[]>;
}

/** DNS for MX/A checks. Optionally pinned to specific servers. Throws under the test network guard. */
export function createDnsResolver(servers?: string[]): DnsResolver {
  if (process.env.PP_NETWORK_GUARD === '1') throw new NetworkDisabledError('DNS resolver created under the network guard');
  const r = new dns.promises.Resolver();
  if (servers && servers.length > 0) r.setServers(servers);
  return {
    resolveMx: (d) => r.resolveMx(d),
    resolve4: (d) => r.resolve4(d),
    resolve6: (d) => r.resolve6(d),
  };
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type AddressResolver = (host: string) => Promise<ResolvedAddress[]>;

/** Glob (`*.texas.gov`) match: `*` matches one or more labels, never the bare parent domain. */
export function hostMatchesGlob(host: string, glob: string): boolean {
  const re = new RegExp(
    `^${glob
      .toLowerCase()
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+')}$`,
  );
  return re.test(host.toLowerCase());
}

/** Resolver servers configured for this host in fetch.dnsOverrides, or null for the system resolver. */
export function dnsServersFor(host: string, config: PpConfig): string[] | null {
  for (const [glob, servers] of Object.entries(config.fetch.dnsOverrides)) {
    if (hostMatchesGlob(host, glob)) return servers;
  }
  return null;
}

export function systemAddressResolver(): AddressResolver {
  return async (host) => {
    const res = await dns.promises.lookup(host, { all: true });
    return res.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  };
}

export function serversAddressResolver(servers: string[], make: (servers: string[]) => DnsResolver = createDnsResolver): AddressResolver {
  return async (host) => {
    const r = make(servers);
    const [v4, v6] = await Promise.all([r.resolve4(host).catch(() => [] as string[]), r.resolve6(host).catch(() => [] as string[])]);
    const out: ResolvedAddress[] = [
      ...v4.map((address) => ({ address, family: 4 as const })),
      ...v6.map((address) => ({ address, family: 6 as const })),
    ];
    if (out.length === 0) {
      const err = new Error(`queryA ENOTFOUND ${host}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    }
    return out;
  };
}

/** The address resolver for a host: configured override servers, else the system resolver. */
export function addressResolverFor(
  host: string,
  config: PpConfig,
  makeResolver: (servers: string[]) => DnsResolver = createDnsResolver,
): AddressResolver {
  const servers = dnsServersFor(host, config);
  return servers ? serversAddressResolver(servers, makeResolver) : systemAddressResolver();
}

/**
 * Connect-time lookup for an undici Agent. Resolves, then refuses with SsrfRefusedError when ANY
 * address is not public (SSRF guard after DNS). Honours `options.all` (Node's net passes all:true
 * and expects an array - Pitfall 5).
 */
export function createLookup(resolve: AddressResolver): LookupFunction {
  const lookup = (
    hostname: string,
    options: dns.LookupOptions | number | undefined,
    cb: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void,
  ): void => {
    const opts = typeof options === 'object' && options !== null ? options : {};
    void resolve(hostname).then(
      (addrs) => {
        const bad = addrs.find((a) => !isPublicAddress(a.address));
        if (bad) {
          cb(new SsrfRefusedError(`${hostname} resolves to non-public address ${bad.address}`));
          return;
        }
        const wanted = opts.family === 4 || opts.family === 6 ? addrs.filter((a) => a.family === opts.family) : addrs;
        const list = wanted.length > 0 ? wanted : addrs;
        if (opts.all) {
          cb(null, list.map((a) => ({ address: a.address, family: a.family })));
        } else {
          const first = list[0] as ResolvedAddress;
          cb(null, first.address, first.family);
        }
      },
      (err: NodeJS.ErrnoException) => cb(err),
    );
  };
  return lookup as unknown as LookupFunction;
}
