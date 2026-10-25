import { SOURCE_IDS } from '../types';
import type { CommandSpec } from './types';

export const configCheckCommand: CommandSpec = {
  name: 'config check',
  description: 'Validate pp.config.json and print the effective thresholds and source switches',
  async run(ctx) {
    const c = ctx.config();
    const q = c.qualification;
    ctx.out(`minRating: ${q.minRating}`);
    ctx.out(`reviews: ${q.minReviews}–${q.maxReviews} (minReviews ${q.minReviews}, maxReviews ${q.maxReviews})`);
    ctx.out(`requireGoogleProfile: ${q.requireGoogleProfile}`);
    ctx.out(`requireResidentialOnly: ${q.requireResidentialOnly}`);
    ctx.out(`terms: ${c.search.terms.join(' | ')}`);
    for (const id of SOURCE_IDS) {
      const s = c.sources[id];
      ctx.out(`${id}: ${s.enabled ? 'on' : 'off'} (every ${s.minIntervalMs} ms, robots ${s.robots})`);
    }
  },
};
