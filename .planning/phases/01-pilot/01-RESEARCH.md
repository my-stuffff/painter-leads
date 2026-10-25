# Phase 1: Pilot - Research

**Researched:** 2026-10-25
**Domain:** Rules-only lead-data engine: headless-browser Google Maps scraping, polite HTTP crawling, ASP.NET/JSON registry adapters, rule-based extraction, evidence-per-value Postgres store, Excel/CSV reporting, blind accuracy measurement
**Confidence:** HIGH for stack/versions and data files (verified this session by registry, install, and first-hand downloads); MEDIUM for extraction-rule patterns (designed from observed pages, not yet measured); LOW only where tagged `[ASSUMED]`

## Summary

All data-source access questions were already answered first-hand (`.planning/research/PROBES-2026-10-25.md`, `.planning/research/SOURCES-PROBE.md`). This research covers what the planner still needs: exact package versions that work on this machine, the official geo/name data files, the rule patterns, the measurement method, and the traps. Several findings change what the plans must say:

1. **`playwright-core` must be pinned to exactly `1.63.0`.** Version 1.64.1 (current latest) needs Chromium revision 1248, but the local cache only has 1243. `^1.63.0` would silently install 1.64.1 and fail to launch. `[VERIFIED: browsers.json in npm tarballs 1.63.0 → "revision": "1243"; 1.64.1 → "revision": "1248"; ls D:\Dev-Cache\ms-playwright → chromium-1243]`
2. **Node 22's built-in `fetch` cannot use an undici 8 `Agent`.** It fails with `invalid onRequestStart method`, because Node 22.22.2 bundles undici 6.24.1. The polite fetcher must import `fetch`/`request` from the `undici` package. A custom DNS `lookup` on `new Agent({ connect: { lookup } })` works, and `net` calls it with `{"hints":0,"all":true}`, so it must return an array. `[VERIFIED: local test this session]`
3. **Edison, NJ is not a Census "place"; it is a township (county subdivision).** Its ZIP list comes from the ZCTA→county-subdivision file, not the ZCTA→place file. Austin and San Diego come from the ZCTA→place file. `[VERIFIED: downloaded files this session]`
4. **The SSA baby-names file (`ssa.gov`) returns Akamai "Access Denied" (403) to this laptop *and* to WebFetch.** It is CC0, but it has to be downloaded once from another network (Railway or a CI job). The Census 1990 first-name lists (www2.census.gov, reachable) serve as the immediate fallback. `[VERIFIED: curl + WebFetch this session]`
5. **D-18's "zeroed counters" placeholder signal will misfire on every Elementor site.** On rutgerspainting.com the "Projects Complete 0 +" is an Elementor count-up widget with `data-to-value="70"` and `data-to-value="130"`, so the static 0 is the start of an animation. The real placeholder evidence on that page is Cicero-style Latin filler that is not "lorem ipsum" ("Ita eiusmod si commodo ut culpa…", "tavissent", "arbitrantur", "instituendarum"). A plain `lorem ipsum` string match would miss it. `[VERIFIED: cached page1.html from the 2026-10-25 probe]`
6. **Merging on registrable domain breaks on shared hosts.** `tldts` returns `godaddysites.com`, `business.site`, `weebly.com`, `google.com` (sites.google.com) and `facebook.com` as the "domain". With `allowPrivateDomains: true` it returns `jdoe.wixsite.com`, `acme.square.site` and `acme.myshopify.com`. Without a shared-host denylist, unrelated companies would merge and the email-domain rule would accept the wrong addresses. `[VERIFIED: local test]`
7. **TypeScript 7.0.2 is "latest" but `typescript-eslint` 8.72.0 only supports `typescript >=4.8.4 <6.1.0`.** Use TypeScript `6.0.3`. TS 6 changed defaults (`types` now `[]`, `strict` now true, `baseUrl` deprecated), and the tsconfig base must allow for that. `[VERIFIED: npm view + TS 6.0 release notes]`

**Primary recommendation:** Build the foundation on TypeScript 6.0.3 + pnpm 9.15.9 (pinned to match this machine's corepack shims) + Node 22 + Drizzle 0.45.4/drizzle-kit 0.31.11 + vitest 5.0.5 + exact-pinned `playwright-core@1.63.0`. Use the `undici@8` package (never global fetch) behind one polite-fetcher module with per-host DNS, rate limit, robots.txt, cookie jar and a gzip disk cache keyed by URL hash. Commit a small, pre-built pilot geo file (ZIP lists + ZCTA polygons) and a first-name list as data files with provenance headers.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Search planning (area → ZIPs × terms) | core (geo data + config) | maps (consumes plan) | Geo data and terms are shared by maps (searches) and pipeline (area membership) |
| Google Maps discovery + place detail | maps (headless Chromium worker) | core (DB writes via evidence API) | Only maps touches a browser; it writes listings + raw card text |
| Block detection / resume | maps | core (`searches` table, request log) | Resume state must live in Postgres so a crash or block loses nothing |
| Polite HTTP (rate limit, robots, DNS, cookies, disk cache) | core (fetcher) | — | One implementation used by sites + registries; the cache is also the golden-set source |
| Website crawl + email/owner extraction + residential classifier | sites | core (fetcher, evidence API) | Pure functions over cached HTML → testable offline |
| Registry matching (CSLB, NJ HIC roster/detail, NJ principal, TX open data/Comptroller, BBB) | registries | core | Each source is its own adapter behind a source switch (D-36) |
| Evidence storage + best-value selection | core (DB/evidence API) | pipeline (selection policy) | Contract defined once in foundation |
| Dedupe/merge, non-painter filter, qualification | pipeline | core (config thresholds) | Business rules over stored evidence |
| Excel/CSV report | pipeline | — | Reads DB only |
| Accuracy tools (sample export, truth compare, golden replay) | pipeline | fixtures dir | Offline; golden replay runs in CI |
| Datacentre scrape test | maps (same code) on Railway | — | Same scraper, different IP; never GitHub Actions |
| Persistence | Database (Postgres 18) | Disk (page cache) | Raw pages on disk (big), hashes/paths and values in DB |

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Hard rules from the owner (non-negotiable)
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

#### Pilot areas
- **D-08:** One city per state: **Edison, NJ** (Middlesex County; plus adjoining Woodbridge/Metuchen ZIPs if Edison
  alone yields < 60 companies), **Austin, TX**, **San Diego, CA**. Expect roughly 100–400 companies each.
- **D-09:** Area → searches: the city's ZIP codes (from free US Census files — Gazetteer ZCTA centroids /
  ZCTA-to-place relationship) × search terms {"house painter", "painting contractor", "interior painter",
  "exterior house painting", "cabinet painting"}. The pilot records how many NEW companies each term and each ZIP
  adds, so Phase 2 can drop low-yield terms.
- **D-10:** A company belongs to the area by its address/ZIP when shown; service-area businesses (no street address —
  29% in San Diego) are placed by the coordinates in their Google link (offline point-in-ZIP using Census ZCTA shapes)
  and marked `location: approximate (service-area business)`.

#### Google Maps scraping (packages/maps)
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

#### Owner name & email enrichment (packages/sites, packages/registries)
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
  and "Projects Complete 0 +" — the state register says the owner is Donal Lopez): a page with filler text
  (lorem ipsum / Latin filler, zeroed counters, demo-content markers) yields NO owner names, and a name that appears
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

#### Non-painter filter & residential classification (rules)
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

#### Source switches and pending owner decisions
- **D-36:** Every external source has an on/off switch in the one config file (maps, cslb, nj_hic_roster,
  nj_hic_detail, nj_principal_search, tx_open_data, tx_comptroller, bbb, websites) plus its own rate limit. The
  Texas Comptroller switch ships OFF until the owner rules on its robots.txt (D-21); the pilot report states what
  Texas coverage looks like with it off and on.
- **D-37:** The datacentre test (D-30) and the BBB fixture capture need the owner's new paid Railway account; the
  orchestrator asks for it at the start of execution. If it is not ready by plan 01-06, those two items are recorded
  as carried to Phase 3 — the rest of the pilot does not wait.

#### Records, report
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

#### Architecture & stack
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

#### Accuracy protocol
- **D-31:** Blind hand-check: 50 random companies per state (stratified: ≥ 25 qualified when available). The checker
  gets ONLY company name + Google profile link, independently collects the truth from the live sources (Maps, the
  company website, registries), then a script compares with the system's output. Measures precision of every filled
  field (target ≥ 98%) and recall (findable values the system missed). Misses are analysed and fixed before the
  numbers are reported.
- **D-32:** Golden set: the checked companies' saved pages + correct answers become fixtures replayed by automated
  tests (extractors, classifier, matcher), so accuracy regressions fail CI.

#### Plan decomposition (owner's orchestrate fleet — parallel Sonnet workers, one plan each)
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

### Deferred Ideas (OUT OF SCOPE)
- Statewide coverage planning + full NJ/TX/CA runs + repeat-run diffs — Phase 2.
- Web app (sign-in, roles, run/progress, browse, downloads) and Railway deployment — Phase 3.
- Owner names from Google review owner-replies, Facebook pages, Yelp — later, only if the pilot shows gaps worth it.
- CRM "already known" import — v2.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DISC-02 | Record place ID, link, name, category, rating, ratings count, phone, website, address, city, ZIP, state, map position | Selectors in PROBES §1 (quoted below); CID/place-id URL parsing; `capture_status` per field; geo placement (§Geo data) |
| DISC-03 | Detect blocks / unusual traffic / limited view; never store 0 | Block-signal rules (Pattern 3); NULL + `capture_status` enum; Pitfall 1 |
| DISC-04 | Throttle, stop on block, resume without repeating | `searches` table state machine (Pattern 2); daily cap; request log |
| QUAL-01 | Non-painters marked with reason | Category rule table (§Rule Patterns R6) |
| QUAL-02 | Residential classification with signals | Keyword/negation rules (§R5), NJ HIC as supporting signal |
| QUAL-03 | Qualified only if residential-only + profile + rating ≥4.7 + 10–99 reviews; all reasons listed | Qualification as pure function returning `reasons[]`; NULL rating ≠ 0 → reason `rating not captured` |
| QUAL-04 | Thresholds in one config place | `pp.config.json` (zod-validated) in core |
| ENR-01 | Every published email + page found on | Email extractor (§R1, cfemail decode verified) |
| ENR-02 | Owner names from website with page + sentence | Owner-statement patterns (§R2), filler detector (§R3), first-name list (§Name data) |
| ENR-03 | CSLB match → licence no., status, owner/officers | CSLB columns (PROBES §2), name normaliser (§R4), completeness guard (D-20) |
| ENR-04 | NJ HIC + TX Comptroller/state records | ASP.NET session flow, roster parsing (verified csv-parse options), data.texas.gov field names (verified) |
| ENR-05 | BBB owner names where plain fetch works | JSON-LD `employee[]` parser from fixtures; `blocked` status from this laptop |
| ENR-06 | Source type, URL, date, snippet, confidence per value; agreement raises confidence | `evidence` table design (Pattern 1) |
| ENR-07 | Emails only if company-published + domain accepts mail | Domain rules + shared-host denylist (Pitfall 6) + MX/A check incl. null-MX |
| REC-01 | One record per company with all evidence | D-26 merge ladder + franchise/shared-host guards (Pitfall 7) |
| REP-01 | Excel workbook with the tabs | exceljs 4.4.0 verified (multi-sheet, widths, hyperlinks, frozen header, autofilter) |
| REP-02 | CSV of the same lists | UTF-8 BOM, formula-injection guard, ZIP-as-text (Pitfall 10) |
| REP-03 | Every filled cell traceable | Sources tab from `evidence`; per-field source columns |
| ACC-01 | Blind 50/state check ≥98% | Sampling + compare script design (§Validation Architecture), Wilson intervals |
| ACC-02 | Golden set replayed in CI | Disk-cache → fixtures copy; replay harness; CI job |
| ACC-03 | Fill rates per state + missed-findable share | Completeness query + compare-script recall |
| OPS-01 | Private repo in `my-stuffff`, tests on GitHub Actions | Org exists (free plan), repo not yet created; workflow skeleton with `postgres:18` service |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

