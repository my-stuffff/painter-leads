import { Agent, getGlobalDispatcher, type Dispatcher } from 'undici';
import type { PpConfig } from '../config/schema';
import { addressResolverFor, createLookup, type AddressResolver } from './dns';

const agents = new Map<string, Agent>();

/**
 * One undici Agent per host. Its connect-time lookup resolves through the configured per-host
 * DNS override (e.g. *.texas.gov via 1.1.1.1 / 8.8.8.8) and refuses non-public addresses.
 * Under PP_NETWORK_GUARD=1 (tests) the global dispatcher - the guard's MockAgent - is used instead.
 */
export function getDispatcher(
  host: string,
  config: PpConfig,
  opts: { injected?: Dispatcher; resolver?: AddressResolver } = {},
): Dispatcher {
  if (opts.injected) return opts.injected;
  if (process.env.PP_NETWORK_GUARD === '1') return getGlobalDispatcher();

  const key = host.toLowerCase();
  let agent = agents.get(key);
  if (!agent) {
    const resolver = opts.resolver ?? addressResolverFor(key, config);
    agent = new Agent({
      connect: { lookup: createLookup(resolver) },
      keepAliveTimeout: 1000,
      keepAliveMaxTimeout: 5000,
    });
    agents.set(key, agent);
  }
  return agent;
}

export async function closeDispatchers(): Promise<void> {
  const all = [...agents.values()];
  agents.clear();
  await Promise.all(all.map((a) => a.close()));
}
