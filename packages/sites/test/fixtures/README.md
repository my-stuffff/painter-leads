# Fixtures (packages/sites)

## `sites/<site>/` - captured, public business pages

Captured on 2026-10-25 with `pp sites crawl <url> --max-internal 3 --json` (home page plus up to three internal pages
chosen by the crawler, through the core fetcher: robots honoured, 1 request/second, no logins). `wepainttexas` was
captured with `PP_LIVE=1` and without `--no-bundles`: its home page is a JavaScript app, so the stored page is the
Chromium-rendered HTML (`rendered: true`) and the one same-site bundle was fetched. The other four were captured
with `--no-bundles`. (`wepainttexas.com` without `www` returned HTTP 404 on the capture day, so `www.` was used.)

Each folder holds `<sha256>.html.gz` (the fetcher's cache file, gzip) and `pages.json`:
`[{ url, sha256, rendered, kind? }]` (`kind: "bundle"` marks a JavaScript bundle). `sha256` is the fetcher's cache key
(hash of the request, or of the render for a rendered page), not a hash of the body.

| Site | Used for |
| --- | --- |
| johnspaint.com | mailto on own-domain + off-domain address, 13VH number |
| njpaintingco.com | one address found by mailto, text and JSON-LD |
| bartonspringspainting.com | text-only email, two owner statements (Founder, Owner) |
| rutgerspainting.com | filler (Latin) team page with a placeholder owner, no email |
| wepainttexas.com | rendered JS page, JSON-LD email, placeholder addresses in the bundle |

Only public business pages. Every file is under 1 MB.

## `residential/` - synthetic

Written by hand for the residential classifier tests (not captured from any site); each file says what it is for.
