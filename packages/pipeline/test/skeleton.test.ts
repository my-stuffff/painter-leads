import { describe, expect, it } from 'vitest';
import { commands, packageModule, replayers, stages } from '../src/index';

describe('@pp/pipeline package module', () => {
  it('is wired as the pipeline package with its own stages and commands', () => {
    expect(packageModule.name).toBe('pipeline');
    expect(packageModule.commands).toBe(commands);
    expect(Object.keys(stages).sort()).toEqual(['merge', 'qualify', 'report']);
  });

  it('registers each command once, under the names the operator types', () => {
    const names = commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of [
      'pilot plan',
      'pilot run',
      'pilot resume',
      'pilot report',
      'pilot reprocess',
      'pilot latest-run',
      'pilot yields',
      'report verify',
      'fillrates',
      'accuracy sample',
      'accuracy compare',
      'accuracy adjudication-sheet',
      'accuracy golden-export',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('exports replayers as an object (filled in by the golden harness)', () => {
    expect(typeof replayers).toBe('object');
  });
});
