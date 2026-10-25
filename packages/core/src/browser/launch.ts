import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { PpConfig } from '../config/schema';
import { createLogger } from '../log';
import { desktopUserAgent } from './ua';

export class LiveBrowserForbiddenError extends Error {
  constructor(message = 'launching Chromium is forbidden unless PP_LIVE=1') {
    super(message);
    this.name = 'LiveBrowserForbiddenError';
  }
}

export interface LaunchedBrowser {
  browser: Browser;
  context: BrowserContext;
  userAgent: string;
  close(): Promise<void>;
}

/**
 * The one shared Chromium launcher (maps + site rendering). Refuses unless PP_LIVE=1, so tests and
 * CI can never start a browser. en-US, UA derived from the real binary, downloads off, service
 * workers blocked, no extensions.
 */
export async function launchBrowser(o: {
  purpose: 'maps' | 'render';
  config: PpConfig;
  headless?: boolean;
}): Promise<LaunchedBrowser> {
  if (process.env.PP_LIVE !== '1') throw new LiveBrowserForbiddenError();
  const log = createLogger('browser');
  const executablePath = chromium.executablePath();
  log.info({ purpose: o.purpose, executablePath }, 'launching chromium');

  const userAgent = desktopUserAgent();
  const browser = await chromium.launch({
    headless: o.headless ?? o.config.maps.headless,
    executablePath,
    args: ['--disable-extensions'],
  });
  const context = await browser.newContext({
    locale: o.config.maps.locale,
    timezoneId: o.config.maps.timezoneId,
    userAgent,
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  return {
    browser,
    context,
    userAgent,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
