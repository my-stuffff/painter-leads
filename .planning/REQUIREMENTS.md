# Requirements: Painter Promotions — Lead Finder

**Defined:** 2026-10-25
**Core Value:** Every value in the list is correct and provable (source link + capture date) — a blank is acceptable,
a wrong or guessed value is not.

## v1 Requirements

### Discovery (Google Maps, our own scraper)

- [ ] **DISC-01**: Operator can name a state (or a pilot area within it) and the system plans searches that cover every
      city/ZIP area of it, not just the top results (one Google search shows at most 120 listings)
- [ ] **DISC-02**: For every listing found, the system records Google place ID, profile link, name, category, rating,
      number of ratings, phone, website, full address, city, ZIP, state and map position
- [ ] **DISC-03**: The system detects blocks, "unusual traffic" pages and Google's limited view; a value it could not
      read is stored as "not captured", never as zero, and is retried later
- [ ] **DISC-04**: Scraping is throttled, stops on a block, and resumes where it stopped without repeating finished
      searches
- [ ] **DISC-05**: Operator gets a coverage summary per run: searches done, listings found, new vs already known

### Qualification (rules only, no AI)

- [ ] **QUAL-01**: Listings that are not painting contractors (paint stores, art studios, auto-body painters,
      unrelated categories) are marked "not a painting contractor" with the reason
- [ ] **QUAL-02**: Each painting company is classified residential-only / residential-and-commercial /
      commercial-only / unclear from its Google category, name, website and services, with the signals that decided it
- [ ] **QUAL-03**: A company is "qualified" only if residential-only, has a Google profile, rating ≥ 4.7 and 10–99
      reviews; every other company carries the exact reason(s) it is excluded
- [ ] **QUAL-04**: Thresholds (rating, review range) live in one config place, so the client can change them without
      code edits

### Enrichment (owner name, email — free public sources only)

- [ ] **ENR-01**: The system reads each company's own website (home, contact, about, team, services pages) and records
      every published email address with the page it was found on
- [ ] **ENR-02**: The system records owner / decision-maker names stated on the company website ("owner", "founder",
      "president", "meet …") with the page and the sentence that ties the person to the company
- [ ] **ENR-03**: California companies are matched to their CSLB contractor licence (by phone, name, address) and get
      the licence number, licence status and owner/officer names from it
- [ ] **ENR-04**: New Jersey companies are matched to their Home Improvement Contractor registration and Texas
      companies to Comptroller/state business records wherever those public sources expose owners/officers (exact
      coverage set by the source probe)
- [ ] **ENR-05**: BBB business profiles are used for owner/principal names where a plain public fetch works
- [ ] **ENR-06**: Every enriched value stores source type, source URL, capture date, the exact snippet, and a
      confidence level; two independent sources agreeing raises confidence; nothing is inferred or pattern-guessed
- [ ] **ENR-07**: Emails are kept only if published by the company itself (its site/profile) and their domain accepts
      mail (DNS check); web-designer, placeholder and privacy-proxy addresses are rejected

### Records (de-duplication and repeat runs)

- [ ] **REC-01**: The same company found by several searches or sources becomes one record (matched on place ID,
      phone, website domain, name + address), with the evidence from each source kept
- [ ] **REC-02**: Re-running a state updates existing records (new rating, new reviews), marks newly found companies as
      new and companies no longer listed as gone, without creating duplicates

### Reports

- [ ] **REP-01**: Operator can download an Excel workbook per state/run with tabs: Master list, Qualified, By city,
      Contact completeness, Summary (counts discovered / qualified / excluded / missing contact info, reasons, sources,
      collection dates)
- [ ] **REP-02**: The same lists are downloadable as CSV
- [ ] **REP-03**: Each filled cell can be traced to its source (source URL + date columns or a sources tab)

### Accuracy

