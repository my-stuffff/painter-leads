import { describe, expect, it } from 'vitest';
import type { PackageModule } from '@pp/core';
import { buildProgram, collectCommands } from '../src/program';

const mod = (name: PackageModule['name'], commandNames: string[]): PackageModule => ({
  name,
  stages: {},
  replayers: {},
  commands: commandNames.map((n) => ({ name: n, description: n, run: async () => {} })),
});

describe('pp CLI', () => {
  it('throws at startup naming both packages when a full command name is registered twice', () => {
    expect(() => collectCommands([mod('core', ['doctor']), mod('maps', ['doctor'])])).toThrow(
      /"doctor".*"core".*"maps"/,
    );
  });

  it('registers nested subcommands and runs them with args, options and exit codes', async () => {
    const seen: unknown[] = [];
    const m: PackageModule = {
      name: 'maps',
      stages: {},
      replayers: {},
      commands: [
        {
          name: 'maps discover',
          description: 'discover',
          args: [{ name: 'area', required: true, description: 'area id' }],
          options: [{ flags: '--limit <n>', description: 'limit' }],
          run: async (_ctx, args, opts) => {
            seen.push(args, opts);
            return 3;
          },
        },
      ],
    };
    const prev = process.exitCode;
    const handle = buildProgram([m]);
    await handle.program.parseAsync(['node', 'pp', 'maps', 'discover', 'edison_nj', '--limit', '5']);
    expect(seen).toEqual([['edison_nj'], { limit: '5' }]);
    expect(process.exitCode).toBe(3);
    process.exitCode = prev;
    await handle.close();
  });
});