From `.claude/CLAUDE.md` (project) and the user's global rules that bind execution:
- No outside services and no AI: only our own code reading public pages and free official downloads.
- Accuracy is at Findversity level: no value without a source, and samples are hand-checked before delivery.
- Repo is private on GitHub org `my-stuffff`. Hosting is a NEW paid Railway account the owner creates. **This laptop's Railway CLI (v5.41.2) is logged into the Naseeha account**, so no Railway command may run against it for this project (see Pitfall 14).
- Privacy: client CRM data never leaves this machine. Test fixtures use public business pages only.
- Scraping must be throttled and resumable, and must stop on blocks. No proxies.
- Stack: TypeScript on Node 22, pnpm workspaces, Postgres + Drizzle, Playwright, cheerio, exceljs, vitest.
- GSD workflow: edits only through GSD commands. Commits on handoff are pre-authorised. Nothing gets pushed, merged or deployed without the orchestrator.
- Machine rules (owner's memory): keep worktree directory names SHORT (Windows 260-char trap), delete each worker's worktree once merged, run heavy tests in CI rather than on the 16 GB laptop, never broad-kill `node` processes, and write non-ASCII files with the Write tool (Bash heredocs break on non-ASCII).

## Standard Stack

All versions checked against the npm registry on 2026-10-25. The Node engine was checked against the local Node **22.22.2**.

### Core
| Library | Version (pin) | Purpose | Why / verification |
|---------|---------------|---------|--------------------|
| node | 22.22.2 (local) | Runtime | `[VERIFIED: node --version]`. undici 8 needs `>=22.19.0`; vitest 5 needs `^22.12.0`; commander 15 needs `>=22.12.0` (all satisfied) |
| pnpm | **9.15.9** via `packageManager` | Workspaces | `[VERIFIED]` This machine's `~/bin/pnpm` shim runs `corepack pnpm@9.15.9` whatever `packageManager` says (tested: shim → 9.15.9, `corepack pnpm` → the packageManager version). Pinning 9.15.9 avoids two pnpm versions writing the lockfile. pnpm 9 runs dependency build scripts by default (esbuild for drizzle-kit/tsx) |
| typescript | **6.0.3** | Types | `[VERIFIED: npm view]` 7.0.2 is "latest" (the native Go port), but `typescript-eslint@8.72.0` peer is `>=4.8.4 <6.1.0` |
| drizzle-orm | **0.45.4** | ORM | `[VERIFIED]` `latest` tag. 1.0 is still `rc` (`1.0.0-rc.5`). Do NOT use 1.0: its docs describe a different migration folder layout (`<timestamp>/migration.sql + snapshot.json`) |
| drizzle-kit | **0.31.11** | Migrations | `[VERIFIED: generate --help]` flags `--name`, `--custom`, `--prefix [index\|timestamp\|…]` |
| pg | 8.23.1 (+ `@types/pg` 8.23.1) | Postgres driver | `[VERIFIED]` drizzle-orm peer `"pg": ">=8"` |
| playwright-core | **1.63.0 exact (no caret)** | Headless Chromium | `[VERIFIED]` 1.63.0 ↔ chromium revision 1243 (cached); 1.64.1 ↔ 1248 (not cached). `PLAYWRIGHT_BROWSERS_PATH=D:\Dev-Cache\ms-playwright` is set machine-wide |
| undici | 8.12.3 | HTTP client | `[VERIFIED: local test]` `Agent({ connect: { lookup } })`; exports `fetch`, `request`, `getSetCookies`, `MockAgent`, `SnapshotAgent` |
| cheerio | 1.2.0 | HTML parsing | `[VERIFIED]` engine `>=20.18.1` |
| libphonenumber-js | 1.13.15 | Phone E.164 | `[VERIFIED: local test]` `(512) 373-0002` → `+15123730002`, valid |
| tldts | 7.4.19 | Registrable domain | `[VERIFIED: local test]` needs `allowPrivateDomains: true` plus a shared-host denylist (Pitfall 6) |
| exceljs | 4.4.0 | Workbook | `[VERIFIED: local round-trip]` multi-sheet, `columns[].width`, `{ text, hyperlink }` cells, frozen header, autoFilter. Last release Dec 2024 (stable, slow-moving) |
| vitest | 5.0.5 (+ `vite` 8.3.5 as explicit devDep) | Tests | `[VERIFIED]` vite is a **peer** (`^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0`) |
| zod | 4.6.7 | Config/IO validation | Validates `pp.config.json`, truth CSVs, registry payloads |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| csv-parse | 7.0.3 | Streaming CSV/pipe files (CSLB 78 MB, NJ roster, Census rel files) | `[VERIFIED: parsed the cached NJ roster: 62 rows]` |
| robots-parser | 3.0.1 | robots.txt | `[VERIFIED: local test]` `Disallow: /*/` + `Allow: /taxes/` evaluated correctly |
| @turf/boolean-point-in-polygon | 7.4.0 | Point-in-ZCTA | `[VERIFIED: local test]` handles Polygon/MultiPolygon with holes |
| tsx | 4.23.15 | Run TS CLI (`pp`) without a build step | Dev + CLI entry |
| commander | 15.0.0 | `pp` CLI | Each package exports `commands` (D-33) |
| pino | 10.4.0 | JSON logs | Request log also goes to DB; pino for operator console |
| typescript-eslint | 8.72.0 + eslint 10.13.0 | Lint | Or Biome 2.6.3 (no TS coupling). Pick one in 01-01. Default recommendation: typescript-eslint, which works with TS 6 |
| @types/node | 22.x line | Node types | Must be listed in tsconfig `"types": ["node"]` (TS 6 default `types: []`) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| undici `fetch` | Node global `fetch` | **Rejected:** global fetch (bundled undici 6.24.1) throws `invalid onRequestStart method` with an undici 8 Agent `[VERIFIED]` |
| TIGERweb GeoJSON subset | `cb_2020_us_zcta520_500k.zip` (66.7 MB) + `shapefile` 0.6.6 | Offline national source; needs unzip + shapefile parsing. Use only as fallback |
| TS 6.0.3 | TS 7.0.2 + Biome | Faster typecheck, but no typescript-eslint support and a young native compiler |
| pnpm 9.15.9 | pnpm 10.34.8 | pnpm 10 blocks dependency build scripts unless `onlyBuiltDependencies` is set, and it conflicts with this machine's 9.15.9 shims |
| SSA names | Census 1990 first names (5,494 names) | Reachable now but dated (1990) and missing many modern/Hispanic names. Use as the fallback/union only |

**Installation (root, by 01-01):**
```bash
corepack pnpm add -Dw typescript@6.0.3 vitest@5.0.5 vite@8.3.5 tsx@4.23.15 @types/node@22 typescript-eslint@8.72.0 eslint@10.13.0
corepack pnpm --filter @pp/core add drizzle-orm@0.45.4 pg@8.23.1 undici@8.12.3 zod@4.6.7 tldts@7.4.19 libphonenumber-js@1.13.15 robots-parser@3.0.1 csv-parse@7.0.3 @turf/boolean-point-in-polygon@7.4.0 pino@10.4.0
corepack pnpm --filter @pp/core add -D drizzle-kit@0.31.11 @types/pg@8.23.1
corepack pnpm --filter @pp/maps add playwright-core@1.63.0 --save-exact
corepack pnpm --filter @pp/sites add cheerio@1.2.0
corepack pnpm --filter @pp/pipeline add exceljs@4.4.0 csv-parse@7.0.3
corepack pnpm --filter @pp/cli add commander@15.0.0
```
(Package scope `@pp/*` is a suggestion `[ASSUMED]`.) Pin exact versions (`save-exact=true` in `.npmrc`), because several packages were published in the last 7 days (see audit).

## Package Legitimacy Audit

Seam: `gsd-tools query package-legitimacy check --ecosystem npm …` (run 2026-10-25). Postinstall: none for all of them (`"postinstall":null`).

| Package | Registry | Latest published | Downloads/wk | Source Repo | Verdict | Disposition |
|---------|----------|------------------|--------------|-------------|---------|-------------|
| drizzle-orm | npm | 2026-10-08 | 19.7M | github.com/drizzle-team/drizzle-orm | SUS (too-new) | Approved, owner-named; pin 0.45.4 |
| drizzle-kit | npm | 2026-09-21 | 16.5M | github.com/drizzle-team/drizzle-orm | OK | Approved |
| pg | npm | 2026-09-30 | 43.2M | github.com/brianc/node-postgres | SUS (too-new) | Approved; pin 8.23.1 |
| @types/pg | npm | 2026-08-17 | 43.3M | DefinitelyTyped | OK | Approved |
| vitest | npm | 2026-10-15 | 83.7M | github.com/vitest-dev/vitest | SUS (too-new) | Approved, owner-named; pin 5.0.5 |
| playwright-core | npm | 2026-10-14 (1.64.1) | 83.1M | github.com/microsoft/playwright | SUS (too-new, for 1.64.1) | Approved **at 1.63.0** (published 2026-09-04) |
| cheerio | npm | 2026-01-23 | 16.7M | github.com/cheeriojs/cheerio | OK | Approved, owner-named |
| undici | npm | 2026-10-19 | 143.8M | github.com/nodejs/undici | SUS (too-new) | Approved `[ASSUMED]` choice; Node.js org project; pin 8.12.3 |
| libphonenumber-js | npm | 2026-10-08 | 18.0M | gitlab.com/catamphetamine/libphonenumber-js | SUS (too-new) | Approved, owner-named |
| tldts | npm | 2026-10-20 | 62.9M | github.com/remusao/tldts | SUS (too-new) | Approved `[ASSUMED]` choice; pin 7.4.19 |
| exceljs | npm | 2023-10 (4.4.0 tarball) | 11.8M | github.com/exceljs/exceljs | OK | Approved, owner-named |
| robots-parser | npm | 2023-02-21 | 3.6M | github.com/samclarke/robots-parser | OK | Approved `[ASSUMED]` choice |
| csv-parse | npm | 2026-09-25 | 12.7M | github.com/adaltas/node-csv | OK | Approved `[ASSUMED]` choice |
| typescript | npm | 2026-07-08 (7.0.2) | 196M | github.com/microsoft/TypeScript | OK | Approved at 6.0.3 |
| tsx | npm | 2026-09-20 | 64.5M | github.com/privatenumber/tsx | OK | Approved `[ASSUMED]` choice |
| zod | npm | 2026-10-12 | 221.6M | github.com/colinhacks/zod | SUS (too-new) | Approved `[ASSUMED]` choice; pin 4.6.7 |
| pino | npm | 2026-10-02 | 35.5M | github.com/pinojs/pino | SUS (too-new) | Approved `[ASSUMED]` choice |
| commander | npm | 2026-05-29 | 338M | github.com/tj/commander.js | OK | Approved `[ASSUMED]` choice |
| @turf/boolean-point-in-polygon | npm | 2026-08-03 | 2.7M | github.com/Turfjs/turf | OK | Approved `[ASSUMED]` choice |
| shapefile | npm | 2017-09-02 | 467k | github.com/mbostock/shapefile | OK | Fallback only (not installed by default) |
| @biomejs/biome | npm | 2026-10-24 | 11.9M | github.com/biomejs/biome | SUS (too-new) | Alternative only |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged [SUS]:** every SUS here is the seam's `too-new` signal (latest release < ~3 weeks old) on packages with millions of weekly downloads and their official repos. Mitigation: exact pins to the versions above. Optionally pin to the previous patch if it is more than 7 days old. Planner: add ONE `checkpoint:human-verify` in 01-01 before `pnpm install` covering the `[ASSUMED]`-choice packages (undici, tldts, robots-parser, csv-parse, tsx, zod, pino, commander, @turf/boolean-point-in-polygon). Do not add one per package.

## Architecture Patterns

### System Architecture Diagram

```
 pp.config.json (thresholds, terms, source switches, rate limits, DNS overrides)
        │
 pp pilot plan <area> ──► [Geo data: area → ZCTA list + centroids]  (committed data file)
        │                          │
        ▼                          ▼
  searches table (pending) ── maps/discover ──(Chromium, sequential, throttled)──► Google Maps
        │   ▲  block? ──► STOP run, record block, status=blocked (resume later)
        │   └── done/cards → listings (raw card text) ──► maps/detail (place page) ──► listing fields + capture_status
        ▼
  listings ──► pipeline/area-membership (address ZIP ∈ area? else coords → point-in-ZCTA → "approximate")
        │
        ├──► pipeline/non-painter filter (categories, name) ──► excluded: not a painting contractor
        │
        ├──► sites/crawl (core fetcher: robots, ≤1 rps/domain, disk cache; empty text → Chromium render)
        │        └─► extract: emails (mailto/text/JSON-LD/cfemail/[at]) · owner statements · 13VH no. · residential signals
        │                 └─► filters: filler/placeholder page, template names, shared hosts, MX check
        │
        ├──► registries: CA CSLB (files) · NJ HIC roster(file)→detail(session) · NJ principal search
        │                TX data.texas.gov (SoQL) → [Comptroller JSON: switch OFF] · BBB (fixture/where reachable)
        │
        ▼
  evidence table (every value: source, URL, captured_at, snippet, extractor@version, confidence, status)
        │
        ▼
  pipeline/merge (place id → phone → domain* → name+ZIP; *guards) ──► companies
        ▼
  pipeline/classify residential ──► pipeline/qualify (config thresholds) → qualified + reasons[]
        ▼
  pipeline/report ──► workbook.xlsx (6 tabs) + master.csv + qualified.csv
        ▼
  accuracy tools: sample (seeded, stratified) → blind truth CSV → compare → precision/recall per field+confidence
        └──► golden set (cached pages + truth JSON) ──► CI replay (GitHub Actions, no network)
```

### Recommended Project Structure
```
painter-leads/
├── package.json                 # packageManager: pnpm@9.15.9, engines node >=22.19
├── pnpm-workspace.yaml          # packages/*, apps/*
├── tsconfig.base.json           # TS 6: module nodenext, types ["node"], strict
├── vitest.config.ts             # projects: unit (parallel), db (maxWorkers 1), golden
├── pp.config.json               # THE one settings file (QUAL-04, D-36)
├── .github/workflows/ci.yml     # postgres:18 service, no network-dependent tests
├── data/                        # committed reference data with PROVENANCE.md (URLs, dates, sha256)
│   ├── geo/pilot-areas.json     # area → ZCTAs (+share), centroids
│   ├── geo/pilot-zcta.geojson   # polygons for area ZCTAs + neighbour ring
│   └── names/first-names.txt    # SSA (when obtained) ∪ Census 1990
├── fixtures/golden/<state>/<slug>/   # pages/*.html.gz, maps-card.json, truth.json (01-06 populates)
├── packages/
│   ├── core/src/{config,db/{schema.ts,client.ts},db/migrations,evidence,fetch,normalise,geo,stages,log}
│   ├── maps/src/{discover,detail,parse,blocks,throttle}
│   ├── registries/src/{cslb,nj-hic,nj-principal,tx-opendata,tx-comptroller,bbb,match}
│   ├── sites/src/{crawl,emails,owners,filler,residential,mx,names}
│   └── pipeline/src/{area,filter,merge,select,qualify,report,accuracy,run}
└── apps/cli/src/pp.ts           # collects `commands` from every package
```
Runtime data (NOT committed, gitignored): `PP_DATA_DIR` (default `D:\Dev-Cache\painter-leads`, which is short and survives worktree deletion), holding `pages/ab/cd/<sha256>.html.gz`, `downloads/` (CSLB, NJ rosters), `runs/<run-id>/` (xlsx/csv). `[ASSUMED: path choice]`

### Pattern 1: Evidence row per value (ENR-06, REP-03)
**What:** Never write a "company.email" column directly. Every candidate value becomes an `evidence` row. The company's displayed value is *selected* from accepted evidence by a deterministic policy, so a later rejection (registry conflict, template name) changes the selection without losing history.
Suggested columns `[ASSUMED: names are the foundation plan's call]`: `id, company_id, listing_id, field, value, value_norm, source_type, source_url, page_sha256, captured_at, snippet, extractor, extractor_version, confidence (high|medium|low), status (accepted|rejected|needs_review), reject_reason, corroborated_by (evidence ids)`.
- Agreement rule (D-22): when two evidence rows for `owner_name` from *independent* `source_type`s have equal `value_norm`, both are raised to `high` and linked through `corroborated_by`. "Independent" means a different source family: a website plus its own BBB copy is independent, but two pages of the same website are not.
- Snippet: store at most ~300 chars around the match, from visible text (after script/style removal).

### Pattern 2: Resumable search queue (DISC-04)
`searches(id, run_id, area, zip, term, url, status pending|running|done|blocked|failed, attempts, cards_found, new_place_ids, end_reached bool, block_signal, started_at, finished_at)` with a unique key on `(run_id, zip, term)`. The worker picks `status in (pending, running)` ordered by id. `running` rows left behind by a crash are re-run, which is idempotent because listings upsert on place id. On a block: mark the row `blocked`, write `run.stopped_reason`, and exit non-zero. `pp pilot resume <run>` continues. Place-page fetches are their own queue (`listing.detail_status`). Daily cap = counts in `request_log` for today, checked before every request.

### Pattern 3: Block and limited-view detection (DISC-03)
Check in this order after every navigation:
1. `page.url()` contains `/sorry/` → `blocked:sorry`.
2. A reCAPTCHA iframe or form is present (`iframe[src*="recaptcha"]`, `form#captcha-form`) → `blocked:captcha`.
3. Main frame shows the Google "unusual traffic" page. This is a *page-level* check: the URL is the sorry page or the document has no `div[role="feed"]`/place panel AND the body contains "unusual traffic". Never use it as a body-text match on a normal page (PROBES §1 shows "limited view" text on complete pages).
4. Limited view (per listing) = the place page loaded (name heading present) BUT there is no review-count aria-label and no reviews tab → set `rating/review_count = NULL`, `capture_status='limited_view'`, and queue a retry.
5. List view: a card with a name but no `span[role="img"]` star aria-label → `review_count NULL, capture_status='not_on_card'`. The place page may still fill it.
More than N consecutive limited-view listings (config, e.g. 5) is treated as a block signal: stop and back off. `[ASSUMED: threshold]`

### Pattern 4: Polite fetcher (core)
One `fetchPage(url, opts)` path: robots check (cached 24 h per RFC 9309; 4xx → allow all; 5xx/unreachable → disallow all) → per-host token bucket (`websites` 1 rps; registries from config) → undici `request` with per-host Agent (custom `lookup` when the host matches `dnsOverrides`, e.g. `*.texas.gov`) → cookie jar per *session object* (ASP.NET flows create an explicit session) → follow redirects manually with a cap (record the final URL) → decompress → store gzip on disk keyed by `sha256(method + url + body)` → `pages` row + `request_log` row (host, url, status, bytes, ms, outcome). Tests swap the dispatcher with `MockAgent`, or read the disk cache only (`offline: true` throws on a miss). `[CITED: rfc-editor.org/rfc/rfc9309 §2.3.1.3–2.4]`

### Pattern 5: Stage interfaces against fakes
Foundation defines `interface Stage<I, O> { name; run(ctx, input): Promise<O> }` for discover/detail/registries-match/site-enrich/classify/merge/qualify/report, plus in-memory fakes. Pipeline (01-05) wires real stages by name from a registry, so 01-02..01-04 can merge in any order. `[ASSUMED: shape]`

### Anti-Patterns to Avoid
- **Writing 0 for an uncaptured rating or review count.** Use NULL + `capture_status`. Qualification must report `review count not captured`, never "below 10".
- **Text-matching "limited view" or "unusual traffic" on normal pages:** both phrases can appear on complete pages.
- **CSS class selectors on Google Maps** (obfuscated, they change). Use roles, aria-labels and `data-item-id`.
- **Global `fetch` with an undici 8 dispatcher** (runtime error, verified).
- **Reading `C:\Users\bigsh\Downloads`** or the CRM file in any code or test (D-06).
- **Treating the registrable domain as company identity on shared hosts** (Pitfall 6).
- **Committing raw NJ roster files or CSLB personnel files.** They hold personal emails and home addresses. Commit only golden-company rows.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Public-suffix / registrable domain | Regex on dots | `tldts` (+ `allowPrivateDomains`) | `co.uk`, private suffixes like `wixsite.com` |
| Phone normalisation | Digit stripping | `libphonenumber-js` `parsePhoneNumberFromString(x,'US')` | Extensions, vanity numbers, validity |
| robots.txt | Prefix matching | `robots-parser` | `*`/`$` wildcards, longest-match Allow/Disallow |
| CSV/pipe parsing of 80 MB files | `split('\n')` | `csv-parse` streaming | Quoted fields, embedded newlines, BOM |
| Point-in-polygon | Ray casting | `@turf/boolean-point-in-polygon` + bbox prefilter | MultiPolygons, holes |
| HTML parsing | Regex | `cheerio` | Entity decoding, malformed markup |
| XLSX writing | Raw XML | `exceljs` | Shared strings, hyperlinks, widths |
| HTTP cookies | String concat | undici `getSetCookies` + a small per-session jar keyed by name/path | Expiry/path rules. ASP.NET only needs `ASP.NET_SessionId` + antiforgery cookies |
| ASP.NET form state | Hard-coded `__VIEWSTATE` | Parse every `input[type=hidden]` from the latest response with cheerio and resubmit all of them | VIEWSTATE/EVENTVALIDATION change per step |
| DNS MX | Shelling to nslookup | `node:dns` `Resolver.resolveMx` / `resolve4` (custom servers via `setServers`) | Built-in, configurable |

**Key insight:** The hard part of this phase is *rules that refuse to guess*. The infrastructure should be boring, tested library code, and the effort goes into rule tables, negative tests and the golden set.

## Geo Data (D-09, D-10) — verified this session

| File | URL | Size | Use |
|------|-----|------|-----|
| ZCTA→Place 2020 | `https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_place20_natl.txt` | 9,811,563 B | Austin (place GEOID `4805000` "Austin city"), San Diego (`0666000` "San Diego city") |
| ZCTA→County subdivision 2020 | `https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_cousub20_natl.txt` | 16,262,349 B | **Edison township `3402320230`**, Woodbridge township `3402382000`, Metuchen borough `3402345690` |
| Gazetteer ZCTA 2025 | `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip` | 952,026 B zip (2,369,685 B txt) | Centroids `INTPTLAT/INTPTLONG` |
| ZCTA polygons (preferred) | TIGERweb REST `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/7/query?where=ZCTA5 IN ('08817',…)&outFields=ZCTA5,GEOID,CENTLAT,CENTLON&outSR=4326&f=geojson` | ~30 KB/ZCTA | Returned GeoJSON Polygons for 08817/08820/08837 (90 KB) `[VERIFIED]`. Layer 7 is "2020 Census ZIP Code Tabulation Areas" |
| ZCTA polygons (fallback) | `https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip` | 66,655,314 B | Generalised national shapefile |
| (avoid) | `…/TIGER2025/ZCTA520/tl_2025_us_zcta520.zip` | 529,118,424 B | Too big for the pilot |

Verbatim headers `[VERIFIED: downloaded files]`:
- Relationship files (UTF-8 **with BOM**, pipe-delimited): `OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_PLACE_20|GEOID_PLACE_20|NAMELSAD_PLACE_20|AREALAND_PLACE_20|AREAWATER_PLACE_20|MTFCC_PLACE_20|CLASSFP_PLACE_20|FUNCSTAT_PLACE_20|AREALAND_PART|AREAWATER_PART` (the cousub file has the same shape with `_COUSUB_20` columns). Rows with blank ZCTA columns exist (place parts outside any ZCTA). Skip them.
- Gazetteer: `GEOID|GEOIDFQ|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG`

Pilot ZIP lists, computed with share = `AREALAND_PART / AREALAND_ZCTA5_20` (the fraction of the ZCTA's land inside the city) `[VERIFIED: computed this session]`:
- **Edison township:** 08817 (0.99), 08820 (0.99), 08837 (0.98). 08854 is a 0.01 sliver, so exclude it. Expansion per D-08: Woodbridge township ≥0.98: 07001, 07064, 07067, 07077, 07095, 08830, 08832, 08863. Metuchen borough: 08840 (0.89).
- **Austin city:** 53 ZCTAs touch it; 45 at ≥5%, **38 at ≥20%**, 32 at ≥50%.
- **San Diego city:** 61 touch it; 48 at ≥5%, **45 at ≥20%**, 42 at ≥50%.
- Recommendation: include a ZCTA when share ≥ 0.20 (configurable). Search volume ≈ 5 terms × (3 + 38 + 45) = **430 searches**. A listing whose ZIP is outside the list but inside a touching ZCTA counts in-area only when its coordinates fall inside the city's own ZCTA set. `[ASSUMED: threshold]`
- USPS PO-box-only ZIPs (e.g. 08818 Edison, 08899 Edison) are not ZCTAs. An address showing such a ZIP still maps to the city by its ZIP→city table entry. Treat it as in-area if the ZIP is in a small manual "PO-box ZIPs of the area" list in the area file. `[ASSUMED: those two ZIP codes; verify against USPS before use]`

**Point-in-ZIP (D-10):** a build-time command (`pp geo build`) fetches TIGERweb GeoJSON for the area ZCTAs plus every ZCTA intersecting the area bbox (ArcGIS `geometry=<envelope>&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects`, `[ASSUMED: standard ArcGIS REST params]`) and commits `data/geo/pilot-zcta.geojson`. Runtime does a bbox prefilter, then `booleanPointInPolygon([lng, lat], feature)`. Coordinates come from the Google link `!3d<lat>!4d<lng>` (PROBES §1). GeoJSON order is **[lng, lat]**.

## Name Data (D-18)

- **SSA national baby names**: `https://www.ssa.gov/oact/babynames/names.zip` (`contentUrl` on data.gov, licence `https://creativecommons.org/publicdomain/zero/1.0/`, dataset modified 2026-05-08) `[VERIFIED: catalog.data.gov page JSON-LD]`. Format: one `yobYYYY.txt` per year, lines `name,sex,count`, names with fewer than 5 occurrences suppressed `[CITED: SSA readme via data.gov/mirrors]`. **ssa.gov returns 403 "Access Denied" (Akamai) from this laptop and from WebFetch** `[VERIFIED]`. Plan: the orchestrator downloads it once from the Railway test service or a one-off CI step (a static official file download, not scraping, but the orchestrator decides since D-30 limits GitHub Actions use). Derive `first-names.txt` = names with total count ≥ 50 across birth years 1930–2005 (owners are roughly 20–95 years old) `[ASSUMED: thresholds]` and commit it with `data/PROVENANCE.md` (URL, date, sha256, derivation).
- **Fallback available now**: Census 1990 `https://www2.census.gov/topics/genealogy/1990surnames/dist.male.first` (1,219 lines) and `dist.female.first` (4,275 lines), fixed-width `NAME  freq  cumfreq  rank` `[VERIFIED: fetched]`. Union with SSA when obtained. Surname support: Census 2010 surnames `https://www2.census.gov/topics/genealogy/2010surnames/names.zip` (12,874,389 B) `[VERIFIED: HEAD 200]`. Use it as an optional surname plausibility check only (not required by D-18).

## Rule Patterns (D-17, D-18, D-24, D-25, D-19/D-21 matching)

All of these are proposals for 01-04/01-05 to implement as data tables (in config or code constants) with a test per rule. Unless marked otherwise they are `[ASSUMED]`: designed from the observed pages, then validated by the golden set.

### R1. Emails (sites)
Sources, in order of strength:
1. `a[href^="mailto:"]` (strip `?subject`, URL-decode)
2. JSON-LD `email` (strip `mailto:`)
3. `data-cfemail` / `href="/cdn-cgi/l/email-protection#<hex>"`: decode hex pairs, XOR each byte with the first byte, then **UTF-8 decode** the byte array (a naive char-by-char decode garbles non-ASCII) `[CITED: blog.jse.li/posts/cloudflare-scrape-shield; VERIFIED round-trip locally]`
4. Visible-text regex `\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b` (i) on text after removing script/style
5. Obfuscated: `name [at] domain [dot] com`, `name(at)domain(dot)com`, `name AT domain DOT com` (only with explicit brackets/parens around at/dot, to avoid prose false positives)
6. JS bundles: only when the domain equals the site domain (D-17).

Rejects:
- TLD that is an image/asset extension (`png|jpe?g|gif|webp|svg|css|js`), as in `logo@2x.png`
- placeholder domains: `example.(com|org|net)`, `email.com`, `domain.com`, `yourdomain.com`, `ejemplo.com`, `test.com`, `sentry.io`, `sentry-next.wixpress.com`, `wixpress.com`, `godaddy.com`, `*.godaddysites.com` defaults
- privacy proxies: `withheldforprivacy.com`, `contactprivacy.com`, `domainsbyproxy.com`, `whoisprivacyprotect.com`, `privacyprotect.org`, `anonymised.email`
- local-parts `noreply|no-reply|donotreply|webmaster|hostmaster|abuse|postmaster|example|test|yourname|name|email|user`
- web-designer credit: an address whose domain ≠ the site domain AND is not free-mail, OR one that appears inside a footer element containing "designed by|website by|powered by|developed by".

Free-mail list (allowed off-domain): gmail, yahoo, aol, hotmail, outlook, live, msn, icloud, me, comcast.net, verizon.net, att.net, sbcglobal.net, optonline.net, protonmail/proton.me, ymail, rocketmail, cox.net, charter.net, earthlink.net (NJ roster showed gmail/yahoo/aol/verizon; SOURCES-PROBE §1b).

MX check: `resolveMx`. Empty or `ENODATA` → `resolve4`/`resolve6` fallback (RFC 5321 implicit MX). **Null MX** (a single MX with exchange `""`/`"."`, RFC 7505) means the domain does not accept mail, so reject. Cache per domain. Free-mail domains skip the check.

Ranking (D-17): personal (local-part matches the owner's first name, last name, or first-initial+last) > role (`info|office|contact|hello|admin|estimates|sales|service`) > other.

### R2. Owner statements (sites)
Normalise whitespace in the visible text and split into sentences and short blocks (headings plus the next line count as one block, because "Brennan Price / Owner" team cards are heading + caption). Patterns (case-insensitive role words, capitalised names, `NAME` = 2–4 tokens of `[A-Z][a-z]+(?:[-'][A-Z][a-z]+)*`, optional middle initial `[A-Z]\.`):
- `(?:owner|founder|co-founder|president|ceo|proprietor)(?:\s+and\s+\w+)?\s*[,:–—-]?\s+NAME` ("Owner: John Smith")
- `NAME\s*[,–—-]\s*(?:the\s+)?(?:owner|founder|co-founder|president|ceo|proprietor)\b` ("John Smith, Owner")
- `(?:meet|i'm|i am|my name is)\s+NAME\s*[,–—-]?\s*(?:the\s+)?(?:owner|founder|president)` ("Hi, I'm Mike — owner": a single token is allowed only if a surname appears in the same block, otherwise store it as low)
- `founded\s+(?:in\s+\d{4}\s+)?by\s+NAME` and `NAME\s+(?:founded|started|established)\s+(?:the\s+company|COMPANY|it|\w+ painting)`
- `NAME\s+(?:is|has been)\s+the\s+(?:owner|founder|president)\s+of\s+COMPANY`
- JSON-LD: `founder` (Person or string), `employee[]`/`member[]` with `jobTitle` matching the role words.

Validation:
- first token ∈ first-name list
- last token is a capitalised alpha surname (≥2 chars, allow `O'`, `Mc`, `-`, and particles `de|del|de la|van|von|da|di` between)
- no token ∈ company-name tokens, the city/state list, painting words (`painting|painter|paint|coatings|pro|services|llc|inc|home|house`), or role words
- reject "Our Owner", "The Founder", ALL-CAPS strings longer than 3 tokens.

Reviewer mentions (block inside a review/testimonial element: `.testimonial`, `[itemprop=review]`, quotes followed by "– Name"): low confidence only.

### R3. Filler / placeholder page detector (sites) — corrects D-18's counter signal
Observed text on rutgerspainting.com/about-us (`page1.html`, 2026-10-25), shown verbatim: "tavissent sed ita fugiat arbitrantur, probant sunt quibusdam appellat. Possumus si fore do senserit eu duis quibusdam o do summis legam ex nostrud … Ita eiusmod si commodo ut culpa commodo se instituendarum, velit senserit sed familiaritatem aut ex quid si dolor o non dolor eiusmod … Meet Our Team Fernando Davidson Project Manager … Brennan Price Owner … Andrea Hamilton Office Manager". Counters in the same HTML: `<span class="elementor-counter-number" data-duration="2000" data-to-value="70" data-from-value="0" data-delimiter=",">0`.

Rules:
- **Latin filler**: per text block of ≥ 8 tokens, count tokens in a distinctive-Latin vocabulary. Include the classic lorem set (lorem, ipsum, dolor, sit, amet, consectetur, adipiscing, elit, eiusmod, tempor, incididunt, labore, dolore, magna, aliqua, veniam, quis, nostrud, exercitation, ullamco, laboris, nisi, aliquip, commodo, consequat, duis, aute, irure, reprehenderit, voluptate, velit, esse, cillum, fugiat, nulla, pariatur, excepteur, sint, occaecat, cupidatat, proident, sunt, culpa, officia, deserunt, mollit, laborum) plus the Cicero variant seen (quibusdam, possumus, senserit, summis, legam, arbitrantur, probant, appellat, instituendarum, familiaritatem, incurreret, fabulas, cernantur, admodum, quem, ita, eram, mandaremus, tavissent). Exclude English collisions (in, do, an, a, me, non when it starts a compound). Flag the block when ≥ 3 distinct vocabulary tokens make up ≥ 20% of its tokens. One flagged block on a page means the page yields NO owner names (D-18).
- **Demo markers**: `John Doe|Jane Doe|Your Name|Team Member|Lorem|Sample Page|Hello world!|Just another WordPress site|123 Main St|(555)|555-01\d\d|example\.com`, and team images named `team\d+\.(jpe?g|png)` uploaded before the site's other content (weak, corroborating only).
- **Zeroed counters**: count as a signal ONLY if the element has no animation-target attribute (`data-to-value|data-to|data-count|data-target|data-number|data-end`) with a non-zero value, and only as corroboration (never on its own).
- **Template names across sites**: in the pipeline, after crawling all companies, any `(first,last)` claimed as an owner on ≥ 2 sites with different registrable domains and not the same franchise → reject everywhere as `rejected: template name`. The same check applies to non-owner team names on demo-flagged pages.

### R4. Business-name normalisation (core) — registry matching
`norm(name)`:
1. NFKD and strip diacritics, then uppercase
2. `&`/`+` → ` AND `
3. split off DBA/trade-name parts on `\b(D/?B/?A|T/?A|A/?K/?A|TRADING AS|DOING BUSINESS AS)\b` and keep each side as an alias (NJ roster: `CHERRY PAINTING CONTRACTORS & HOME IMPROVEMENT T/A ANTHONY CHERRY`, SOURCES-PROBE §1b)
4. remove punctuation `.,'"()/-` (apostrophes deleted: `JOHN'S` → `JOHNS`)
5. drop a leading `THE`
6. drop trailing entity suffixes repeatedly: `LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC|PC|PLC`
7. collapse whitespace.

`core(name)` = `norm` minus generic trade words (PAINTING, PAINTERS, PAINT, CONTRACTOR(S), CONTRACTING, SERVICES, SERVICE, HOME, IMPROVEMENT(S), AND, CARPENTRY, DECORATING, PRO, PROS, PROFESSIONAL). Matching ladder:
- `norm` equal → strong if ZIP/city equal, else candidate
- `core` non-empty and equal → strong with the same ZIP, candidate otherwise
- `core` token containment (contains) → candidate only.

Person-name registrations (`ANTONIO DEVITA`) match through the owner-name path, never the company-name path. CSLB personnel/sole-owner names are fixed-width `LAST FIRST MIDDLE` (PROBES §2) → `First Last` with title-casing that respects `Mc/Mac/O'` `[ASSUMED: casing rules]`.

### R5. Residential classifier (sites + pipeline)
Signal table with weights; the output label is decided by rules, not by a summed score threshold alone:
- **Commercial-positive phrases**: "commercial painting", "commercial painter", "commercial projects", "industrial", "warehouse", "office buildings", "retail spaces", "tenant improvement", "property management", "property managers", "HOA", "homeowners association(s)", "multi-family", "apartment complexes", "new construction", "general contractors", "facilities", "restaurants", "schools", "churches" (as service targets), "residential and commercial", "residential & commercial", "commercial and residential". A nav menu item or service page titled Commercial counts strongly.
- **Residential-positive**: "interior painting", "exterior painting", "house painting", "home painting", "cabinet painting/refinishing", "deck staining", "fence staining", "homeowners", "your home", "residential painting".
- **Negations** (override commercial hits in the same sentence): `(we|i)\s+(do not|don't|no longer)\s+(do|offer|provide|take on)\s+(any\s+)?commercial`, `residential\s+only`, `exclusively\s+residential`, `only\s+(do\s+)?residential`, `no\s+commercial`.
- **Name**: Commercial|Industrial|Coatings|Epoxy|Contracting Group → commercial-positive (D-25).
- **Google category**: "Commercial painter" → commercial-positive. "House painter" → residential-positive. `[ASSUMED: exact category strings; record what the pilot actually sees]`

Decision:
- any strong commercial signal not negated + any residential signal → `residential_and_commercial`
- commercial only → `commercial_only`
- residential signals ≥ 2 distinct, zero commercial, website crawled successfully (≥ 2 pages incl. a services page or the home page with a service list) → `residential_only`
- otherwise `unclear` (no website, JS-only page that failed to render, too little text).

Always store the matched signals with page URL and snippet. Watch for "Commercial" inside generic SEO footers listing *all* services of a site-builder template. The golden set will show how often that happens.

### R6. Non-painter filter (pipeline)
Keep when any category ∈ {Painter, Painting, House painter, Painting contractor, Commercial painter, Interior painter, Exterior painter …} or (name ~ `paint|coating` AND category ∈ contractor-types {Contractor, General contractor, Handyman, Drywall contractor, Remodeler, Home improvement contractor, Construction company}). Mark `not a painting contractor` with the deciding category when categories ∩ {Paint store, Paint manufacturer, Art studio, Art school, Art center, Painting lessons/Paint and sip studio (e.g. "Painting with a Twist"), Auto body shop, Auto painting, Car detailing, Mural artist/Artist, Wallpaper store, Wallpaper installer, Interior designer} ≠ ∅ and no painter category. Observed San Diego noise: "Wallpaper installer 1, Interior designer 1" (PROBES §1). `[ASSUMED: category strings beyond those observed]`

### R7. Franchise flag (pipeline)
Brand list in config: CertaPro Painters, Five Star Painting, Fresh Coat Painters, WOW 1 DAY PAINTING, ProTect Painters (seed list; add brands seen in the pilot listings). Match on name prefix or website domain (`certapro.com`, `fivestarpainting.com`, `freshcoatpainters.com`, `wow1day.com`, `protectpainters.com`). `[ASSUMED: brand/domain list; verify from pilot listings]`

## Common Pitfalls

### Pitfall 1: Silent limited view stored as zero
**What goes wrong:** Review counts are missing for flagged traffic and the parser yields 0, so companies wrongly fall below 10 reviews.
**How to avoid:** Every numeric Maps field is nullable and has a `capture_status`. Parse failures → NULL. Qualification has an explicit `not captured` reason. Write a test with a card fixture that has no star aria-label.
**Warning signs:** A run where the share of NULL review counts rises above the baseline 2/120 (PROBES §1).

### Pitfall 2: playwright-core caret range
**What goes wrong:** `^1.63.0` resolves to 1.64.1, which looks for `chromium-1248`, and launch fails with "Executable doesn't exist".
**How to avoid:** Pin `playwright-core: "1.63.0"` exactly. Put a startup check in maps that logs `chromium.executablePath()` and fails fast.

### Pitfall 3: UA/version mismatch
The probe UA claimed `Chrome/141` while the binary is Chromium 153.0.8010.12 (`browserVersion` in 1.63.0 browsers.json). Client hints (`sec-ch-ua`) then disagree with the UA string, which is a cheap bot signal. **Derive the UA from `browser.version()`** (`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36`). Never fake a different version. `[VERIFIED: probe script line + browsers.json; risk ASSUMED]`

### Pitfall 4: undici 8 + global fetch
Verified runtime failure. Lint rule: forbid `globalThis.fetch`/bare `fetch(` outside core's fetcher (`no-restricted-globals`).

### Pitfall 5: Custom `lookup` must honour `options.all`
Node's `net` calls lookup with `{"hints":0,"all":true}` (verified), so returning a single address breaks connection setup. Return `[{address, family}]` when `all` is set. On this laptop `data.texas.gov` fails default DNS with `EAI_AGAIN` and resolves via 1.1.1.1 (verified). Make overrides config-driven (`dnsOverrides: { "*.texas.gov": ["1.1.1.1","8.8.8.8"] }`) so Railway can drop them.

### Pitfall 6: Shared hosts break domain logic
`tldts` default gives `godaddysites.com`, `business.site`, `weebly.com`, `google.com`, `facebook.com`, `linktr.ee` as registrable domains (verified). A shared-host denylist in core (`google.com` for sites.google.com, `facebook.com`, `instagram.com`, `linktr.ee`, `business.site`, `godaddysites.com`, `weebly.com`, `wixsite.com` without private, `square.site`, `yelp.com`, `nextdoor.com`, `homeadvisor.com`, `angi.com`, `thumbtack.com`, `houzz.com`, `bbb.org`) means: (a) no domain-based merge, (b) emails on that domain are not "company-domain" emails, (c) the "website" column still shows the URL. Use `allowPrivateDomains: true` so `jdoe.wixsite.com` is distinct.

### Pitfall 7: Merge ladder over-merging
D-26's phone and domain steps can join different Google place IDs (franchise locations sharing a brand domain or call-center number; two GBP listings of one firm). Within D-26: domain merge is skipped when either side is `franchise` or on a shared host. Phone merge of two *different* place IDs requires the same domain or the same normalised name. Otherwise record `possible_duplicate_of` for review. Report how many merges each rung produced. `[ASSUMED: guard design within D-26]`

### Pitfall 8: Elementor counters are not placeholders
See R3: the static `0` with `data-to-value` is real content.

### Pitfall 9: ASP.NET WebForms flows (NJ HIC, NJ principal, CSLB data portal)
- Resubmit ALL hidden inputs from the *latest* response, and the exact submit button `name=value`.
- Keep one cookie jar per flow. Detail URLs die without the session (HTTP 500).
- Sessions expire (ASP.NET default 20 min `[ASSUMED]`), so do not interleave flows in one session.
- Radio postbacks need `__EVENTTARGET` set to the control name (njportal).
- Detect error pages by content (`Runtime Error`), not only status.
- Search is "starts with" on both NJ and TX official search, so match from downloaded rosters/open data, not the search box (SOURCES-PROBE §7.3).
- Run ≤ 1 flow at a time per host with multi-second gaps.

### Pitfall 10: Excel/CSV output traps
- **ZIP leading zeros**: NJ ZIPs start with 0 (08817). Write ZIP as a *string* cell in exceljs (`numFmt '@'` or string value). CSV opened by double-click in Excel drops the zeros, so the xlsx is the human deliverable and the CSV is for data import `[ASSUMED: owner may want otherwise]`.
- **Formula injection** (OWASP CSV injection): scraped values starting with `= + - @` (and tab/CR) must be prefixed with `'` in CSV. E.164 phones start with `+`, so show phones in national format `(512) 373-0002` in report columns and keep E.164 in the DB.
- UTF-8 **BOM** on CSV so Excel shows accents.
- Hyperlinks: Excel caps hyperlinks per sheet (~65,530 `[ASSUMED]`). That is fine for the pilot (Sources tab ≈ 15 values × ≤1,200 companies). For Phase 2 statewide, write source URLs as plain text in Sources.
- Cell text limit is 32,767 chars, so truncate snippets.

### Pitfall 11: Windows paths
- Cache filenames from URLs contain `? : * |`, so always use sha256 names with a two-level fan-out.
- Keep `PP_DATA_DIR` short.
- Worktree dirs short (`wt-maps`, not long names) because pnpm paths cross 260 chars.
- Git CRLF: add `.gitattributes` `* text=auto eol=lf`, and binary for `*.gz *.xlsx`. Golden HTML fixtures must be stored gzip/binary so CRLF conversion never alters bytes (hashes must stay stable).
- `path.join` vs URL: never build cache paths from URL parts.

### Pitfall 12: BOM and trailing pipes in official files
Census rel files start with a UTF-8 BOM (`EF BB BF` verified), so pass `bom: true`. The NJ roster header ends with `|`, so csv-parse produces an empty `""` column key (verified: 19 keys, last `""`). Use `columns: h => h.map(x => x === '' ? false : x)` (verified: 18 keys, 62 rows).

### Pitfall 13: data.texas.gov field names
API field names differ from display names, and the NAICS column's field name is **`_621111`** (verified from `/api/views/9cir-efmm.json`). Fields: `taxpayer_number, taxpayer_name, taxpayer_address, taxpayer_city, taxpayer_state, taxpayer_zip, taxpayer_county_code, taxpayer_organizational_type, record_type_code, responsibility_beginning_date, secretary_of_state_sos_or_coa_file_number, sos_charter_date, sos_status_date, sos_status_code, right_to_transact_business_code, current_exempt_reason_code, exempt_begin_date, _621111`. Rows updated 2026-10-24T08:26:58Z. SoQL: `$where=taxpayer_zip='78701' AND upper(taxpayer_name) like '%PAINT%'` `[ASSUMED: exact SoQL quoting; test against a recorded fixture]`.

### Pitfall 14: Wrong Railway account
The local `railway` CLI (5.41.2) is logged into the Naseeha account (owner memory). The datacentre test (D-30) must use the owner's NEW account through a project-scoped token in the shell (`RAILWAY_TOKEN`), set only for that command, after he provides it. Never run `railway up/link` in this repo with the ambient login. Workers are forbidden from Railway commands (D-35).

### Pitfall 15: Raw-page storage and PII
- Cached pages, NJ rosters (personal emails/home addresses of sole proprietors), CSLB personnel files and BBB pages are real personal data. Keep them in `PP_DATA_DIR` (outside the repo, gitignored).
- Golden fixtures commit only the pages of the ~150 checked companies (public business pages) plus the extracted registry rows for those companies, never whole rosters.
- Never log full roster rows.
- The repo stays private.

### Pitfall 16: Statistical honesty of "98%"
50 companies per state gives few owner names per state. With 0 errors in n values, the 95% upper error bound is ≈ 3/n (rule of three), so proving ≤ 2% error on one field needs ≥ ~150 error-free values. Computed Wilson 95% intervals: 147/150 → [94.3%, 99.3%]; 392/400 → [96.1%, 99.0%]; 29/30 → [83.3%, 99.4%].
**How to avoid:** Report point precision AND the Wilson interval per field, per confidence level, pooled across states and per state. State plainly that per-state-per-field numbers are indicative. `[VERIFIED: computed]`

### Pitfall 17: Rating/review drift between capture and check
Review counts grow and ratings change. The truth must be collected soon after capture, and the compare script needs a drift rule. Recommended: review count correct if `live ≥ captured` and `live - captured ≤ max(2, 3%)`. Rating correct if equal, or equal to the live value within 0.1 when review count also changed. Also record the check date. `[ASSUMED: owner/orchestrator to confirm tolerance]`

### Pitfall 18: Throughput vs daily cap
430 searches × (~30–36 s per search incl. scroll, PROBES §1, + 10–20 s pause) ≈ 5–6 h. Place pages at ≤ ~1,200 × (load + 4–8 s) ≈ 3–5 h. The pilot needs ~2 days of throttled runtime under a daily cap. Order the work as Edison first (smallest, validates the end-to-end), then Austin, then San Diego. Within a city, run term 1 over all ZIPs before term 2, so a block mid-run still leaves full-area coverage for the best term. `[ASSUMED: ordering; yield data decides Phase 2]`

### Pitfall 19: Search query form
PROBES verified `https://www.google.com/maps/search/<query>/?hl=en&gl=us` with `"<term> in <City>, <ST>"`. A per-ZIP query form has NOT been probed. Options: `"<term> <ZIP>"` text, or the city query with an `@<lat>,<lng>,<zoom>z` viewport from the Gazetteer centroid. Use one of the ≤3 dev smoke searches (D-15) to confirm the chosen form returns local results. Log the final URL Google lands on. `[ASSUMED]`

### Pitfall 20: GitHub Actions limits
The org `my-stuffff` is on the **free** plan (verified via `gh api`). Private-repo Actions minutes are limited (≈2,000 min/month on Free `[ASSUMED]`). Keep CI lean: one job, pnpm store cache, no browsers, golden replay offline. The repo `my-stuffff/painter-leads` does **not exist yet** (verified), so 01-01 or the orchestrator must create it (`gh repo create my-stuffff/painter-leads --private`). Workers are forbidden to push (D-35), so creation and the first push are orchestrator steps.

## Code Examples

### Custom DNS per host with undici 8 (verified pattern)
```typescript
// Source: verified locally 2026-10-25 (undici 8.12.3, Node 22.22.2)
import { Agent, request } from 'undici';
import { Resolver } from 'node:dns';

export function agentWithDns(servers: string[]): Agent {
  const r = new Resolver();
  r.setServers(servers); // e.g. ['1.1.1.1', '8.8.8.8']
  const lookup = (host: string, opts: { all?: boolean }, cb: Function) =>
    r.resolve4(host, (err, addrs) => {
      if (err) return cb(err);
      if (opts?.all) return cb(null, addrs.map((address) => ({ address, family: 4 }))); // net passes all:true
      cb(null, addrs[0], 4);
    });
  return new Agent({ connect: { lookup: lookup as any } });
}
// use: await request(url, { dispatcher: agentWithDns(['1.1.1.1']) })  -- NOT globalThis.fetch
```

### Cloudflare email decode (verified round-trip)
```typescript
// Source: algorithm per blog.jse.li/posts/cloudflare-scrape-shield; UTF-8 step per Cloudflare email-decode.min.js
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  const bytes = Buffer.alloc(hex.length / 2 - 1);
  for (let i = 2; i < hex.length; i += 2) bytes[i / 2 - 1] = parseInt(hex.slice(i, i + 2), 16) ^ key;
  return bytes.toString('utf8');
}
// sources: $('[data-cfemail]').attr('data-cfemail'), and href '/cdn-cgi/l/email-protection#<hex>'
```

### Drizzle migrate (0.45.4 API, verified from type defs)
```typescript
// drizzle-orm/node-postgres/migrator.d.ts: migrate(db, config: { migrationsFolder: string; migrationsTable?: string; migrationsSchema?: string })
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migrate(drizzle(pool), { migrationsFolder: new URL('./migrations', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
// generate: drizzle-kit generate --config packages/core/drizzle.config.ts --name pilot_schema
```
`fileURLToPath(new URL('./migrations', import.meta.url))` is the cleaner Windows-safe form. Use it.

### Test DB per worker (D-29)
```typescript
// vitest globalSetup for the `db` project
// 1) read TEST_DATABASE_URL; refuse unless db name matches /^painter_leads_test_[a-z0-9_]+$/
// 2) connect to 'postgres' db, CREATE DATABASE if missing
// 3) run migrate() once; tests TRUNCATE ... RESTART IDENTITY CASCADE in beforeEach
// vitest.config.ts projects: { name:'db', include:['**/*.db.test.ts'], maxWorkers:1, isolate:false } (Vitest 4+ option names)
```
`[CITED: v4.vitest.dev/guide/migration: poolOptions removed; singleFork → maxWorkers: 1 + isolate: false; workspace → projects]`

### ExcelJS hyperlink + text ZIP (verified round-trip)
```typescript
const ws = wb.addWorksheet('Qualified', { views: [{ state: 'frozen', ySplit: 1 }] });
ws.columns = [{ header: 'Company', key: 'company', width: 32 }, { header: 'ZIP', key: 'zip', width: 8, style: { numFmt: '@' } },
              { header: 'Google profile link', key: 'gurl', width: 18 }];
ws.addRow({ company, zip: '08817', gurl: { text: 'Open', hyperlink: profileUrl } });
ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columnCount } };
```

### NJ roster parse (verified on cached Data.txt)
```typescript
import { parse } from 'csv-parse';
createReadStream(file).pipe(parse({ delimiter: '|', bom: true, relax_quotes: true,
  columns: (h: string[]) => h.map((x) => (x === '' ? false : x)) })); // drops trailing-pipe column
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| vitest `workspace` file, `poolOptions.*.singleFork` | `projects` in config; `maxWorkers: 1` + `isolate: false` | Vitest 3.2 / 4.0 | Plans must use new option names `[CITED: v4.vitest.dev migration]` |
| Vitest 4 defaults | Vitest 5: `clearMocks: true` default, `vi.mock` inside functions throws, json/junit reporters write files, worker ids start at 1, configs not searched in parent dirs | 5.0 (2026-09-03) | Each package needs its own config, or one root config with `projects` `[CITED: vitest.dev/guide/migration]` |
| TS 5 defaults | TS 6: `strict` true, `types: []`, `module esnext`, `target es2025`, `baseUrl` deprecated, `moduleResolution node10` deprecated, `esModuleInterop` can't be false | TS 6.0 (2026-03) | tsconfig base must set `"types": ["node"]` and `module/moduleResolution: "nodenext"` `[CITED: devblogs.microsoft.com/typescript/announcing-typescript-6-0]` |
| Drizzle 0.x journal folder | Drizzle 1.0 (rc) per-migration folders | 1.0 rc | Stay on 0.45.x. Online docs now describe 1.0, so verify API against installed `.d.ts` |
| pnpm runs all postinstalls | pnpm ≥10 requires `onlyBuiltDependencies` | pnpm 10 | Not an issue on 9.15.9. Note it for any upgrade |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Package choices undici/tldts/robots-parser/csv-parse/tsx/zod/pino/commander/turf (not owner-named) | Stack | Low (all mainstream). Needs the one install checkpoint |
| A2 | ZCTA inclusion threshold share ≥ 0.20 | Geo | Misses edge listings or wastes searches. Tune from yield data |
| A3 | PO-box ZIPs 08818/08899 for Edison | Geo | Wrong in-area decision for a few listings |
| A4 | TIGERweb envelope-query params for the neighbour ring | Geo | Fallback: cb_2020 shapefile |
| A5 | SSA derivation thresholds (count ≥ 50, years 1930–2005) | Names | Too strict drops rare real names (blank, not wrong) |
| A6 | All rule vocabularies R1–R7 (placeholder domains, Latin list, role words, signals, categories, franchise brands) | Rules | Precision/recall. The golden set measures it |
| A7 | Limited-view streak threshold (5) as a block signal | Pattern 3 | Stops too early/late |
| A8 | Drift tolerance for review counts/ratings in the compare script | Pitfall 17 | Mis-scored accuracy. Owner/orchestrator should confirm |
| A9 | ZIP query form for Maps searches | Pitfall 19 | Off-area results. Confirm with a smoke search |
| A10 | ~2,000 Actions min/month on the Free org plan; ~65,530 hyperlinks/sheet Excel limit; ASP.NET 20-min sessions | Pitfalls | Low |
| A11 | xlsx = human deliverable, CSV = import format (ZIP zeros) | Pitfall 10 | Owner may expect CSV to open cleanly in Excel |
| A12 | `PP_DATA_DIR` default `D:\Dev-Cache\painter-leads`, `@pp/*` package scope | Structure | Cosmetic |

## Open Questions

1. **Who downloads the SSA file, and from where?**
   - Known: CC0, URL verified, blocked from this laptop and from WebFetch.
   - Recommendation: the orchestrator fetches it on the Railway test service when D-37's account exists. Until then, ship the Census 1990 lists (enough for the pilot's common names), and log names rejected only for "not in list" so the gap is measurable.
2. **Compare-script drift tolerance and "unverifiable" values.**
   - Recommendation: when the checker cannot find a value the system filled, a second (non-blind) adjudication pass shows the system's evidence URL. A value confirmed there counts correct; a dead or unclear source counts wrong (accuracy over coverage).
3. **Datacentre test without the Railway account (D-37).** Already ruled: carry to Phase 3. The Railway service image would be `mcr.microsoft.com/playwright:v1.63.0-noble` (tag exists, verified), so Chromium matches 1.63.0.
4. **Texas Comptroller switch (D-36).** Ships OFF. Planner: 01-03 builds and tests the adapter from recorded JSON (the SOURCES-PROBE samples), and 01-06 reports coverage off vs on only if the owner rules in time.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | all | ✓ | 22.22.2 | — |
| pnpm (corepack) | workspaces | ✓ | shim → 9.15.9; corepack 0.34.6 | `corepack pnpm` |
| Postgres service :5432 | DB | ✓ | 18.4 (postgres/postgres; no `painter_*` DBs yet) | — |
| Chromium for playwright-core 1.63.0 | maps | ✓ | `chromium-1243`, `chromium_headless_shell-1243`; `PLAYWRIGHT_BROWSERS_PATH` set | — |
| git / gh | OPS-01 | ✓ | git 2.54.0; gh 2.92.0 logged in (scopes repo, workflow) | — |
| GitHub org `my-stuffff` | OPS-01 | ✓ (free plan) | repo not created | orchestrator creates |
| Docker | — | ✗ | — | not needed (CI uses the `postgres:18` service; tag exists, updated 2026-10-21) |
| Railway CLI | D-30 | ✓ but WRONG account | 5.41.2 | new-account token from owner (Pitfall 14) |
| Public DNS for *.texas.gov | registries | ✓ via 1.1.1.1 | default DNS fails `EAI_AGAIN` | config `dnsOverrides` |
| ssa.gov | names | ✗ (403 Akamai) | — | Census 1990 names now; SSA via Railway later |
| bbb.org | ENR-05 | ✗ from laptop (403) | — | fixtures from Railway; `blocked` status locally |
| www2.census.gov / tigerweb | geo | ✓ | — | — |
| Disk | cache | ✓ | D: 180 GB free | — |

**Missing with no fallback:** none that blocks the phase. The datacentre test and the BBB live run depend on D-37.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 5.0.5 (root `vitest.config.ts` with `projects`) |
| Config file | none yet: 01-01 creates it (Wave 0) |
| Quick run command | `corepack pnpm vitest run --project unit` (target < 30 s; no network, no DB) |
| DB tests | `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/painter_leads_test_<slug> corepack pnpm vitest run --project db` |
| Golden replay | `corepack pnpm vitest run --project golden` (reads `fixtures/golden/**`, offline) |
| Full suite | `corepack pnpm -r typecheck && corepack pnpm vitest run` |

Network guard: a vitest setup file installs an undici `MockAgent` with `disableNetConnect()` as the global dispatcher for core's fetcher, and forbids `chromium.launch` unless `PP_LIVE=1`, so CI provably never touches Google or any site.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DISC-02 | Card + place-page parsers extract all fields from saved HTML/aria fixtures; place id/CID/lat/lng from URL | unit (fixtures) | `vitest run --project unit packages/maps` | ❌ Wave 0 (01-02 records fixtures from ≤3 smoke searches) |
| DISC-03 | `/sorry/`, captcha, unusual-traffic and limited-view fixtures → correct status; missing count → NULL not 0 | unit | same | ❌ |
| DISC-04 | Queue resumes: kill mid-run → rerun skips `done`, retries `running`/`blocked`; daily cap enforced | db | `vitest run --project db packages/maps` | ❌ |
| QUAL-01 | Category table → keep/exclude with deciding category | unit | `… packages/pipeline` | ❌ |
| QUAL-02 | Residential rules on fixture pages incl. negations and "residential and commercial" | unit + golden | `… --project golden` | ❌ |
| QUAL-03 | Qualify returns every reason; NULL rating → "not captured" reason | unit (table-driven) | `… packages/pipeline` | ❌ |
| QUAL-04 | Changing `pp.config.json` thresholds changes results with no code change; invalid config rejected by zod | unit | `… packages/core` | ❌ |
| ENR-01/07 | Email extractor on the 5 probed sites (johnspaint, njpaintingco, bartonsprings, wepainttexas JSON-LD-only, rutgers none) + cfemail + `[at]` + bundle placeholders rejected + null-MX rejected (mocked resolver) | unit | `… packages/sites` | ❌ (probe HTML exists in scratch for re-capture) |
| ENR-02 | Owner patterns: Barton Springs "Jeff London – Founder"/"Breanna Rene – Owner" accepted; Rutgers "Brennan Price Owner" rejected (filler); Elementor counter not a signal; template-name rule | unit + golden | same | ❌ |
| ENR-03 | CSLB: phone/name/ZIP ladder; LAST FIRST MIDDLE → First Last; truncated personnel file refused | unit (small fixture CSVs) | `… packages/registries` | ❌ |
| ENR-04 | NJ roster parse (trailing pipe), 5-step flow replay with MockAgent (hidden fields resubmitted, session cookie kept), detail `span#owner_name`; TX open-data SoQL builder + Comptroller JSON officers vs corporate agent | unit (MockAgent) | same | ❌ |
| ENR-05 | BBB JSON-LD `employee[]` parse from captured fixtures; 403 → `blocked` | unit | same | ❌ |
| ENR-06 | Evidence API: every insert has required provenance (DB NOT NULL); agreement raises to high; registry conflict rejects website claim | db | `… --project db packages/core` | ❌ |
| REC-01 | Merge ladder incl. franchise/shared-host guards; evidence preserved | unit + db | `… packages/pipeline` | ❌ |
| REP-01/02/03 | Generate workbook from a seeded DB; read back with exceljs: 6 tabs, headers exact (D-27), ZIP text, hyperlinks, every filled cell has a Sources row; CSV BOM + injection guard | db | `… --project db packages/pipeline` | ❌ |
| ACC-01 | Sampler: seeded, stratified (≥25 qualified when available), reproducible; compare script scores correct/wrong/missed/drift with Wilson CI | unit | `… packages/pipeline` | ❌ |
| ACC-02 | Golden replay: extractor/classifier/matcher outputs on golden pages equal truth.json; a deliberately broken rule makes it fail (prove fail AND pass) | golden | `… --project golden` | ❌ (populated in 01-06) |
| ACC-03 | Fill-rate query per state (owner/email/phone/website, overall + qualified) | db | `… --project db` | ❌ |
| OPS-01 | CI green on GitHub Actions with `postgres:18` service | CI | `gh run list --repo my-stuffff/painter-leads` | ❌ (repo not created) |

Manual-only: the live pilot run, blind hand-check data collection (a human-style checker reading live sites), the datacentre test, and the owner opening the workbooks (human-verify checkpoint). These are evidenced in `01-PILOT-REPORT.md`.

### Accuracy measurement design (ACC-01/02/03)
1. **Sample**: per state, after the run is frozen (`run_id`), draw with a seeded PRNG (record the seed in the sample file): `min(25, #qualified)` from qualified + the rest from non-qualified *painting* companies. Non-painters are excluded from the sample except ≤5 to check the filter `[ASSUMED]`. Export `sample.csv` with ONLY `sample_id, company name, Google profile link`.
2. **Blind truth collection**: the checker fills `truth.csv` (sample_id, field, value, source URL, checked_at, notes) for fields: name, phone, website, email(s), owner name + title, rating, review count, address/ZIP, category, residential status, painter yes/no. "Not findable" is an explicit value.
3. **Compare** (`pp accuracy compare <run> truth.csv`): normalise both sides (phone E.164, email lowercase, URL → host + path without trailing slash, names case-folded with middle initials ignored, ZIP 5-digit), then classify each (company, field):

   | system \ truth | value | not findable |
   |---|---|---|
   | value equal | correct | **unverifiable** → adjudication |
   | value different | wrong | — |
   | blank | missed (recall) | both blank |

   Precision = correct / (correct + wrong) per field, per confidence level, per state and pooled, with Wilson 95% CI. Recall = correct / (correct + wrong + missed).
4. **Fix loop**: every wrong or missed value gets a cause tag (extractor, rule, matcher, source stale, checker error). Fixes go through fresh workers, then the run is re-scored on the same sample (no re-sampling). The final numbers are reported with the fix history.
5. **Golden set**: copy the cached pages (gz) for each sampled company plus its Maps card JSON and registry rows into `fixtures/golden/<state>/<slug>/`, with `truth.json` (adjudicated values). Replay tests assert the extractor outputs equal the truth for every field the system filled correctly, and stay blank where truth is "not findable". A rule change that flips any golden value fails CI.

### Sampling Rate
- **Per task commit:** `corepack pnpm vitest run --project unit` (affected package path)
- **Per wave merge:** full suite incl. `db` and `golden` + typecheck
- **Phase gate:** CI green on GitHub Actions + `01-PILOT-REPORT.md` accuracy table meets ≥98% (point estimate, with CI shown) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `vitest.config.ts` (projects unit/db/golden), `test/setup-network-guard.ts`, `test/global-setup-db.ts`
- [ ] `.github/workflows/ci.yml` with `postgres:18` service + `pnpm/action-setup@v6` + `actions/setup-node@v7` (latest tags verified: checkout v7.0.1, setup-node v7.1.0, action-setup v6.1.0, cache v6.1.0)
- [ ] `fixtures/` layout + README (golden populated in 01-06)
- [ ] Re-capture the 5 probe websites into fixtures through the real fetcher (probe HTML exists at `D:\Temp\claude\C--Users-bigsh\17a31d7e-077b-4267-94f8-04d95989f65e\scratchpad\probe\sites\` as reference; it contains personal data, so do not commit raw roster files)

## Security Domain

`security_enforcement: true`, ASVS level 1.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (no app this phase) | — |
| V3 Session Management | no (outbound ASP.NET sessions are client-side only) | — |
| V4 Access Control | no | — |
| V5 Validation/Sanitisation/Encoding | **yes** | zod for config/truth CSV/registry JSON; cheerio (no eval) for HTML; CSV/xlsx formula-injection prefixing; snippet truncation |
| V6 Cryptography | minimal | sha256 via `node:crypto` for cache keys only |
| V7 Errors/Logging | yes | request log without PII bodies; no secrets in logs |
| V8 Data Protection | **yes** | PII (rosters, personnel, cached pages) outside the repo; golden = public business pages only; never read `Downloads` (D-06) |
| V10 Malicious code / supply chain | yes | exact pins, lockfile, legitimacy audit, single install checkpoint |
| V12 Files | **yes** | cache paths from sha256 only (no URL-derived paths → no traversal); size caps on downloads (CSLB 78 MB OK, cap e.g. 200 MB) |
| V13 API/Web service (outbound) | **yes** | SSRF-style guard: the crawler follows URLs from Google listings and redirects, so refuse private/loopback/link-local targets (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl. cloud metadata, ::1, fc00::/7) after DNS resolution. This matters on Railway |
| V14 Config | yes | `.env` gitignored; Railway token only in the shell for D-30; no secrets in `pp.config.json` |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| CSV/Excel formula injection from scraped text | Tampering | Prefix `'` for `= + - @ \t \r` leading chars; phones shown in national format |
| SSRF via listing website / redirect to internal IP | Information disclosure | Resolve-then-check IP ranges in the custom `lookup`; cap redirects (5); http/https only |
| Decompression/size bombs from sites | DoS | Max body size per page (e.g. 5 MB), max decompressed size (undici `decompress` `maxSize` option exists, verified in types) |
| Malicious HTML/JS in cached pages | Elevation | Never render cached pages in a privileged context; Chromium re-fetch for JS sites runs with no extensions and no file access, and only for the target URL |
| PII leakage via fixtures/commits | Information disclosure | `.gitignore` for data dirs; pre-commit check refusing files > 1 MB or matching `Data.txt`/`*Personnel*` |
| Supply-chain (fresh releases) | Tampering | Exact pins; one human-verify checkpoint; no postinstall scripts present (verified) |

## Sources

### Primary (HIGH confidence, verified this session)
- npm registry (`npm view`, `npm pack`): versions, engines, peers, dist-tags, browsers.json for playwright-core 1.63.0/1.64.1
- Local installs and tests in the scratchpad: undici 8 custom lookup + global-fetch incompatibility; exceljs round-trip; tldts private domains; libphonenumber-js; robots-parser; csv-parse on the cached NJ roster; cfemail decode; turf point-in-polygon; drizzle-orm `migrator.d.ts`; drizzle-kit `generate --help`
- www2.census.gov downloads: rel2020 place + cousub files (headers, Edison/Austin/San Diego ZCTAs), 2025 Gazetteer ZCTA; HEAD of cb_2020 and TIGER2025 ZCTA files; TIGERweb GeoJSON query
- data.texas.gov `/api/views/9cir-efmm.json` column metadata (via 1.1.1.1 resolver)
- catalog.data.gov SSA dataset JSON-LD (contentUrl, CC0 licence); ssa.gov 403 (curl + WebFetch)
- Cached probe pages (rutgerspainting page1.html): filler text + Elementor counter markup
- `gh api`: org plan, repo absence, latest action tags; MCR playwright tags; Docker Hub postgres:18 tags
- Project files read this session: 01-CONTEXT.md, REQUIREMENTS.md, STATE.md, PROJECT.md, ROADMAP.md, PROBES-2026-10-25.md, SOURCES-PROBE.md, .claude/CLAUDE.md, config.json

### Secondary (MEDIUM, official docs via WebFetch)
- https://vitest.dev/guide/migration (Vitest 5), https://v4.vitest.dev/guide/migration (Vitest 4 option renames)
- https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ (TS 6 defaults/deprecations)
- https://www.rfc-editor.org/rfc/rfc9309.html (robots.txt 4xx/5xx/caching)
- https://orm.drizzle.team/docs/migrations (now describes 1.0 layout, which is why the API was verified against the installed 0.45.4 types instead)

### Tertiary (LOW, web search)
- [blog.jse.li — Cloudflare email obfuscation analysis](https://blog.jse.li/posts/cloudflare-scrape-shield/) (algorithm, corroborated by local round-trip)
- [Census relationship files](https://www.census.gov/geographies/reference-files/time-series/geo/relationship-files.2020.html), [Gazetteer files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2026.html)
- [SSA limits page](https://www.ssa.gov/oact/babynames/limits.html) / [data.gov catalog](https://catalog.data.gov/dataset/baby-names-from-social-security-card-applications-national-data)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Every version came from the registry, and the critical behaviours were tested locally.
- Geo/name data: HIGH. Files were downloaded and parsed, ZIP lists computed. SSA access was verified as blocked.
- Architecture: MEDIUM-HIGH. It follows locked decisions; table/column names are suggestions.
- Rule patterns: MEDIUM. They are grounded in observed pages, but precision is unmeasured until the golden set exists.
- Pitfalls: HIGH for the verified ones (1–6, 8, 11–14, 16, 20); MEDIUM for the others.

**Research date:** 2026-10-25
**Valid until:** 2026-11-08 for versions (fast-moving: vitest/undici/playwright released in the last 2 weeks); 2026-12-25 for data files and rules
