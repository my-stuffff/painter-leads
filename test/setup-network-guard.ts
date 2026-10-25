// Network guard: tests and CI never touch a live site. Everything that could leave this machine
// fails closed; Postgres on 127.0.0.1 keeps working (pg connects to IP literals / localhost).
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.PP_NETWORK_GUARD = '1';
delete process.env.PP_LIVE;

class GuardNetworkDisabledError extends Error {
  constructor(what: string) {
    super(`network access is disabled in tests (${what})`);
    this.name = 'NetworkDisabledError';
  }
}

const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

globalThis.fetch = (async () => {
  throw new GuardNetworkDisabledError('global fetch');
}) as typeof fetch;

const isIpLiteral = (host: string): boolean => /^[0-9.]+$/.test(host) || host.includes(':');

type AnyFn = (...args: unknown[]) => unknown;
const target = dns as unknown as Record<string, unknown>;
const promisesTarget = dns.promises as unknown as Record<string, unknown>;

for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'resolvePtr', 'resolveNaptr', 'resolveSoa', 'resolveCaa', 'reverse', 'lookupService']) {
  target[name] = (...args: unknown[]) => {
    const cb = args[args.length - 1];
    const err = new GuardNetworkDisabledError(`dns.${name}`);
    if (typeof cb === 'function') {
      queueMicrotask(() => (cb as AnyFn)(err));
      return;
    }
    throw err;
  };
  promisesTarget[name] = async () => {
    throw new GuardNetworkDisabledError(`dns.promises.${name}`);
  };
}

const realLookup = dns.lookup.bind(dns) as unknown as AnyFn;
target.lookup = (host: unknown, ...rest: unknown[]) => {
  if (typeof host === 'string' && (host === 'localhost' || isIpLiteral(host))) return realLookup(host, ...rest);
  const cb = rest[rest.length - 1];
  const err = new GuardNetworkDisabledError(`dns.lookup ${String(host)}`);
  if (typeof cb === 'function') {
    queueMicrotask(() => (cb as AnyFn)(err));
    return;
  }
  throw err;
};

const realPromisesLookup = dns.promises.lookup.bind(dns.promises) as unknown as AnyFn;
promisesTarget.lookup = async (host: unknown, ...rest: unknown[]) => {
  if (typeof host === 'string' && (host === 'localhost' || isIpLiteral(host))) return realPromisesLookup(host, ...rest);
  throw new GuardNetworkDisabledError(`dns.promises.lookup ${String(host)}`);
};

// Resolver instances (new dns.Resolver()) go through the prototype.
for (const Ctor of [dns.Resolver, dns.promises.Resolver]) {
  const proto = Ctor.prototype as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || !name.startsWith('resolve')) continue;
    proto[name] = (...args: unknown[]) => {
      const cb = args[args.length - 1];
      const err = new GuardNetworkDisabledError(`Resolver.${name}`);
      if (typeof cb === 'function') {
        queueMicrotask(() => (cb as AnyFn)(err));
        return;
      }
      return Promise.reject(err);
    };
  }
}

syncBuiltinESMExports();
