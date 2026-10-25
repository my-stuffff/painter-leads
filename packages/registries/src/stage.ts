import {
  isSourceEnabled,
  RobotsDisallowedError,
  SourceDisabledError,
  type RegistryMatchInput,
  type RegistryMatchResult,
  type RegistrySourceStatus,
  type SourceId,
  type Stage,
  type StageContext,
} from '@pp/core';
import { matchCslb, type SourceMatchResult } from './cslb/match';
import { matchNj } from './nj/match';
import { hasRecords, setRegistryStatus } from './records';
import type { SourceOutcome, StageOptions } from './types';

export type { SourceOutcome, StageOptions } from './types';

function one(source: SourceId, r: SourceMatchResult): SourceOutcome {
  return { statuses: { [source]: r.status }, evidenceIds: r.evidenceIds, owners: r.owners };
}

/** Runs one adapter; a switched-off source is 'disabled', a failure is 'error' (never "no owner"). */
async function guarded(
  ctx: StageContext,
  sources: SourceId[],
  run: () => Promise<SourceOutcome>,
): Promise<SourceOutcome> {
  try {
    return await run();
  } catch (e) {
    const err = e as Error;
    const status: RegistrySourceStatus = e instanceof SourceDisabledError ? 'disabled' : 'error';
    if (status === 'error') {
      ctx.log.warn(
        { sources, err: err.message, robots: e instanceof RobotsDisallowedError },
        'registry source failed',
      );
    }
    return { statuses: Object.fromEntries(sources.map((s) => [s, status])), evidenceIds: [], owners: 0 };
  }
}

async function cslbSource(ctx: StageContext, input: RegistryMatchInput, _opts: StageOptions): Promise<SourceOutcome> {
  if (!isSourceEnabled(ctx.config, 'cslb')) return { statuses: { cslb: 'disabled' }, evidenceIds: [], owners: 0 };
  if (!(await hasRecords(ctx.db, 'cslb_master'))) {
    ctx.log.warn({ companyId: input.company.companyId }, 'CSLB master not loaded');
    await setRegistryStatus(ctx.db, input.company.companyId, { cslb: 'error', cslb_error: 'CSLB master not loaded' });
    return { statuses: { cslb: 'error' }, evidenceIds: [], owners: 0 };
  }
  return one('cslb', await matchCslb({ db: ctx.db, store: ctx.evidence, now: ctx.now }, input.company));
}

export type SourceAdapter = (ctx: StageContext, input: RegistryMatchInput, opts: StageOptions) => Promise<SourceOutcome>;

/** Which adapters run for a state (each one honours its own source switch). */
export function adaptersFor(state: RegistryMatchInput['company']['state']): { sources: SourceId[]; run: SourceAdapter }[] {
  const out: { sources: SourceId[]; run: SourceAdapter }[] = [];
  if (state === 'CA') out.push({ sources: ['cslb'], run: cslbSource });
  if (state === 'NJ') out.push({ sources: ['nj_hic_roster', 'nj_hic_detail', 'nj_principal_search'], run: matchNj });
  return out;
}

export function createRegistriesStage(opts: StageOptions = {}): Stage<RegistryMatchInput, RegistryMatchResult> {
  return {
    name: 'registries-match',
    async run(ctx, input) {
      const status: RegistryMatchResult['status'] = {};
      const evidenceIds: number[] = [];
      let owners = 0;
      for (const adapter of adaptersFor(input.company.state)) {
        if (opts.only && !adapter.sources.some((s) => opts.only?.has(s))) continue;
        const r = await guarded(ctx, adapter.sources, () => adapter.run(ctx, input, opts));
        Object.assign(status, r.statuses);
        evidenceIds.push(...r.evidenceIds);
        owners += r.owners;
      }
      return { companyId: input.company.companyId, status, owners, evidenceIds: [...new Set(evidenceIds)] };
    },
  };
}

export const registriesMatchStage = createRegistriesStage();
