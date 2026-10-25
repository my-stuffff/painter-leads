import { describe, expect, it } from 'vitest';
import { commands, packageModule, replayers, stages } from '../src/index';

describe('@pp/sites skeleton', () => {
  it('exports an empty, wired package module', () => {
    expect(packageModule.name).toBe('sites');
    expect(packageModule.commands).toBe(commands);
    expect(commands).toEqual([]);
    expect(stages).toEqual({});
    expect(replayers).toEqual({});
  });
});
