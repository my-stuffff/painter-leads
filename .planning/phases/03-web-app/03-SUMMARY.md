# Phase 3 — Lead platform: summary (2026-10-28, ~14:25 PKT)

**Live:** https://pp-web-staging.up.railway.app (Railway smerp/staging: pp-web + pp-worker + pp-worker-2 + pp-db).
Admin sign-in: `_private/pp-web-admin.txt`. Branch `platform` (local; not pushed).

## Built
- Web app (apps/web): sign-in + roles, New search (CA/TX/NJ maps, 292 cities biggest first, requirements, rough time),
  live job page (per-city progress, 3 lead lists, filters, lead drawer with sources, XLSX/CSV downloads,
  cancel/retry/rebuild), all searches, users.
- Jobs engine (packages/jobs): `pp worker` queue (one running city per state, retries, Google back-off, daily cap,
  crash reclaim), export builder (per-job thresholds, painting / check first / likely fits, dedupe by Google link).
- City catalog (packages/core/src/geo): 292 cities >= 50k (CA 178, TX 75, NJ 39 incl. townships), whole-city areas.
- Server (apps/web/src/server): Hono API per apps/web/src/shared/api.ts, exports stored in Postgres.

## Verified
- Tests: 703 unit, 34 db (jobs + web) pass; typecheck + eslint clean.
- Live: job 1 (4 NJ cities, reused) export 0/2/24; job 2 live scrape Lakewood NJ + Elk Grove CA done by the workers
  in ~7 min (2 painting leads, owners from CSLB C33 licences, email on the company site); job 3 started from the real
  screens (TX top 5, reused) 35/24/493 in ~1 min. Desktop + phone screenshots checked.

## Flags
- Export judges "inside the city" per run (lane A): the 28 Oct workbook missed 95 border companies (1 + 3 + 91).
- 17 small cities have no ZIP with >= 20 % of its land inside them: they search the ZIPs holding >= 20 % of the
  city's land (`zctaRule: "city-land"`); 16 cities have < 50 % of their land in searched ZIPs (e.g. Laredo, Bakersfield).
- Only CA / TX / NJ (owner registries exist only for these). Review counts can't be re-checked logged-out.
- SIGTERM path on Railway unverified (restart reset + 10-min stale reclaim cover it).
