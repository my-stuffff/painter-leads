import path from 'node:path';
import { buildGeo } from '../geo/build';
import { REPO_ROOT } from '../paths';
import type { CommandSpec } from './types';

export const geoBuildCommand: CommandSpec = {
  name: 'geo build',
  description: 'Build data/geo/pilot-areas.json, pilot-zcta.geojson and catalog.json (cities >= 50,000) from the free Census files',
  options: [
    { flags: '--input-dir <dir>', description: 'use already-downloaded Census files from this folder instead of downloading' },
    { flags: '--out-dir <dir>', description: 'where to write the geo data files (default: data/geo in the repo)' },
  ],
  async run(ctx, _args, opts) {
    const inputDir = typeof opts.inputDir === 'string' ? path.resolve(opts.inputDir) : undefined;
    const outDir = typeof opts.outDir === 'string' ? path.resolve(opts.outDir) : path.join(REPO_ROOT, 'data', 'geo');
    const fetcher = await ctx.fetcher();
    const result = await buildGeo({ config: ctx.config(), fetcher, inputDir, outDir, log: ctx.out });
    const added = new Set(result.newAreaIds);
    for (const a of result.areas.filter((x) => !added.has(x.id))) {
      ctx.out(a.kind === 'city' ? `${a.id}: whole city, ${a.pilotZctas.length} ZIPs searched` : `${a.id}: pilot ${a.pilotZctas.join(',')}`);
    }
    const cities = result.catalog.cities;
    const perState = [...new Set(cities.map((c) => c.state))].map((s) => `${s} ${cities.filter((c) => c.state === s).length}`);
    const fallback = result.areas.filter((a) => a.zctaRule === 'city-land').length;
    ctx.out(`catalog: ${cities.length} cities (${perState.join(', ')}); ${added.size} new whole-city areas (${fallback} by the city-land rule)`);
    ctx.out(`polygons: ${result.featureCount} ZCTAs, ${result.geojsonBytes} bytes`);
    ctx.out(`wrote ${outDir}`);
  },
};
