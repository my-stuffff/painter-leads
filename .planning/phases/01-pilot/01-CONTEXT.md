# Phase 1: Pilot — Context

**Gathered:** 2026-10-25 (discussion with the owner in the orchestrator session; rulings in `.planning/00-DISCUSSION.md`)
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the lead-finder data engine in its final architecture (not throwaway) and prove it on ONE city per state
(New Jersey, Texas, California): our own Google Maps scraper → non-painter filter → residential-only classification →
owner/email enrichment from free public sources → one record per company → target qualification → Excel/CSV report.
Then measure it: real fill rates per state, a blind hand-check of 50 companies per state (≥98% of filled values
correct), the checked companies saved as a golden test set, and a measured answer on whether Google Maps scraping works
from a datacentre IP. No web app in this phase (Phase 3); no statewide runs (Phase 2).

</domain>

<decisions>
## Implementation Decisions

### Hard rules from the owner (non-negotiable)
- **D-01:** No third-party data services of any kind — no Apify, Outscraper, Google Places API, SerpAPI, email
  finders (Hunter/Apollo/…), OpenCorporates API, proxy networks, CAPTCHA solvers. Only our own code reading public
  pages and free official downloads.
- **D-02:** No AI/LLM anywhere in the product — every classification and extraction is a written rule.
- **D-03:** Accuracy over coverage: a blank is acceptable, a wrong or guessed value is not. No pattern-guessed emails,
  no inferred names. Every stored value carries source type, source URL, captured_at, the exact snippet it came from,
  extractor version and a confidence level.
- **D-04:** "Residential exclusively": the Qualified list contains residential-only companies. Companies that also
  advertise commercial work stay in the master list marked `excluded: also commercial`. Undecidable → `unclear`
  (kept, not qualified, not dropped).
- **D-05:** Target filter (configurable in one place): rating ≥ 4.7 AND 10 ≤ reviews ≤ 99 AND has Google profile AND
  residential-only. Every non-qualified company lists all reasons that excluded it.
- **D-06:** The client's 55k CRM export (`C:\Users\bigsh\Downloads\Export_Contacts_All_Oct_2026_2_05_AM.csv`) is NOT
  used ("forget the 55k csv … for now") and must never be read by workers or committed (real PII).
- **D-07:** Repo: private `my-stuffff/painter-leads` on GitHub; CI on GitHub Actions. Hosting later: a NEW paid
  Railway account the owner creates.

### Pilot areas
- **D-08:** One city per state: **Edison, NJ** (Middlesex County; plus adjoining Woodbridge/Metuchen ZIPs if Edison
  alone yields < 60 companies), **Austin, TX**, **San Diego, CA**. Expect roughly 100–400 companies each.
- **D-09:** Area → searches: the city's ZIP codes (from free US Census files — Gazetteer ZCTA centroids /
  ZCTA-to-place relationship) × search terms {"house painter", "painting contractor", "interior painter",
  "exterior house painting", "cabinet painting"}. The pilot records how many NEW companies each term and each ZIP
  adds, so Phase 2 can drop low-yield terms.
  **Amended after research (orchestrator, 2026-10-25):** the full city lists (Edison 3 ZCTAs, Austin 38, San Diego 45
  at ≥20% land share ≈ 430 searches ≈ 2 days throttled) are too slow for a pilot. The pilot uses a ZIP SUBSET:
  Edison's 3 ZCTAs (+ Metuchen 08840 / Woodbridge ZCTAs only if Edison yields < 60 painting companies), and 12 ZCTAs
  each for Austin and San Diego, picked to span the urban core and the suburbs (highest land share first, spread
  across the city). All 5 terms on every pilot ZIP (≈ 135 searches) so per-term yield is measured cleanly. The full
  ZIP lists are kept in the area files for Phase 2. Run order: Edison → Austin → San Diego; within a city, term 1
  over all ZIPs before term 2.
