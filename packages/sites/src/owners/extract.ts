import { visibleText, type VisibleText } from '../crawl/visible-text';
import { isFillerPage } from '../filler';
import { jsonLdPeople } from './jsonld';
import { loadFirstNames } from './names';
import { ownerCandidates } from './patterns';
import { REJECT_NAME, validateFirstNameOnly, validateOwnerName, type OwnerNameContext } from './validate';
import { personNameKey } from '@pp/core';

export type OwnerMethod = 'sentence' | 'teamcard' | 'jsonld' | 'reviewer';

export interface OwnerPage {
  url: string;
  html: string;
  rendered: boolean;
  sha256?: string | null;
  visible?: VisibleText;
}

export interface OwnerSite {
  companyName: string;
  city: string | null;
  cities?: readonly string[];
  /** config.confidence.websiteOwner (default medium). */
  confidence?: 'medium' | 'low';
  firstNames?: Set<string>;
}

export interface OwnerFinding {
  name: string;
  title: string | null;
  method: OwnerMethod;
  confidence: 'medium' | 'low';
  status: 'accepted' | 'rejected' | 'needs_review';
  rejectReason: string | null;
  pageUrl: string;
  pageSha256: string | null;
  rendered: boolean;
  snippet: string;
}

const METHOD_RANK: Record<OwnerMethod, number> = { jsonld: 0, sentence: 1, teamcard: 2, reviewer: 3 };

/**
 * ENR-02 / D-18: owner names from explicit statements only (a sentence, a team card or schema.org
 * JSON-LD ties the person to this company as owner / founder / president ...). A filler page yields
 * no names at all (they are kept as rejected rows for the audit). One finding per (person, page).
 */
export function extractOwners(pages: OwnerPage[], site: OwnerSite): OwnerFinding[] {
  const ctx: OwnerNameContext = {
    companyName: site.companyName,
    city: site.city,
    cities: site.cities,
    firstNames: site.firstNames ?? loadFirstNames(),
  };
  const statementConfidence = site.confidence ?? 'medium';
  const out: OwnerFinding[] = [];

  for (const page of pages) {
    const visible = page.visible ?? visibleText(page.html);
    const filler = isFillerPage({ html: page.html, visible });
    const found = new Map<string, OwnerFinding>();

    const add = (f: OwnerFinding): void => {
      const key = personNameKey(f.name) || f.name.toLowerCase();
      const prior = found.get(key);
      if (!prior) {
        found.set(key, f);
        return;
      }
      // keep the strongest evidence for the same person on the same page
      const better =
        (f.status === 'accepted' && prior.status !== 'accepted') ||
        (f.status === prior.status && METHOD_RANK[f.method] < METHOD_RANK[prior.method]);
      if (better) found.set(key, { ...f, title: f.title ?? prior.title });
      else if (!prior.title && f.title) prior.title = f.title;
    };

    const consider = (c: {
      rawName: string;
      title: string | null;
      method: OwnerMethod;
      snippet: string;
      firstNameOnly: boolean;
      weak: boolean;
      reviewer: boolean;
    }): void => {
      const base = {
        title: c.title,
        pageUrl: page.url,
        pageSha256: page.sha256 ?? null,
        rendered: page.rendered,
        snippet: c.snippet.slice(0, 1000),
      };
      if (filler.filler) {
        add({ ...base, name: c.rawName.trim(), method: c.method, confidence: 'low', status: 'rejected', rejectReason: `filler page (${filler.reasons.join(', ')})` });
        return;
      }
      const verdict = c.firstNameOnly ? validateFirstNameOnly(c.rawName, ctx) : validateOwnerName(c.rawName, ctx);
      if (!verdict.ok) {
        // "Meet the owner": nothing left after dropping filler words - not a person at all, not worth a row
        if (c.firstNameOnly && verdict.reason === REJECT_NAME.words) return;
        add({ ...base, name: c.rawName.trim(), method: c.method, confidence: 'low', status: 'rejected', rejectReason: verdict.reason });
        return;
      }
      if (c.reviewer || c.weak || verdict.last === null) {
        add({ ...base, name: verdict.name, method: 'reviewer', confidence: 'low', status: 'needs_review', rejectReason: c.reviewer ? 'reviewer mention' : c.weak ? 'reviewer-style mention' : 'first name only' });
        return;
      }
      add({ ...base, name: verdict.name, method: c.method, confidence: statementConfidence, status: 'accepted', rejectReason: null });
    };

    for (const c of ownerCandidates(visible)) {
      consider({ ...c, reviewer: c.inReview });
    }
    for (const p of jsonLdPeople(page.html)) {
      consider({ rawName: p.name, title: p.title, method: 'jsonld', snippet: p.snippet, firstNameOnly: !/\s/.test(p.name.trim()), weak: false, reviewer: false });
    }
    out.push(...found.values());
  }
  return out;
}

export function acceptedOwners(findings: OwnerFinding[]): OwnerFinding[] {
  return findings.filter((f) => f.status === 'accepted');
}
