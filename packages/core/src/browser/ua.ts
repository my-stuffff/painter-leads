import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

interface BrowsersJson {
  browsers: { name: string; browserVersion?: string }[];
}

let cachedVersion: string | null = null;

/** Full Chromium version of the pinned playwright-core (e.g. 153.0.8010.12), from its browsers.json. */
export function chromiumBrowserVersion(): string {
  if (cachedVersion) return cachedVersion;
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('playwright-core/package.json');
  const file = path.join(path.dirname(pkgJson), 'browsers.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as BrowsersJson;
  const version = parsed.browsers.find((b) => b.name === 'chromium')?.browserVersion;
  if (!version) throw new Error(`chromium browserVersion not found in ${file}`);
  cachedVersion = version;
  return version;
}

export function chromeMajorVersion(): number {
  return Number.parseInt(chromiumBrowserVersion().split('.')[0] as string, 10);
}

/** Windows desktop Chrome UA whose version matches the real binary (never a different version). */
export function desktopUserAgent(): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajorVersion()}.0.0.0 Safari/537.36`;
}
