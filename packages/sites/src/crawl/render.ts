import { launchBrowser, type Fetcher, type LaunchedBrowser, type PpConfig } from '@pp/core';

export const RENDER_TIMEOUT_MS = 20_000;

/**
 * A lazily launched Chromium for one site: opened on the first render, closed once at the end.
 * launchBrowser refuses unless PP_LIVE=1, so tests and offline runs can never start a browser.
 */
export interface Renderer {
  render(url: string): Promise<string>;
  close(): Promise<void>;
}

export function createRenderer(deps: { fetcher: Fetcher; config: PpConfig }): Renderer {
  let launched: LaunchedBrowser | null = null;
  const publicHosts = new Set<string>();

  async function open(): Promise<LaunchedBrowser> {
    if (launched) return launched;
    const b = await launchBrowser({ purpose: 'render', config: deps.config });
    // Subresource requests are checked too: a hostile page must not make Chromium reach private hosts.
    await b.context.route('**/*', async (route) => {
      const req = route.request();
      const type = req.resourceType();
      if (type === 'media' || type === 'font' || type === 'image') {
        await route.abort();
        return;
      }
      try {
        const host = new URL(req.url()).host;
        if (!publicHosts.has(host)) {
          await deps.fetcher.assertPublicUrl(req.url());
          publicHosts.add(host);
        }
      } catch {
        await route.abort();
        return;
      }
      await route.continue();
    });
    launched = b;
    return b;
  }

  return {
    async render(url) {
      await deps.fetcher.assertPublicUrl(url);
      const b = await open();
      const page = await b.context.newPage();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT_MS });
        return await page.content();
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async close() {
      if (launched) await launched.close().catch(() => undefined);
      launched = null;
    },
  };
}
