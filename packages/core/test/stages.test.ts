import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load';
import { MemoryEvidenceStore } from '../src/evidence/store';
import { createLogger } from '../src/log';
import { createFakeStages } from '../src/stages/fakes';
import type { StageContext } from '../src/stages/types';

function makeCtx(): StageContext {
  return {
    runId: 1,
    config: loadConfig(),
    db: undefined as never,
    evidence: new MemoryEvidenceStore(),
    fetcher: undefined as never,
    log: createLogger('test'),
    now: () => new Date('2026-01-01T00:00:00Z'),
    sleep: async () => {},
  };
}

describe('fake stage chain', () => {
  it('runs discover → detail → merge → qualify with the in-memory evidence store', async () => {
    const stages = createFakeStages();
    const ctx = makeCtx();

    const discovered = await stages.discover.run(ctx, { runId: 1 });
    expect(discovered).toMatchObject({ newListings: 2, stopped: null });

    expect(await stages.detail.run(ctx, { runId: 1 })).toMatchObject({ done: 2, failed: 0 });
    expect((await stages.merge.run(ctx, { runId: 1 })).companies).toBe(2);

    expect(await stages.qualify.run(ctx, { companyId: 1 })).toEqual({ qualified: true, reasons: [] });
    expect(await stages.qualify.run(ctx, { companyId: 2 })).toEqual({
      qualified: false,
      reasons: ['rating below minimum'],
    });
  });

  it('every stage in the registry has its own name', () => {
    const stages = createFakeStages();
    for (const [key, stage] of Object.entries(stages)) expect(stage.name).toBe(key);
  });

  it('is deterministic across fresh registries', async () => {
    const a = createFakeStages();
    const b = createFakeStages();
    expect(await a.discover.run(makeCtx(), { runId: 1 })).toEqual(await b.discover.run(makeCtx(), { runId: 1 }));
  });
});
