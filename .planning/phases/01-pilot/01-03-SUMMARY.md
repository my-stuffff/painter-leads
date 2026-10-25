---
phase: 01-pilot
plan: 03
subsystem: registries
tags: [registries, cslb, nj-hic, texas, bbb, matching, aspnet]

requires: [01-01]
provides:
  - "@pp/registries: registries-match stage (CA, NJ, TX, BBB), golden replayer registryMatch, pp registries commands"
  - CSLB master download + completeness check + streaming load; personnel loader that refuses partial files
  - NJ roster flow, HIC ladder, same-session owner read, principal-name confirmation, roster email
  - Texas open-data taxpayer search; Comptroller officer lookup (built, tested, silent while its switch is off)
  - BBB profile parser, sitemap discovery, per-run circuit breaker, capture / parse / import commands
affects: [01-04-sites, 01-05-pipeline, 01-06-pilot-run]

actuals:
  tokens: unmeasured
  tasks: 3
  commits: 3

requirements-completed: [ENR-03, ENR-04, ENR-05, ENR-06]
completed: 2026-10-26
---

# Phase 1 Plan 03: Registries Summary

**Owner and licence enrichment from free official sources is built behind the `registries-match` stage: California (CSLB), New Jersey (HIC roster + detail + principal check), Texas (open data; Comptroller built but off), BBB (fixtures only from this laptop). 165 package tests pass; the full gate is green.**

## Commits

| Task | Commit | What |
| --- | --- | --- |
| 1 Tracer | 44709c8 | ASP.NET helpers, CSLB download + completeness, master load, ladder, licence + sole-owner evidence, stage, commands |
| 2 NJ | 219a7b7 | roster flow + parse, ladder in fixed order, detail owner (same session), principal check, roster email |
| 3 TX / BBB / personnel | 7574401 | open data, Comptroller (off), BBB + breaker + capture/import, personnel loader, lookup status, replayer, all-state dispatch |

## Live results (this laptop, 2026-10-25/26)

| Item | Result |
| --- | --- |
| CSLB master, **my own download** | **Cut off.** 42,908,554 of ~78 MB (134,512 complete rows) after 150 s, no network error. The check refused it (file renamed `*.INCOMPLETE`). Requests: portal GET, file-type POST, CSV POST (302), then GET `DownLoadFile.ashx?fName=MasterLicenseData&type=C` |
| CSLB master, orchestrator's complete probe file (10/23/2026) | **245,633 rows** loaded in 41 s; 23,093 sole owners have a readable name; max licence 1,163,439 (outlier test licence 88888888 ignored) |
| San Diego, 82 cards | 80 have a phone; **41 match strongly by phone** (probe saw 37), 39 of them C-33; 26 more are name-only candidates, 15 nothing. **0 of the 41 got an owner name from the master** (see below) |
| C-33 sole owners | 9,566 licences, only **1,713 (17.9%)** have the person name in the master file |
| NJ roster, Edison | **818 registrations** (Active 270, Expired 530, other 18). First try timed out on the search (20 s), the retry worked in 39 s |
| NJ detail owners, 3 lookups | 13VH06161800 **Eric Doeler**, 13VH11241900 **Donal Lopez**, 13VH06084400 **John Catapano** (all Active) |
| NJ principal search, 1 lookup | DOELER, ERIC → SPECTRA PAINTING, INC., entity 0100508103, Tinton Falls |
| data.texas.gov | 2 queries (78701 "PAINT" → 11 rows; 78665 "HILL COUNTRY" → 5 rows); ZIP is stored as 5 digits |
| Comptroller | 0 requests (switch off) |
| BBB | 0 requests |
| Real truncated CSLB personnel file (45.8 MB) | **Refused**: last row does not parse (line 202,666); highest licence 962,062 = **82.7%** of the master's 1,163,439 (17.3% below, limit 1%) |
| CSLB per-licence lookup | **`lookup_unavailable`** (see below) |

## What the live runs taught (read these)

