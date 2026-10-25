import { makeSnippet } from '@pp/core';
import type { VisibleText } from '../crawl/visible-text';

/** A person tied to the company by an owner statement (before name validation). */
export interface OwnerCandidate {
  rawName: string;
  title: string | null;
  method: 'sentence' | 'teamcard';
  snippet: string;
  /** The statement sits inside a review / testimonial element. */
  inReview: boolean;
  /** A lone first name ("Hi, I'm Mike - owner"): low confidence only. */
  firstNameOnly: boolean;
  /** The reviewer-style "John the owner" form: low confidence only, whatever the element. */
  weak: boolean;
  patternId: string;
}

const UP = String.raw`\p{Lu}`;
const LO = String.raw`\p{Ll}`;
/** One capitalised word: Smith, McDonald, DeLuca, Smith-Jones, O'Brien, or an ALL-CAPS run. */
const WORD = String.raw`(?:${UP}['’]${UP}${LO}+|${UP}${LO}+(?:${UP}${LO}+)?(?:-${UP}${LO}+(?:${UP}${LO}+)?)*|${UP}{2,20})`;
const PART = String.raw`(?:de la|de|del|van|von|da|di|der|den|la|le|du)`;

const ci = (w: string): string => w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const ROLE_LIST = ['co-?founder', 'co-?owner', 'founder', 'owner', 'president', 'ceo', 'proprietor'];
const ROLE = `(?:${ROLE_LIST.map(ci).join('|')})`;
const NOT_ROLE = String.raw`(?!${ROLE}\b)(?!(?:And|Or|Of|The|Is|Was|At|In|For|With|Has|Who|Our)\b)`;

/** 2-4 tokens: capitalised words, an optional middle initial, optional lower-case particles. */
const NAME = String.raw`${WORD}(?:\s+${NOT_ROLE}(?:${UP}\.|${PART}\s+${WORD}|${WORD})){1,3}`;
const NAME_OR_FIRST = String.raw`(?:${NAME}|${WORD})`;
const SEP = String.raw`\s*[,:–—-]?\s*`;
const AND = String.raw`(?:\s+(?:and|&)\s+\w+)?`;

interface Pattern {
  id: string;
  re: RegExp;
  /** Fixed title, or null to take it from the role capture group. */
  title: string | null;
  weak?: boolean;
}

const PATTERNS: Pattern[] = [
  // "Owner: John Smith", "Our Founder, Jeff London"
  { id: 'role-name', re: new RegExp(String.raw`\b(?<role>${ROLE})${AND}${SEP}(?<name>${NAME})`, 'gu'), title: null },
  // "John Smith, Owner", "Jeff London – Founder", "John Smith (Owner)"
  { id: 'name-role', re: new RegExp(String.raw`(?<name>${NAME})\s*(?:[,–—-]|\()\s*(?:the\s+)?(?<role>${ROLE})\b`, 'gu'), title: null },
  // "Meet John Smith, owner", "I'm Mike - owner"
  {
    id: 'intro',
    re: new RegExp(
      String.raw`(?:\b[Mm]eet|\b[Ii]['’]m|\b[Ii] am|\b[Mm]y name is)\s+(?<name>${NAME_OR_FIRST})${SEP}(?:(?:the|your|an?)\s+)?(?<role>${ROLE})\b`,
      'gu',
    ),
    title: null,
  },
  // "Founded in 2009 by Maria Lopez"
  { id: 'founded-by', re: new RegExp(String.raw`\b[Ff]ounded\s+(?:in\s+\d{4}\s+)?by\s+(?<name>${NAME})`, 'gu'), title: 'Founder' },
  // "Maria Lopez founded the company", "John Smith started Acme Painting"
  {
    id: 'name-founded',
    re: new RegExp(
      String.raw`(?<name>${NAME})\s+(?:founded|started|established)\s+(?:the\s+company|the\s+business|(?:our|this)\s+company|it\b|\w+(?:\s+\w+){0,3}?\s+[Pp]ainting)`,
      'gu',
    ),
    title: 'Founder',
  },
  // "John Smith is the owner of Acme", "Maria Lopez is the owner and founder of"
  {
    id: 'is-the',
    re: new RegExp(String.raw`(?<name>${NAME})\s+(?:is|has been|was)\s+the\s+(?<role>${ROLE})${AND}(?:\s+of\b|[.,;])`, 'gu'),
    title: null,
  },
  // "Owned and operated by John Smith"
  { id: 'owned-by', re: new RegExp(String.raw`\b[Oo]wned(?:\s+and\s+operated)?\s+by\s+(?<name>${NAME})`, 'gu'), title: 'Owner' },
  // Reviewer style: "John the owner was great", "Donald, the owner"
  {
    id: 'reviewer-style',
    re: new RegExp(String.raw`(?<name>${NAME_OR_FIRST})\s*,?\s+(?:the|our)\s+(?<role>${ROLE})\b`, 'gu'),
    title: null,
    weak: true,
  },
];

