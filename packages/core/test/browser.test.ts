import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchBrowser, LiveBrowserForbiddenError } from '../src/browser/launch';
import { chromeMajorVersion, desktopUserAgent } from '../src/browser/ua';
import { loadConfig } from '../src/config/load';

describe('browser launcher (no browser is launched in tests)', () => {
  it('launchBrowser throws LiveBrowserForbiddenError unless PP_LIVE is 1', async () => {
    expect(process.env.PP_LIVE).toBeUndefined();
    await expect(launchBrowser({ purpose: 'render', config: loadConfig() })).rejects.toBeInstanceOf(LiveBrowserForbiddenError);
  });

  it('refuses any PP_LIVE value other than "1"', async () => {
    process.env.PP_LIVE = 'true';
    try {
      await expect(launchBrowser({ purpose: 'maps', config: loadConfig() })).rejects.toBeInstanceOf(LiveBrowserForbiddenError);
    } finally {
      delete process.env.PP_LIVE;
    }
  });

  it('desktopUserAgent carries Chrome/<major>.0.0.0 with the major from playwright-core browsers.json', () => {
    const require = createRequire(import.meta.url);
    const dir = path.dirname(require.resolve('playwright-core/package.json'));
    const json = JSON.parse(readFileSync(path.join(dir, 'browsers.json'), 'utf8')) as {
      browsers: { name: string; browserVersion: string }[];
    };
    const major = Number(json.browsers.find((b) => b.name === 'chromium')!.browserVersion.split('.')[0]);
    expect(chromeMajorVersion()).toBe(major);
    expect(desktopUserAgent()).toContain(`Chrome/${major}.0.0.0`);
    expect(desktopUserAgent()).toContain('Windows NT 10.0');
  });
});
