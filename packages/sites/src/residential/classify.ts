import type { ResidentialDecision, ResidentialSignal, SiteStatus } from '@pp/core';
import type { SignalHit } from './signals';
import { MIN_VISIBLE_CHARS, NJ_HIC_SIGNAL_ID, NJ_HIC_SOURCE_URL } from './tables';

export interface ClassifyParams {
  /** Every hit, including negated ones (those are ignored). */
  signals: SignalHit[];
  siteStatus: SiteStatus | null;
  /** Pages with readable text. */
  pagesCrawled: number;
  visibleChars: number;
  hasServiceContent: boolean;
  /** Active NJ home-improvement registration: supporting evidence only. */
  njHicActive: boolean | null;
}

const strip = (h: SignalHit): ResidentialSignal => ({
  polarity: h.polarity,
  id: h.id,
  text: h.text,
  sourceType: h.sourceType,
  sourceUrl: h.sourceUrl,
  snippet: h.snippet,
  strength: h.strength,
});

const ids = (list: ResidentialSignal[]): string => [...new Set(list.map((s) => s.id))].join(', ');

/**
 * D-04 / D-25 / R5: one of residential_only / residential_and_commercial / commercial_only /
 * unclear, with the deciding signals. residential_only is the only qualifying label, so anything
 * undecidable is unclear:
 * - a strong, non-negated commercial signal -> also commercial (or commercial only without any residential signal);
 * - residential_only needs >= 2 distinct strong residential signals, no commercial signal of any
 *   strength, a successful crawl of >= 2 pages with services content and enough text;
 * - an active NJ HIC registration is a weak residential signal and never decides by itself.
 */
export function classifyResidential(p: ClassifyParams): ResidentialDecision {
  const live: SignalHit[] = p.signals.filter((h) => !h.negated);
  const negated = p.signals.filter((h) => h.negated);
  if (p.njHicActive === true) {
    live.push({
      polarity: 'residential',
      id: NJ_HIC_SIGNAL_ID,
      text: 'Active NJ home-improvement contractor registration',
      sourceType: 'nj_hic_roster',
      sourceUrl: NJ_HIC_SOURCE_URL,
      snippet: 'Active NJ home-improvement contractor registration (supporting evidence only)',
      strength: 'weak',
      negated: false,
      position: -1,
    });
  }

  const commercial = live.filter((h) => h.polarity === 'commercial');
  const commercialStrong = commercial.filter((h) => h.strength === 'strong').map(strip);
  const commercialWeak = commercial.filter((h) => h.strength === 'weak').map(strip);
  const residential = live.filter((h) => h.polarity === 'residential').map(strip);
  const residentialStrongIds = new Set(residential.filter((s) => s.strength === 'strong').map((s) => s.id));
  const deciding = (...lists: ResidentialSignal[][]): ResidentialSignal[] => [
    ...lists.flat(),
    ...live.filter((h) => h.polarity === 'negation').map(strip),
  ];
  const note = negated.length > 0 ? `; ${negated.length} commercial mention(s) negated (${ids(negated.map(strip))})` : '';

  if (commercialStrong.length > 0) {
    if (residential.length > 0) {
      return {
        label: 'residential_and_commercial',
        signals: deciding(commercialStrong, residential),
        reason: `commercial signals (${ids(commercialStrong)}) and residential signals (${ids(residential)})${note}`,
      };
    }
    return { label: 'commercial_only', signals: deciding(commercialStrong), reason: `commercial signals (${ids(commercialStrong)}), no residential signal${note}` };
  }

  const crawlOk = p.siteStatus === 'ok' && p.pagesCrawled >= 1 && p.visibleChars >= MIN_VISIBLE_CHARS;
  if (!crawlOk) {
    return { label: 'unclear', signals: deciding(residential, commercialWeak), reason: 'insufficient evidence' };
  }
  if (commercialWeak.length > 0) {
    return {
      label: 'unclear',
      signals: deciding(commercialWeak, residential),
      reason: 'commercial mentioned only in footer',
    };
  }
  if (residentialStrongIds.size >= 2 && p.pagesCrawled >= 2 && p.hasServiceContent) {
    return {
      label: 'residential_only',
      signals: deciding(residential),
      reason: `${residentialStrongIds.size} residential signals (${ids(residential)}), no commercial signal on ${p.pagesCrawled} pages${note}`,
    };
  }
  const why =
    residentialStrongIds.size < 2
      ? 'fewer than two residential signals'
      : p.pagesCrawled < 2
        ? 'fewer than two pages crawled'
        : 'no services page found';
  return { label: 'unclear', signals: deciding(residential), reason: why };
}
