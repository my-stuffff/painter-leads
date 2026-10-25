import { describe, expect, it } from 'vitest';
import { commands, packageModule, replayers, stages } from '../src/index';

describe('@pp/registries package module', () => {
  it('is wired: commands, the registries-match stage and the golden replayer', () => {
    expect(packageModule.name).toBe('registries');
    expect(packageModule.commands).toBe(commands);
    expect(packageModule.stages).toBe(stages);
    expect(packageModule.replayers).toBe(replayers);
    expect(Object.keys(stages)).toEqual(['registries-match']);
    expect(stages['registries-match']?.name).toBe('registries-match');
  });

  it('registers each command name once', () => {
    const names = commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['registries cslb download', 'registries cslb load', 'registries match']));
  });
});
