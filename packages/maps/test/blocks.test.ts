import { describe, expect, it } from 'vitest';
import { detectBlock, isBlockSignal } from '../src/blocks';
import { FixtureDriver } from '../src/driver/fixture';
import type { FixturePage, PageSignals } from '../src/driver/types';
import { fakeCard, readFixture, searchPage } from './helpers';

async function signalsOf(page: FixturePage): Promise<{ signals: PageSignals; status: number | null }> {
  const d = new FixtureDriver([page]);
  const opened = await d.open('https://www.google.com/maps/search/x/');
  return { signals: await d.pageSignals(), status: opened.status };
}

describe('detectBlock', () => {
  it('synthetic-sorry -> sorry', async () => {
    const { signals, status } = await signalsOf(readFixture<FixturePage>('synthetic-sorry.json'));
    expect(signals.landedUrl).toContain('/sorry/');
    expect(detectBlock(signals, status)).toBe('sorry');
  });

  it('synthetic-captcha -> captcha', async () => {
    const { signals, status } = await signalsOf(readFixture<FixturePage>('synthetic-captcha.json'));
    expect(detectBlock(signals, status)).toBe('captcha');
  });

  it('synthetic-unusual-traffic (no feed, no place panel) -> unusual_traffic', async () => {
    const { signals, status } = await signalsOf(readFixture<FixturePage>('synthetic-unusual-traffic.json'));
    expect(signals.hasFeed).toBe(false);
    expect(signals.hasPlacePanel).toBe(false);
    expect(detectBlock(signals, status)).toBe('unusual_traffic');
  });

  it('checks in order: a /sorry/ URL wins over a captcha', async () => {
    const { signals } = await signalsOf({
      kind: 'other',
      landedUrl: 'https://www.google.com/sorry/index',
      signals: { hasRecaptcha: true, bodyHasUnusualTraffic: true },
    });
    expect(detectBlock(signals)).toBe('sorry');
  });

  it('a normal results page or place page that mentions "unusual traffic" is never a block', async () => {
    const results = await signalsOf(searchPage([fakeCard(1)], { signals: { bodyHasUnusualTraffic: true } }));
    expect(detectBlock(results.signals, results.status)).toBeNull();
    const placePage = await signalsOf({
      kind: 'place',
      place: readFixture<Extract<FixturePage, { kind: 'place' }>>('smoke-place-1.json').place,
      signals: { bodyHasUnusualTraffic: true },
    });
    expect(detectBlock(placePage.signals, placePage.status)).toBeNull();
  });

  it('a 403 or 429 navigation is a block; other statuses are not', async () => {
    const { signals } = await signalsOf(searchPage([fakeCard(1)]));
    expect(detectBlock(signals, 403)).toBe('http_403');
    expect(detectBlock(signals, 429)).toBe('http_403');
    expect(detectBlock(signals, 200)).toBeNull();
    expect(detectBlock(signals, null)).toBeNull();
  });

  it('the daily cap is a clean stop, not a block', () => {
    expect(isBlockSignal('daily_cap')).toBe(false);
    expect(isBlockSignal('sorry')).toBe(true);
    expect(isBlockSignal('limited_view_streak')).toBe(true);
  });
});