- **D-10:** A company belongs to the area by its address/ZIP when shown; service-area businesses (no street address —
  29% in San Diego) are placed by the coordinates in their Google link (offline point-in-ZIP using Census ZCTA shapes)
  and marked `location: approximate (service-area business)`.

### Google Maps scraping (packages/maps)
- **D-11:** Own headless Chromium via `playwright-core` (installed Chromium cache `D:\Dev-Cache\ms-playwright`),
  en-US / gl=us, normal desktop Chrome UA. Selectors proven on 2026-10-25 are in
  `.planning/research/PROBES-2026-10-25.md` §1; parsers must prefer aria-labels / data-item-id over CSS class names.
- **D-12:** Per listing, capture from the list card AND the place page: place id, CID, profile URL, name, all
  categories, rating, review count, phone (E.164 from `phone:tel:`), website URL, full address, city, ZIP, state,
  lat/lng, "permanently closed" flag. Store the raw card text/JSON for audit.
- **D-13:** Block handling: detect `/sorry/` redirects, CAPTCHA, "unusual traffic" pages, and limited view (by the
  ABSENCE of review count/reviews tab — NOT by text match; the phrase appears in normal pages). A value not captured
  is NULL + `capture_status`, never 0. On any block: stop the run, record it, back off; runs resume from the last
  unfinished search.
- **D-14:** Throttling for the pilot: one browser, sequential, randomized pauses (searches ≥ 10–20 s apart, place pages
  ≥ 4–8 s apart), a hard daily cap, every request logged with outcome so the pilot can report the safe rate.
- **D-15:** Workers may run at most 3 live Google searches while developing (smoke only); the full pilot run is done
  by the orchestrator in the last plan. CI never touches Google.

### Owner name & email enrichment (packages/sites, packages/registries)
- **D-16:** Company website crawl: home page + up to 7 internal pages whose link text/URL matches
  contact|about|team|our-story|meet|owner|services|residential|commercial; honour robots.txt; ≤ 1 request/second per
  domain; cache every fetched page on disk (needed for audit and the golden set). If a page's visible text is nearly
  empty (JavaScript app, e.g. wepainttexas.com showed 42 characters), re-fetch it with the headless browser and
  record `rendered: true`. Also scan the 13VH NJ registration number when present (direct join key).
- **D-17:** Emails: `mailto:` links, visible text (plain-text-only emails are common), JSON-LD `email`,
  Cloudflare-obfuscated (`data-cfemail`) and `[at]/(dot)` forms. Addresses found only inside JavaScript bundles count
  only when their domain equals the website's domain (bundles carry placeholders like `jane@email.com`,
  `you@example.com`).
  Keep only emails published on the company's own site whose domain is the website's domain or a free-mail provider;
  reject web-designer credit addresses, placeholders (example.com, wix/sentry/godaddy defaults), privacy proxies
  (withheldforprivacy.com, contactprivacy.com, domainsbyproxy …), image names (`logo@2x.png`). Domain must pass a DNS
  MX (or A fallback) check. Rank: owner's personal address > office/info > others; keep all with sources.
