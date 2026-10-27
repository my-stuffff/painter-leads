import { describe, expect, it } from 'vitest';
import { commands, packageModule, replayers, stages } from '../src/index';

describe('@pp/maps package module', () => {
  it('registers the discover and detail stages, the card replayer and the six commands', () => {
    expect(packageModule.name).toBe('maps');
    expect(packageModule.commands).toBe(commands);
    expect(packageModule.stages).toBe(stages);
    expect(packageModule.replayers).toBe(replayers);
    expect(Object.keys(stages).sort()).toEqual(['detail', 'discover']);
    expect(stages.discover?.name).toBe('discover');
    expect(stages.detail?.name).toBe('detail');
    expect(typeof replayers.mapsCard).toBe('function');
    expect(commands.map((c) => c.name).sort()).toEqual([
      'maps datacentre-test',
      'maps detail',
      'maps discover',
      'maps smoke',
      'maps status',
      'probe maps-rate',
    ]);
  });
});
