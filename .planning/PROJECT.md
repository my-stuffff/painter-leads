# Painter Promotions — Lead Finder

## What This Is

A system that, for a chosen US state, finds every painting contractor listed on Google Maps, keeps only the ones that
paint homes exclusively, and fills each company with its owner/decision-maker name, phone, email, website, Google rating
and number of ratings — every value traced to the public page it came from. Built for Painter Promotions (a marketing
agency selling Google Local Services Ads / Google Business Profile marketing to US residential painters) so their
Partnerships Manager can prospect without researching companies by hand. First target states: New Jersey, Texas,
California; later any state.

## Core Value

Every value in the list is correct and provable (source link + capture date) — a blank is acceptable, a wrong or guessed
value is not.

## Business Context

- **Customer**: Painter Promotions — Partnerships Manager (runs lists, cold-calls via Kixie) and Account Executive.
- **Revenue model**: client project for Painter Promotions (they sell marketing to the painters on the list).
- **Success metric**: share of residential-only painters per state with a verified owner name + email + phone, at
  ≥98% accuracy of filled values on a blind hand-check.
- **Strategy notes**: client brief + all rulings in `.planning/00-DISCUSSION.md`.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Statewide discovery of painting contractors on Google Maps by our own scraper (no outside data services)
- [ ] Per company: owner/decision-maker name, phone, email, website, Google rating, number of ratings (+ address, city,
      ZIP, category, Google profile link)
- [ ] Residential-EXCLUSIVE classification by rules (no AI), with reasons; non-painters (paint stores, art, auto body)
      removed
- [ ] Target filter: rating ≥ 4.7 and 10–99 reviews, with the reason for every exclusion
- [ ] Owner names and emails found from free public sources (company websites, state contractor/business registries,
      BBB) — never guessed; each value with source + confidence
- [ ] One record per company (de-duplicated), repeat runs update records and flag new companies
- [ ] Excel/CSV report per state: master list, qualified list, by city, contact completeness, summary with reasons,
      sources and dates
- [ ] Accuracy proven by blind hand-checks against live sources before any list is delivered
- [ ] Web app on Railway with sign-in and roles (Admin / Operator / Viewer); admin adds users
- [ ] Pilot first (one area per state) to measure real fill rates, accuracy and Google's tolerance before full runs

### Out of Scope

- Third-party data services (Apify, Outscraper, Google Places API, email finders, proxy networks) — his ruling
  2026-10-25: "no data or 3rd party services, all tasks performed by the system end to end".
- AI/LLM reading of pages — his ruling 2026-10-25: rules only.
- Guessing emails from patterns (first@domain) or presenting unverified names — violates the core value.
- Importing the client's 55k GoHighLevel CRM export — "forget the 55k csv … for now" (kept local only; real PII,
  never committed).
- Phone verification calls, outreach/sending (email, SMS, dialer) — the client does outreach in their own tools.
- Detecting whether a company already runs Google Local Services Ads — not requested.
- Solving CAPTCHAs or logging into Google/Facebook/other sites to get data.

## Context

- Client brief (state-driven lead generation) and the full discussion trail: `.planning/00-DISCUSSION.md`.
- Live probes 2026-10-25 (this laptop, home connection): Google Maps search loads for our own headless browser with no
  block; one search returns at most 120 listings (Austin: 120, San Diego: 82); 118/120 cards carry rating + review
  count; a place page gives phone (E.164), website, full address with ZIP, category.
- California contractor board (CSLB) free download: 245,633 licences; 15,555 active (CLEAR) C-33 painting licences,
  all with a phone; ~58% sole owners whose licence name IS the owner's name. San Diego test: 37 of 69 Google listings
  with a phone matched a CSLB licence by phone alone (36 of them C-33). The personnel (officer names) file arrived
  truncated mid-row on 3 download attempts from this connection — needs a fast-server download or per-licence lookup.
- Google "limited view" (Feb 2026) can hide review counts for traffic it flags, without an error — a missing value
  must never be recorded as zero.
- The client previously bought Outscraper/Apify exports (tags in their CRM); this system replaces that with our own
  scraper.
- Machine: 16 GB laptop (one RAM stick); Postgres 18 service on :5432; Playwright Chromium cached on D:.

## Constraints

- **No outside services / no AI**: only our own code reading public pages and free official downloads — his rulings.
- **Accuracy**: Findversity-level — no value without a source; hand-checked samples before delivery.
- **Hosting**: a NEW paid Railway account (he creates it); repo private on GitHub org `my-stuffff`.
- **Privacy**: client CRM data never leaves this machine; test fixtures use public business pages only.
- **Politeness / blocking**: Google tolerance is unknown — scraping must be throttled, resumable, and stop on blocks;
  datacentre IPs (Railway) may be treated worse than home IPs and proxies are ruled out.
- **Tech stack**: TypeScript on Node 22, pnpm workspaces, Postgres + Drizzle, Playwright, cheerio, exceljs, vitest —
  matches his other apps so a future web app shares the same kit.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Scrape Google Maps with our own headless browser | Ruled: no outside services; probe proved it works from this laptop | — Pending |
| Pilot (one area per state) before full runs | Real fill rates/accuracy/block behaviour unknown until measured | — Pending |
| Every value stored as evidence (source URL, captured_at, confidence) | Core value: provable data | — Pending |
| Residential-only = qualified list; "also commercial" kept in master, excluded | "Exclusively residential" + client wants whole market visible | — Pending |
| CSLB licence data for CA owner names | Free, official, statewide; sole owners named in licence | — Pending |
| Roles Admin / Operator / Viewer | Confirmed by him 2026-10-25 | ✓ Good |
| Scraper location (Railway vs this PC as an agent) | Decided by pilot datacentre test | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-25 after initialization*
