import type { StageRegistry } from '@pp/core';
import { resolveStages } from '@pp/pipeline';

/** Fake stages whose first discover call stops on a block (the pipeline's own blockAfterSearches option). */
export function createDbFakeStagesForTest(): StageRegistry {
  return resolveStages({ fake: true, fakeOptions: { blockAfterSearches: 1 } });
}
