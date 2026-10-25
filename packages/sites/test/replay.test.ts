import { describe, expect, it } from 'vitest';
import { commands, packageModule, replayers, stages } from '../src/index';
import { loadSite } from './helpers';

const golden = (n: Parameters<typeof loadSite>[0]) => loadSite(n).pages.map((p) => ({ url: p.url, html: p.html, rendered: p.rendered }));

describe('golden replayers', () => {
  it('emails: accepted addresses of saved pages', () => {
    expect(replayers.emails!(golden('johnspaint'), { websiteUrl: 'https://www.johnspaint.com' })).toEqual(['johnspaint@hotmail.com']);
    expect(replayers.emails!(golden('njpaintingco'), { websiteUrl: 'https://njpaintingco.com' })).toEqual(['info@njpaintingco.com']);
    expect(replayers.emails!(golden('rutgerspainting'), { websiteUrl: 'https://rutgerspainting.com' })).toEqual([]);
  });

  it('owners: accepted names with title and confidence; filler pages give none', () => {
    const site = { websiteUrl: 'https://bartonspringspainting.com', companyName: 'Barton Springs Painting', city: 'Austin' };
    expect(replayers.owners!(golden('bartonspringspainting'), site)).toEqual([
      { name: 'Jeff London', title: 'Founder', confidence: 'medium' },
      { name: 'Breanna Rene', title: 'Owner', confidence: 'medium' },
    ]);
    expect(replayers.owners!(golden('rutgerspainting'), { websiteUrl: 'https://rutgerspainting.com', companyName: 'Rutgers Painting', city: 'Edison' })).toEqual([]);
  });

  it('residential: the same classifier on saved pages, plus categories and name', () => {
    const d = replayers.residential!({ pages: golden('rutgerspainting'), categories: ['House painter'], name: 'Rutgers Painting', njHicActive: true });
    expect(d.label).toBe('residential_only');
    expect(d.signals.some((s) => s.sourceType === 'google_maps')).toBe(true);
    expect(d.signals.some((s) => s.id === 'res:nj-hic-active')).toBe(true);
    expect(replayers.residential!({ pages: [], categories: [], name: 'X', njHicActive: null })).toMatchObject({ label: 'unclear', reason: 'insufficient evidence' });
  });
});

describe('package module wiring', () => {
  it('registers the stages, replayers and commands', () => {
    expect(packageModule.name).toBe('sites');
    expect(Object.keys(stages).sort()).toEqual(['classify', 'site-enrich', 'site-finalize']);
    expect(stages['site-enrich']!.name).toBe('site-enrich');
    expect(stages['site-finalize']!.name).toBe('site-finalize');
    expect(stages.classify!.name).toBe('classify');
    expect(Object.keys(replayers).sort()).toEqual(['emails', 'owners', 'residential']);
    expect(packageModule.commands).toBe(commands);
    expect(commands.map((c) => c.name).sort()).toEqual(['sites classify', 'sites crawl', 'sites enrich', 'sites names build']);
  });
});
