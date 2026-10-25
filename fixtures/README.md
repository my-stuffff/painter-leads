# Fixtures

Recorded inputs for tests. Tests never touch a live site, so everything a test needs lives here or next to the
package it tests.

## Golden set (`fixtures/golden/`)

Populated only by plan 01-06 (the pilot hand-check). One folder per checked company:

```
fixtures/golden/<state>/<slug>/
  pages/<sha256>.html.gz   saved company-website pages (gzip, so line-ending conversion can never change a hash)
  pages.json               which page is which: url, sha256, rendered true/false
  maps-card.json           the Google Maps card/place snapshot the parsers read
  registry.json            the registry rows matched to this company (that company only)
  truth.json               the hand-checked correct answers
```

Automated tests replay these through the extractors, classifier and matcher, so an accuracy regression fails CI.

## Package fixtures

Fixtures that belong to one package live in `packages/<pkg>/test/fixtures`.

## Rules

- Only public business pages. Never rosters, personnel files, client data, or anything from the owner's Downloads folder.
- Never a whole registry file; only the rows of companies in the golden set.
- A synthetic fixture (written by hand, not captured) must say so in a `README.md` next to it.
- `node scripts/check-guards.mjs` refuses files over 1 MB, raw download file names, and `.csv` / `.xlsx` files outside
  `test/` or `fixtures/` folders.
