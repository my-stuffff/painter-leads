---
phase: 01-pilot
plan: 01
subsystem: infra
tags: [monorepo, drizzle, evidence, fetcher, contracts, geo, ci]

requires: []
provides:
  - pnpm/TypeScript monorepo with exact-pinned dependencies (playwright-core 1.63.0)
  - the one pilot migration (0000_pilot_schema, 13 tables) with DB-level provenance and NULL-not-0 checks
  - evidence API (store, selectBest, corroborate, resolveOwnerConflicts) and stage contracts with in-memory fakes
  - polite fetcher, SSRF guard, per-host DNS overrides, gzip disk cache, shared Chromium launcher, normalisers
  - pilot geo data (Edison / Austin / San Diego) with provenance, the pp CLI, CI workflow, repo guards
affects: [01-02-maps, 01-03-registries, 01-04-sites, 01-05-pipeline, 01-06-pilot-run]

actuals:
  tokens: unmeasured
  tasks: 4
  commits: 5

tech-stack:
  added: [typescript 6.0.3, vitest 5.0.5, vite 8.3.5, tsx 4.23.15, eslint 10.13.0, typescript-eslint 8.72.0, drizzle-orm 0.45.4, drizzle-kit 0.31.11, pg 8.23.1, undici 8.12.3, zod 4.6.7, tldts 7.4.19, libphonenumber-js 1.13.15, robots-parser 3.0.1, csv-parse 7.0.3, "@turf/boolean-point-in-polygon 7.4.0", pino 10.4.0, playwright-core 1.63.0, cheerio 1.2.0, exceljs 4.4.0, commander 15.0.0]
  patterns: [evidence row per value, DB CHECK constraints for provenance, network guard in vitest, fetcher is the only network path]