- [ ] **ACC-01**: Before a list is delivered, a random sample (pilot: 50 companies per state) is checked blind against
      the live sources; ≥ 98% of filled values must be correct, misses are analysed and fixed
- [ ] **ACC-02**: The checked companies become a saved "golden set" (stored pages + correct answers) that the
      automated tests replay, so a code change cannot silently lower accuracy
- [ ] **ACC-03**: The pilot reports real fill rates per state (owner %, email %, phone %, website %) and the share of
      findable values the system missed

### Web app (Railway)

- [ ] **APP-01**: Users sign in; an Admin can add users and give them a role: Admin (everything + users), Operator
      (start runs, download), Viewer (see results, download)
- [ ] **APP-02**: Operator can start a run for a state and watch its progress (searches done, companies found,
      enriched, qualified)
- [ ] **APP-03**: Users can browse results with filters (qualified only, city, missing email/owner) and open any
      company's sources
- [ ] **APP-04**: Users can download the Excel / CSV reports from the app

### Operations

- [ ] **OPS-01**: Code lives in a private repo on GitHub org `my-stuffff` with automated tests running on GitHub
      Actions
- [ ] **OPS-02**: The app runs on the new paid Railway account (web + worker + Postgres); where the scraper runs
      (Railway vs this PC as an agent feeding Railway) follows the pilot's datacentre test

## v2 Requirements

### More states

- **STATE-01**: Owner-name registry adapters for further states (each state's register differs)
- **STATE-02**: Scheduled re-runs per state to keep ratings and new companies current

### CRM

- **CRM-01**: Import the client's GoHighLevel export as an "already known" list (clients, disqualified, bad numbers,
  already contacted) so new lists flag them

## Out of Scope

| Feature | Reason |
|---------|--------|
| Third-party data services (Apify, Outscraper, Google Places API, Hunter/Apollo, proxy networks) | His ruling 2026-10-25 — the system does everything itself |
| AI/LLM page reading | His ruling 2026-10-25 — rules only |
| Pattern-guessed emails, unverified names | Breaks the core value (provable data) |
| CAPTCHA solving, logging into Google/Facebook/Yelp | Not ours to bypass; brittle and risky |
| Verification phone calls, outreach sending | Client does outreach in Kixie / their CRM |
| Local Services Ads status detection | Not requested |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DISC-01 | Phase 2 | Pending |
| DISC-02 | Phase 1 | Pending |
| DISC-03 | Phase 1 | Pending |
| DISC-04 | Phase 1 | Pending |
| DISC-05 | Phase 2 | Pending |
| QUAL-01 | Phase 1 | Pending |
| QUAL-02 | Phase 1 | Pending |
| QUAL-03 | Phase 1 | Pending |
| QUAL-04 | Phase 1 | Pending |
| ENR-01 | Phase 1 | Pending |
| ENR-02 | Phase 1 | Pending |
| ENR-03 | Phase 1 | Pending |
| ENR-04 | Phase 1 | Pending |
| ENR-05 | Phase 1 | Pending |
| ENR-06 | Phase 1 | Pending |
| ENR-07 | Phase 1 | Pending |
| REC-01 | Phase 1 | Pending |
| REC-02 | Phase 2 | Pending |
| REP-01 | Phase 1 | Pending |
| REP-02 | Phase 1 | Pending |
| REP-03 | Phase 1 | Pending |
| ACC-01 | Phase 1 | Pending |
| ACC-02 | Phase 1 | Pending |
| ACC-03 | Phase 1 | Pending |
| APP-01 | Phase 3 | Pending |
| APP-02 | Phase 3 | Pending |
| APP-03 | Phase 3 | Pending |
| APP-04 | Phase 3 | Pending |
| OPS-01 | Phase 1 | Pending |
| OPS-02 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 30 total
- Mapped to phases: 30
- Unmapped: 0 ✓

---
*Requirements defined: 2026-10-25*
*Last updated: 2026-10-25 after roadmap creation (traceability filled)*