1. **The CSLB download is cut off after ~150 s with no error.** The portal answers 200 and just stops, so a slow link gets half a file that looks fine. Fix built in: every row must parse (checked after download and again before load); a cut file is kept as `*.INCOMPLETE` and the command exits 1. Run the download from a fast server (Railway). Untested idea: the file is a plain GET at `DownLoadFile.ashx?fName=MasterLicenseData&type=C`, so HTTP `Range` requests might resume it.
2. **California owners from the master are rare.** The plan assumed the sole-owner licence name is the person. In the file it usually is a trade name ("FAUSTINO FINISHING PAINTING"); the person form (`FullBusinessName`) exists for only 17.9% of C-33 sole owners. I read a name only when the file shows both forms (`ESPARZA VICENTE PAINTING` and `VICENTE ESPARZA PAINTING`) and refuse everything else, rather than falling back to `splitLastFirstMiddle(BusinessName)` as the plan said (that turns "Faustino Finishing Painting" into a person). **Owner coverage in California therefore depends on a complete personnel file from a fast server** (it has a Sole Owner row for every sole proprietor, plus officers for corporations).
3. **CSLB per-licence lookup is not usable.** 4 pages used: the "Check a License" form posts back to itself with no licence page and no message (the page loads Google reCAPTCHA; no widget in the markup; cause not established; CAPTCHA solving is ruled out). `registries cslb lookup` reports `lookup_unavailable`; nothing is faked and the stage never calls it.
4. NJ's roster search can take over 20 s: all NJ flow steps now allow 2 minutes.

## Contract as built (differences from the plan text / core)

- `registries-match` returns statuses only for the sources that apply to the state (CA: cslb, bbb; NJ: nj_hic_roster, nj_hic_detail, nj_principal_search, bbb; TX: tx_open_data, tx_comptroller, bbb). `tx_comptroller` is `disabled` whenever its switch is off, even when no entity matched.
- `offline` (CLI `--offline`) skips the live NJ owner/principal flows as `disabled`; matching against already-loaded rosters still runs. GET sources (data.texas.gov, Comptroller, bbb.org) replay from the page cache.
- Statuses written to `companies.registry_status`: `cslb`, `cslb_owner`, `nj_hic`, `nj_hic_active`, `nj_hic_rung`, `nj_hic_detail`, `nj_principal_search`, `tx_open_data`, `tx_taxpayer`, `tx_comptroller`, `bbb`, `bbb_owner`, `cslb_error`.
- `RegistryMatchResult.owners` counts owner evidence rows written this run or reused (TX can be 3 officers).
- Re-running the stage is safe: matches are replaced, evidence is de-duplicated by (field, source, normalised value), and stored owner evidence prevents repeat NJ/TX requests.
- Evidence `page_sha256` is NULL for registry flows that run in a session (the core fetcher stores no page for those); BBB evidence carries the fetcher key.
- Owner confidence: registry owners `high`; BBB owner/president `high`, other BBB titles (manager) `medium`; Comptroller officers `high` (several per company: 01-05's selection picks the owner).
- Core used as-is. Two things worth knowing for later plans: `fetcher.download()` has no cookie jar, so the CSLB and NJ downloads use `session.post` (whole file in memory, per-request `timeoutMs`/`maxBytes`); `FetchResult.sha256` is the request key.

## Deviations from the plan

1. **No new packages.** `zod` and `drizzle-orm` are not linked into this package, so registry tables are read/written with plain SQL on `db.$client` and payloads are validated by small hand-written checks (`TxPayloadError`). No `package.json` change.
2. Live proof loaded **into a scratch database** `painter_leads_test_reg_live` (not the dev `painter_leads`), per the packet's database rule.
3. The CSLB master "download ×1" was spent on the truncated download; the row count and the San Diego match used the orchestrator's complete probe file (same official source, 10/23/2026).
4. NJ roster pull: 2 attempts (the first timed out on the search; no file produced).
5. Person-name registrations ("ANTONIO DEVITA") match through the normal company-name path (equal core name + same ZIP/town), not a separate owner-name path.
6. BBB: profile discovery walks the business-profile sitemaps (bounded to 60 fetches per city) and is only exercised on synthetic fixtures; real captures replace them in 01-06.
7. `registries bbb import` takes the captured folder and `--run N`; it matches only profiles whose state equals the company's.

## Open for the orchestrator

- **CA owners need a complete personnel file**: `pp registries cslb download --kind personnel` then `pp registries cslb load --personnel FILE`, from Railway. Same for a trustworthy master (`--kind master`).
- **Texas Comptroller**: to turn it on the owner must set both `enabled: true` and `robots: "override"` for `tx_comptroller` (robots.txt disallows `/data-search/`; with `respect` the stage reports `blocked`).
- **BBB**: capture on the Railway test service with `pp registries bbb capture --from-sitemaps --state NJ --city Edison --out DIR`, bring the folder back, `pp registries bbb import DIR --run N`.
- The `*.INCOMPLETE` CSLB file (42.9 MB) and the Edison roster live under `D:\ClaudeCode\Painter-Promotions\pp-data\downloads\` (outside the repo; delete when done).
- Not covered: Edison companies from nearby towns (Iselin, Menlo Park) pull their own town's roster on first use; a statewide roster pull is untested (D-21).
