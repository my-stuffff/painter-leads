import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '@pp/core';
import { formatDiff, goldenFieldKeys, loadGoldenCases, replayField } from '../src/accuracy/golden-replay';
import { allReplayers } from '../src/stages';

/**
 * CI golden replay (ACC-02, D-32): every hand-checked company in fixtures/golden is replayed through the real
 * extractors, classifier and matcher of maps / sites / registries. Cases and fields are visited in sorted order and
 * the test names carry state/slug/field. A replayer that is not provided fails loudly (replayField throws).
 */
const cases = loadGoldenCases(path.join(REPO_ROOT, 'fixtures', 'golden'));
const replayers = allReplayers();

if (cases.length === 0) {
  describe('golden set', () => {
    it.skip('golden set is populated in 01-06', () => {});
  });
} else {
  for (const c of cases) {
    describe(`${c.state}/${c.slug}`, () => {
      for (const field of goldenFieldKeys(c)) {
        it(`${c.state}/${c.slug}/${field}`, () => {
          const diff = replayField(c, field, replayers);
          expect(diff ? formatDiff(diff) : null).toBeNull();
        });
      }
    });
  }
}
