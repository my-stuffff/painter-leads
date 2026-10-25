# Synthetic golden cases

These two companies are **synthetic**: written by hand for the golden-harness test, not captured from any real
business, page or registry. They exist only to prove that the replay harness fails when a replayer is broken and
passes when it is correct (ACC-02).

- `NJ/synthetic-painting-co`: an email and an owner on the page, a residential-only company, a strong registry match.
- `NJ/synthetic-no-owner`: no email and no owner on the page (both `NOT_FINDABLE`), residential and commercial.

The real golden set lives in `fixtures/golden/` at the repository root and is populated in plan 01-06.
`pages/<sha256>.html.gz` files here are gzip copies of tiny hand-written HTML pages.
