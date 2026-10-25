import { describe, expect, it } from 'vitest';
import { commands, packageModule, replayers, stages } from '../src/index';

describe('@pp/pipeline skeleton', () => {
  it('exports an empty, wired package module', () => {
    expect(packageModule.name).toBe('pipeline');
    expect(packageModule.commands).toBe(commands);
    expect(commands).toEqual([]);
    expect(stages).toEqual({});
    expect(replayers).toEqual({});
  });
});