export function titleFromRole(role: string): string {
  const r = role.toLowerCase().replace('-', '');
  if (r === 'cofounder') return 'Co-Founder';
  if (r === 'coowner') return 'Co-Owner';
  if (r === 'ceo') return 'CEO';
  return r.charAt(0).toUpperCase() + r.slice(1);
}

const CARD_NAME = new RegExp(String.raw`^(?:(?:[Mm]eet|[Aa]bout)\s+)?(?<name>${NAME})$`, 'u');
/** A caption that is only a role: "Owner", "Owner & Founder", "Founder / CEO", "General Manager and Owner". */
const CARD_ROLE = new RegExp(
  String.raw`^(?:[A-Za-z&/,' -]{0,25}?\s)??(?<role>${ROLE})(?:\s*(?:&|and|/|,)\s*[A-Za-z-]{2,20}){0,2}$`,
  'u',
);

/**
 * Statements that tie a person to the company as owner / founder / co-founder / president / CEO /
 * proprietor: sentence patterns over every line, plus team cards (a name line next to a role line).
 */
export function ownerCandidates(visible: VisibleText): OwnerCandidate[] {
  const out: OwnerCandidate[] = [];

  for (const line of visible.lines) {
    for (const p of PATTERNS) {
      for (const m of line.text.matchAll(p.re)) {
        const name = m.groups?.name;
        if (!name) continue;
        const role = m.groups?.role;
        out.push({
          rawName: name,
          title: p.title ?? (role ? titleFromRole(role) : null),
          method: 'sentence',
          snippet: makeSnippet(line.text, m.index, m[0].length),
          inReview: line.inReview,
          firstNameOnly: !/\s/.test(name.trim()),
          weak: p.weak === true,
          patternId: p.id,
        });
      }
    }
  }

  const lines = visible.lines;
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (!a || !b) continue;
    const forward = CARD_NAME.exec(a.text);
    const roleB = CARD_ROLE.exec(b.text);
    if (forward?.groups?.name && roleB?.groups?.role) {
      out.push({
        rawName: forward.groups.name,
        title: titleFromRole(roleB.groups.role),
        method: 'teamcard',
        snippet: `${a.text} / ${b.text}`.slice(0, 300),
        inReview: a.inReview || b.inReview,
        firstNameOnly: false,
        weak: false,
        patternId: 'card-name-role',
      });
      continue;
    }
    const roleA = CARD_ROLE.exec(a.text);
    const backward = CARD_NAME.exec(b.text);
    if (roleA?.groups?.role && backward?.groups?.name) {
      out.push({
        rawName: backward.groups.name,
        title: titleFromRole(roleA.groups.role),
        method: 'teamcard',
        snippet: `${a.text} / ${b.text}`.slice(0, 300),
        inReview: a.inReview || b.inReview,
        firstNameOnly: false,
        weak: false,
        patternId: 'card-role-name',
      });
    }
  }
  return out;
}
