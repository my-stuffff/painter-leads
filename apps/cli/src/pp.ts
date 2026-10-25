import { packageModule as core } from '@pp/core';
import { packageModule as maps } from '@pp/maps';
import { packageModule as pipeline } from '@pp/pipeline';
import { packageModule as registries } from '@pp/registries';
import { packageModule as sites } from '@pp/sites';
import { buildProgram } from './program';

const modules = [core, maps, registries, sites, pipeline];

async function main(): Promise<void> {
  const handle = buildProgram(modules);
  try {
    await handle.program.parseAsync(process.argv);
  } catch (e) {
    const err = e as Error & { code?: string; exitCode?: number };
    if (err.code?.startsWith('commander.')) {
      process.exitCode = err.exitCode ?? 1;
    } else {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    }
  } finally {
    await handle.close();
  }
}

await main();