- **D-18:** Owner names from websites: only when a sentence ties a person to THIS company as owner / founder /
  co-founder / president / CEO / proprietor ("Meet John Smith, owner of …", "Founded in 2009 by Maria Lopez", "Hi,
  I'm Mike — owner"), validated by a US first-name list (SSA public baby-name data, downloaded once as a data file) and
  a capitalised surname; reject names that equal company-name tokens, cities, or painting words; schema.org
  `founder`/`Person` JSON-LD counts as a statement. Reviewer mentions ("John the owner was great") are low-confidence
  only. **Theme placeholders are real and observed** (rutgerspainting.com: "Brennan Price Owner" next to filler Latin
  — the state register says the owner is Donal Lopez): a page with filler text (lorem ipsum AND other Latin filler
  variants, demo-content markers — NOT "0 +" counters, which research showed are Elementor count-up widgets with real
  `data-to-value`) yields NO owner names, and a name that appears
  as "owner" on several unrelated companies' sites is treated as a template and rejected. When a registry owner and a
  website owner disagree, the registry wins and the website claim is stored as `rejected: conflicts with registry`.
- **D-19:** California: match each listing to a CSLB licence — exact 10-digit phone match = strong; normalised name
  (strip LLC/INC/CORP/& /punctuation, DBA via `BUS-NAME-2`) + same city/ZIP = strong; name-only = candidate, not a
  match. Owner = Sole Owner licence name (master file, reorder LAST FIRST MIDDLE → First Last); otherwise currently
  associated personnel (no DIS-ASSN-DT) by priority CEO/President > Owner/Sole Owner > RMO > Officer > LLC
  Member/Manager > General Partner. Also store licence number, status, classifications, expiry.
- **D-20:** CSLB personnel file arrives truncated from this connection (3 attempts) — the loader must validate
  completeness (last row parses; max licence number within ~1% of the master's) and refuse a partial file; fallback is
  the per-licence CSLB lookup for matched licences only.
- **D-21:** New Jersey / Texas / BBB owner sources — exactly what `.planning/research/SOURCES-PROBE.md` proved
  (orchestrator re-verified the three key claims first-hand 2026-10-25):
  - **NJ index = HIC roster download** (`newjersey.mylicense.com/Verification_Bulk/`, 5-step ASP.NET form, free,
    pipe-delimited `Data.txt`): registrant legal name, address, ZIP, status, licence no. (13VH…), **email**
    (`addr_email`, ~70% filled), no phones, no owner names. Pull per town for the pilot area (statewide pull is
    untested). Match Google listings to registrations by: 13VH number shown on the company website (direct key),
    email domain = website domain, normalised name "contains" + same ZIP/town, street address. Prefer Active
    registrations; record status.
  - **NJ owner = HIC detail page** (`/verification/` search → `Details.aspx?result=<GUID>` in the SAME cookie session;
    a fresh session gets HTTP 500): `span#owner_name`. 3 requests per company → only for matched registrations, gently.
  - **NJ second source (free)**: NJ business register principal-name search (njportal.com BusinessRecords wizard)
    confirms "person X is a principal of company Y" → raises an owner name to high confidence. Officer lists are a
    paid order → never ordered.
  - **NJ HIC roster email** counts as a company-published email (source `nj_hic_roster`) — the registrant's own
    submitted contact address.
  - **TX index = data.texas.gov "Active Franchise Taxpayers"** (Socrata `9cir-efmm`, free, SoQL `like` contains-search
    on name + ZIP/city) → taxpayer number. **TX officers = Comptroller detail JSON**
    `GET https://comptroller.texas.gov/data-search/franchise-tax/<taxpayerId>` → `officerInfo[]` (name, title,
    year) + `registeredAgentName`. Registered agent is NOT the owner unless it is a person who also appears among the
    officers; corporate agent services ("… CORPORATION AGENTS, INC.", "REGISTERED AGENTS …") are ignored. The
    Comptroller's robots.txt disallows `/data-search/` → **use is pending the owner's decision** (recommendation: use
    it gently — one request every few seconds, only for companies already matched). Sole proprietors / brand names
    with no registered entity get no TX registry owner.
  - **This laptop's default DNS cannot resolve `*.texas.gov`** → the core fetcher must support a custom resolver
    (public DNS 1.1.1.1 / 8.8.8.8 via a custom `lookup` on the HTTP agent), configurable per host.
  - **BBB**: profile pages carry owner names in JSON-LD `employee[]` (`givenName`, `familyName`, `jobTitle`) and
    "Business Management" text; phones; never emails. **bbb.org returns Cloudflare 403 to this laptop** (IP-level),
    loads from other networks. robots.txt allows profile pages and sitemaps, disallows any URL with a query string
    (so the `/api/search?…` JSON API is off-limits) → find profiles via BBB's business-profile sitemaps, read the
    profile JSON-LD. The adapter is built from fixtures captured on a network where bbb.org loads (orchestrator
    captures them from the Railway test service; never from GitHub Actions scraping jobs) and runs live only where
    reachable; from this laptop it records `blocked`, never "no owner".
- **D-22:** Confidence: `high` = registry record matched strongly (CSLB, NJ HIC detail, TX Comptroller officer), or
  two independent sources agree (e.g. NJ HIC owner = BBB owner = NJ principal search); `medium` = one explicit website
  statement on the company's own domain on a page that passed the placeholder check; `low` = anything weaker. Report
  columns show high + medium only, with the confidence in its own column; low stays in the database with a "needs
  review" flag. The pilot hand-check measures the precision of each confidence level separately — if website-only
  `medium` names miss the 98% bar, they drop to `low` (decision recorded in the pilot report).
- **D-23:** Phone shown in the report = the Google listing phone (what customers call); other phones (CSLB,
  website) kept as extra evidence.

### Non-painter filter & residential classification (rules)
- **D-24:** Non-painters: keep listings whose categories include painter/painting (Painter, Painting, House painter,
  Painting contractor, Commercial painter …) or whose name contains "paint"/"coating" with a contractor-type category;
  mark as `not a painting contractor` paint stores, art studios/classes ("Painting with a Twist"), auto body / car
  painting, muralists, paint manufacturers, wallpaper stores, interior designers — each with the category that decided
  it.
- **D-25:** Residential classifier: signals from Google categories, company name ("Commercial", "Industrial",
  "Coatings", "Epoxy"), website service pages/menus and phrases (residential: interior/exterior house painting,
  cabinet painting/refinishing, deck/fence staining, homeowners, "your home"; commercial: commercial painting,
  industrial, office/retail/warehouse, property management, HOA, multi-family/apartments, tenant improvement, new
  construction, "residential and commercial"), negations ("we do not do commercial work"). Output one of
  residential_only / residential_and_commercial / commercial_only / unclear, with the signals listed. An active NJ
  Home Improvement Contractor registration (required for residential/non-commercial work) is a supporting residential
  signal, never proof of "exclusively".

### Source switches and pending owner decisions
- **D-36:** Every external source has an on/off switch in the one config file (maps, cslb, nj_hic_roster,
  nj_hic_detail, nj_principal_search, tx_open_data, tx_comptroller, bbb, websites) plus its own rate limit. The
  Texas Comptroller switch ships OFF until the owner rules on its robots.txt (D-21); the pilot report states what
  Texas coverage looks like with it off and on.
- **D-37:** The datacentre test (D-30) and the BBB fixture capture need the owner's new paid Railway account; the
  orchestrator asks for it at the start of execution. If it is not ready by plan 01-06, those two items are recorded
  as carried to Phase 3 — the rest of the pilot does not wait. The Railway CLI on this machine is logged into the
  owner's NASEEHA account — it must NEVER be used for this project; the test uses a token/login for the new account
  only. The same Railway service may fetch the SSA baby-names file once (ssa.gov returns 403 here); until then the
  Census 1990 first-name lists are the name dictionary.
- **D-38:** Hand-check drift tolerance: a review count is correct if live ≥ captured and live − captured ≤ max(2, 3%);
  a rating is correct if equal, or within 0.1 when the review count also changed. Truth is collected within 48 hours
  of the run. Precision is reported per field and per confidence level with Wilson 95% intervals, per state and
  pooled — per-state-per-field numbers on 50 companies are indicative only (research Pitfall 16).

### Records, report
- **D-26:** One company = one record: merge on Google place id, then exact phone, then website registrable domain,
  then normalised name + ZIP; keep every source's evidence. Franchise locations (CertaPro, Five Star Painting, Fresh
  Coat …) stay separate records per location and get a `franchise` flag.
- **D-27:** Excel workbook (exceljs) per run — tabs and columns (the "look" the owner approves with this plan):
  - **Qualified**: Company · Owner / decision-maker · Owner title · Owner source · Owner confidence · Phone · Email ·
    Email source · Website · Google rating · Google reviews · Google profile link · Category · Address · City · ZIP ·
    State · Licence/registration no. · Residential status · First seen · Last checked
  - **Master list**: all of the above for every company + Qualified (yes/no) + Exclusion reasons
  - **By city**: city · companies found · qualified · with owner · with email
  - **Contact completeness**: counts and % of owner / email / phone / website, overall and qualified-only
  - **Summary**: run date, area, searches, listings found, not-painters, residential-only, qualified, excluded by
    reason, sources used with dates
  - **Sources**: company · field · value · source URL · captured at · confidence
  CSV export of Master and Qualified with the same columns.

### Architecture & stack
- **D-28:** TypeScript monorepo, pnpm workspaces, Node 22. Packages: `core` (types, config, normalisers, DB schema +
  migrations + client, evidence API, polite HTTP fetcher with on-disk cache, logging), `maps`, `registries`,
  `sites` (website crawl + email/owner extraction + residential classifier), `pipeline` (dedupe, field selection,
  qualification, report, run orchestration); `apps/cli` (`pp …` commands). Postgres via Drizzle ORM with versioned
  migrations; ONE migration owner (the foundation plan); later schema needs go to the orchestrator. Tests: vitest with
  recorded fixtures (no live network in tests); a Postgres service in CI.
- **D-29:** Local dev DB: the machine's Postgres 18 service on 127.0.0.1:5432 (user/pass postgres/postgres), databases
  `painter_leads` + one test DB per worker (`painter_leads_test_<slug>`), chosen by env var.
- **D-30:** Datacentre test: once the owner's new Railway account exists, run a small scripted Maps search batch from a
  Railway service and record block signals; if the account is not ready during this phase, record that the test moves
  to Phase 3 (do NOT use GitHub Actions runners for scraping).

### Accuracy protocol
- **D-31:** Blind hand-check: 50 random companies per state (stratified: ≥ 25 qualified when available). The checker
  gets ONLY company name + Google profile link, independently collects the truth from the live sources (Maps, the
  company website, registries), then a script compares with the system's output. Measures precision of every filled
  field (target ≥ 98%) and recall (findable values the system missed). Misses are analysed and fixed before the
  numbers are reported.
- **D-32:** Golden set: the checked companies' saved pages + correct answers become fixtures replayed by automated
  tests (extractors, classifier, matcher), so accuracy regressions fail CI.

### Plan decomposition (owner's orchestrate fleet — parallel Sonnet workers, one plan each)
- **D-33:** Plans must have strictly disjoint file surfaces so workers build and merge independently in any order:
  - **01-01 Foundation (wave 1)** — owns repo root config (package.json, pnpm-workspace.yaml, tsconfig base, lint,
    vitest config, `.github/workflows/`), `packages/core/**`, `apps/cli/**`, and creates empty-but-wired package
    skeletons for maps / registries / sites / pipeline (package.json with ALL their dependencies pre-installed,
    `src/index.ts` exporting a `commands` array, one passing placeholder test). Defines the contracts every other
    plan builds against: the full pilot DB schema in ONE migration, TypeScript types, the evidence API
    (record + select best value), the polite fetcher with disk cache, config (thresholds), normalisers (phone
    E.164, URL → registrable domain, business-name normalisation, LAST FIRST MIDDLE → First Last), and stage
    interfaces (discover, detail, registries-match, site-enrich, classify, merge, qualify, report) so the pipeline
    can be built against fakes.
  - **Wave 2 (parallel, after 01-01 merges):** 01-02 `packages/maps/**` · 01-03 `packages/registries/**` ·
    01-04 `packages/sites/**` (crawler, email/owner extraction, residential classifier, MX check, first-name data) ·
    01-05 `packages/pipeline/**` (dedupe/merge, best-value selection, non-painter filter, qualification, Excel/CSV
    report, run orchestration `pp pilot …`, the accuracy tools: stratified blind sample export, truth-vs-output
    comparison, golden-set replay harness).
  - **01-06 Pilot run & accuracy (wave 3, orchestrator-led)** — runs the three cities, the datacentre test, the blind
    hand-check (a fresh checker that sees only name + Google link), fixes misses via fresh workers, saves the golden
    set into fixtures + CI, writes `01-PILOT-REPORT.md` (fill rates, accuracy, block behaviour, projected full-run
    time), and ends with a human-verify checkpoint for the owner to open the workbooks.
- **D-34:** Wave-2 workers never edit `packages/core`, `apps/cli`, root config, migrations, or another package.
  Need a schema change or a core change → stop at a checkpoint and ask the orchestrator. Prefer the pre-installed
  dependencies; any new dependency is listed in REPORT.md (the orchestrator regenerates the lockfile at merge).
- **D-35:** Every plan carries inline: exact file scope, out-of-scope list, a hard-forbidden list (no push/merge/
  deploy/Railway commands; no third-party data or AI services; no proxies/CAPTCHA solving/logins; ≤ 3 live Google
  searches; never read `C:\Users\bigsh\Downloads`), and its own verification commands with expected output.

### Claude's Discretion
- Internal module boundaries inside each package, library choices beyond those named (phone: libphonenumber-js;
  HTML: cheerio; Excel: exceljs), logging format, CLI command names.
- Exact throttling numbers within D-14's bounds.

</decisions>

<specifics>
## Specific Ideas

- The owner's accuracy bar is "on par with Findversity or more" — Findversity's rule: every data point traces to a
  verified source URL; never display unverified data.
- Client brief wants per company: company name, owner/decision-maker, phone, email, website, full address, city, ZIP,
  state, Google profile URL, rating, review count, category, service info; plus master vs qualified lists, by-city
  breakdown, completeness, reasons for exclusion, sources and dates (`.planning/00-DISCUSSION.md`).
- Speed checklist (owner's standing rule): fewer bigger plans; delete each worker's worktree once merged; tests in CI
  not on the 16 GB laptop; proof in proportion to risk (heavy proof only on accuracy).

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Owner rulings and client brief
- `.planning/00-DISCUSSION.md` — client brief, every ruling (newest at top), rejected options
- `.planning/PROJECT.md` — core value, constraints, key decisions
- `.planning/REQUIREMENTS.md` — REQ-IDs for this phase

### Verified facts
- `.planning/research/PROBES-2026-10-25.md` — Google Maps selectors/caps/limited view; CSLB files, counts, truncation
- `.planning/research/SOURCES-PROBE.md` — NJ HIC, NJ business records, TX Comptroller, BBB, website patterns

</canonical_refs>

<code_context>
## Existing Code Insights

Greenfield repo (`D:\ClaudeCode\Painter-Promotions\painter-leads`, only `.planning/`). Throwaway probe scripts that
proved the Maps and CSLB access paths: `D:\ClaudeCode\_Scratch\pp-probe\maps-probe.js`, `cslb-probe.js` (reference
only — do not import).

</code_context>

<deferred>
## Deferred Ideas

- Statewide coverage planning + full NJ/TX/CA runs + repeat-run diffs — Phase 2.
- Web app (sign-in, roles, run/progress, browse, downloads) and Railway deployment — Phase 3.
- Owner names from Google review owner-replies, Facebook pages, Yelp — later, only if the pilot shows gaps worth it.
- CRM "already known" import — v2.

</deferred>

---

*Phase: 01-pilot*
*Context gathered: 2026-10-25*
