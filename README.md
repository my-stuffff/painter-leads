# Painter Promotions - Lead Finder

For a chosen US state, finds every painting contractor on Google Maps, keeps the ones that paint homes only, and fills
each company with owner name, phone, email, website, rating and review count, every value traced to the public page it
came from. A blank is acceptable; a wrong or guessed value is not.

## Run it

```
corepack pnpm install
corepack pnpm pp doctor          # config, database, migrations, evidence, fetcher, fake stages, modules
corepack pnpm pp db migrate --create
corepack pnpm pp config check
corepack pnpm test               # unit + db + golden (no live network; needs Postgres)
```

Needs Node 22 and pnpm 9.15.9 (via corepack). Playwright Chromium 1243 (`playwright-core` is pinned to exactly 1.63.0).

## Environment

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | the working database, e.g. `postgres://postgres:postgres@127.0.0.1:5432/painter_leads` |
| `TEST_DATABASE_URL` | test database, name must match `painter_leads_test_<slug>` |
| `PP_DATA_DIR` | cached pages and downloads (never committed); default is the project folder `pp-data` |
| `PP_LIVE` | `1` allows launching Chromium; unset everywhere in tests and CI |
| `PP_CONFIG` | path of the one settings file (default `pp.config.json` in the repo root) |

All thresholds, source switches, rate limits and DNS overrides live in `pp.config.json`. There are no hidden defaults.

## Layout

`packages/core` (config, database + migration, evidence, polite fetcher, normalisers, geo, stage contracts),
`packages/maps`, `packages/registries`, `packages/sites`, `packages/pipeline`, `apps/cli` (`pp`), `data/` (Census geo
data with `PROVENANCE.md`), `fixtures/` (see its README).

## Never

No third-party data or AI service, no proxies, no CAPTCHA solving, no logging into any site. No live Google requests
from tests or CI. Client contact exports and anything from the owner's Downloads folder never enter the repo. Pushing,
merging and deploying are done by the orchestrator, not by workers.