key-files:
  created: [pp.config.json, packages/core/**, apps/cli/**, data/geo/*, data/PROVENANCE.md, .github/workflows/ci.yml, scripts/check-guards.mjs]
  modified: []

key-decisions:
  - "module preserve + moduleResolution bundler works with TypeScript 6.0.3; no nodenext fallback needed"
  - "Cache key is sha256 of the REQUEST (METHOD url + body), not of the response body"
  - "selectBest drops rows below policy.minConfidence (default medium), so low-confidence values stay in the database but are never selected"

requirements-completed: [ENR-06, QUAL-04, OPS-01]

duration: one session
completed: 2026-10-25
---

# Phase 1 Plan 01: Foundation Summary

**Monorepo, the one pilot migration, evidence API, polite fetcher, geo data, `pp` CLI and CI workflow are built and green locally; `pp doctor` prints every `ok` line.**

## Package approval

Task 1 checks run before any install (via `corepack pnpm view`, plus npm download counts):

1. Repository links match the research audit for all nine planner-chosen packages: undici (nodejs/undici), tldts
   (remusao/tldts), robots-parser (samclarke/robots-parser), csv-parse (adaltas/node-csv), tsx (privatenumber/tsx), zod
   (colinhacks/zod), pino (pinojs/pino), commander (tj/commander.js), @turf/boolean-point-in-polygon (Turfjs/turf).
   Weekly downloads: undici 143.8M, tldts 62.9M, robots-parser 3.6M, csv-parse 12.7M, tsx 64.5M, zod 221.6M,
   pino 35.5M, commander 338.0M, turf point-in-polygon 2.7M.
2. None declares a `preinstall`, `install` or `postinstall` script (all empty).

**Package approval: approved by owner 2026-10-25 via orchestrator** (the owner's "Go", recorded in STATE.md
Decisions; no package dropped).

## Commits

| Task | Commit | What |
| --- | --- | --- |
| 2 Tracer | 8c6673a | workspace, config, one migration, evidence, stages + fakes, CLI, vitest projects + network guard, skeletons |
| 3 Fetcher | ecd540e | fetcher, DNS overrides, SSRF guard, cache, browser launcher, normalisers, eslint config |
| fix | 6a69493 | default data dir lost its backslashes on Windows; typing in fetcher test |
| 4 Geo/CI | a52a369 | geo build + data, CI workflow, guard script, fixtures layout, README |

## Contract as built (differences from the interfaces block)

All names in the interfaces block exist and are re-exported from `@pp/core`. Differences and additions:

- `CommandContext` gained an optional `moduleNames?: readonly string[]` (set by the pp CLI; `pp doctor` prints it).
- `Db` is `NodePgDatabase<schema> & { $client: pg.Pool }`; new exported type `DbOrTx` (a Db or a transaction handle).
  Evidence functions (`corroborate`, `resolveOwnerConflicts`, `DbEvidenceStore`) accept `DbOrTx`.
- `createFetcher` deps gained optional `resolveHost(host) => Promise<string[]>` (SSRF pre-check; tests inject it).
- Fetcher: `FetchResult.sha256` and `pages.sha256` are the cache KEY, `sha256(METHOD + ' ' + url + '\n' + requestBody)`;
  files are `<dataDir>/pages/<2 hex>/<2 hex>/<key>.html.gz` plus a small `<key>.meta.json` (status, final URL,
  content type). Rendered pages use `sha256('RENDER ' + url + '\n' + html)`. GET defaults to cache `use`; POST and
  session requests default to `none`; only 2xx responses are stored. `request_log`/`pages` rows are written only when
  a `db` is given. SSRF is checked before every hop (resolve, then `isPublicAddress`) AND again in the connect-time
  lookup. `createDnsResolver` throws `NetworkDisabledError` under the test guard.
- `selectBest` never returns a rejected row and applies `policy.minConfidence` (default `medium`), so a pipeline that
  wants low rows must pass its own policy. `DbEvidenceStore.listForCompany` returns every status, ordered by id.
- `resolveOwnerConflicts` decides "matches the registry" by first + last name (`personFirstLastKey`, new export), so
  "John Albert Catapano" (registry) does not reject "John Catapano" (website). `value_norm` for owner names is still
  `personNameKey`. Registry families are `REGISTRY_SOURCE_TYPES` (CSLB, NJ HIC detail, NJ principal search, TX).
- `titleCaseName`: `Mc` prefix handled generically; `Mac` only for a short allow-list (MacDonald, MacArthur, ...),
  because splitting it generically would turn Machado into MacHado. Mixed-case input is left unchanged.
- `AreaDef` gained optional `poBoxZipsVerified` (false for Edison, research A3). `loadAreas` reads
  `config.areas.file`; `zctaForPoint` reads `data/geo/pilot-zcta.geojson` (no config argument, as specified).
- `createFakeStages()` is stateful per registry instance (discover creates two listings: one meeting the default
  thresholds, one not; qualify reads the evidence discover recorded).
- Extra exports wave 2 can use: `getTestDb`, `truncateAll`, `migrationsApplied`, `createDatabaseIfMissing`,
  `REGISTRY_SOURCE_TYPES`, `personFirstLastKey`, `STATE_CODES`, `SOURCE_IDS`, `FIELDS` and the other value lists.
- Skeleton packages import types from `@pp/core` only; tests for them are `test/skeleton.test.ts`.

## Deviations from the plan

1. **[Bug, fixed]** `dataDir()` returned `D:ClaudeCodePainter-Promotionspp-data` (a shell heredoc swallowed the
   backslashes), so the first geo download created a stray folder inside the repo. Caught while verifying, folder
   deleted, fixed in 6a69493, covered by `paths.test.ts`.
2. `eslint.config.js` (a Task 4 file) was committed with Task 3 because Task 3's acceptance needs `pnpm lint`.
3. Vitest 5 needed `sequence.groupOrder` per project (unit 0, db 1, golden 2) because the db project sets `maxWorkers`.
4. A second `dataDir` caveat: on non-Windows the default is `<repo>/.pp-data` (gitignored).
5. `STATE.md` / `ROADMAP.md` were NOT updated (orchestrator re-runs the state update after merge, per its steps).

## Geo results (actual counts)

| Area | allZctas (share >= 0.20) | pilotZctas | expansionZctas |
| --- | --- | --- | --- |
| edison_nj | 3 (08820, 08817, 08837) | 08817, 08820, 08837 | 9 (07001, 07064, 07067, 07077, 07095, 08830, 08832, 08840, 08863) |
| austin_tx | 38 (matches research) | 12, seed 78701 | none |
| san_diego_ca | 45 (matches research) | 12, seed 92101 | none |

- Austin pilot: 78701, 78717, 78739, 78753, 78730, 78724, 78735, 78744, 78759, 78745, 78726, 78723.
- San Diego pilot: 92101, 92127, 92154, 92092, 92119, 92139, 92111, 92126, 92131, 92173, 92105, 92107.
  **Flag:** the deterministic rule picked 92092 (the UC San Diego campus ZIP, share >= 0.5). It may yield few painters;
  the orchestrator can swap it before the live run, the rule itself is what the plan specified.
- `pilot-zcta.geojson`: 177 ZCTA polygons (area ZCTAs plus the neighbour ring), 307,039 bytes, offset 0.0005.
- All three Census text files were also downloaded through the core fetcher (no `--input-dir`): the Gazetteer zip is
  952,026 bytes as in the research, and the generated files were byte-identical to the run from local copies.
- `data/PROVENANCE.md` lists URL, date, bytes and sha256 for every downloaded file and TIGERweb response. The geo
  section sits between `<!-- geo:begin -->` / `<!-- geo:end -->` markers so other plans can add their own sections.

## Verification (real output in REPORT.md)

`corepack pnpm install --frozen-lockfile` ok; `pp doctor` exit 0 with all seven lines; 19 test files / 180 tests pass
across unit + db + golden (golden is empty and passes with no files); `pnpm -r typecheck`, `pnpm lint`,
`node scripts/check-guards.mjs` ("guards: ok") all exit 0; one migration file.

## Open for the orchestrator

- First push and first GitHub Actions run (OPS-01) are orchestrator steps. The workflow uses `actions/checkout@v7`,
  `pnpm/action-setup@v6`, `actions/setup-node@v7` exactly as the plan states; I could not check those tags exist.
- CI minutes on the free org plan (research A10) are unmeasured; one lean job per push.
- Edison PO-box ZIPs 08818 / 08899 are stored with `poBoxZipsVerified: false` (research A3).
