import path from 'node:path';
import { buildGeo } from '../geo/build';
import { REPO_ROOT } from '../paths';
import type { CommandSpec } from './types';

export const geoBuildCommand: CommandSpec = {
  name: 'geo build',
  description: 'Build data/geo/pilot-areas.json and pilot-zcta.geojson from the free Census files',
  options: [
    { flags: '--input-dir <dir>', description: 'use already-downloaded Census files from this folder instead of downloading' },
    { flags: '--out-dir <dir>', description: 'where to write the geo data files (default: data/geo in the repo)' },
  ],
  async run(ctx, _args, opts) {
    const inputDir = typeof opts.inputDir === 'string' ? path.resolve(opts.inputDir) : undefined;
    const outDir = typeof opts.outDir === 'string' ? path.resolve(opts.outDir) : path.join(REPO_ROOT, 'data', 'geo');
    const fetcher = await ctx.fetcher();
    const result = await buildGeo({ config: ctx.config(), fetcher, inputDir, outDir, log: ctx.out });
    for (const a of result.areas) {
      ctx.out(a.kind === 'city' ? `${a.id}: whole city, ${a.pilotZctas.length} ZIPs searched` : `${a.id}: pilot ${a.pilotZctas.join(',')}`);
    }
    ctx.out(`polygons: ${result.featureCount} ZCTAs, ${result.geojsonBytes} bytes`);
    ctx.out(`wrote ${outDir}`);
  },
};
