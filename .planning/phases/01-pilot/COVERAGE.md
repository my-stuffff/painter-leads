# API Coverage — Phase 1 external sources (public pages, official downloads, open-data endpoints)

> Full coverage by default. Opt-outs are explicit, reasoned decisions. No paid or third-party data service is
> integrated anywhere (D-01); every source below is read by our own code.

| capability | decision | reason |
|---|---|---|
| google-maps:search-results-page (own headless Chromium) | INTEGRATE | |
| google-maps:place-page (own headless Chromium) | INTEGRATE | |
| google-maps:review-texts | OPT-OUT | not needed — rating and review count are the only review fields the brief asks for |
| google-maps:owner-replies | OPT-OUT | explicitly out of scope — deferred idea in 01-CONTEXT.md (only if the pilot shows owner gaps) |
| google-maps:photos | OPT-OUT | not needed — no photo field in the deliverable |
| google-maps:places-api | OPT-OUT | explicitly out of scope — paid/third-party API ruled out by the owner (D-01) |
| data-texas-gov:soql-query (Active Franchise Taxpayers 9cir-efmm) | INTEGRATE | |
| data-texas-gov:bulk-export | OPT-OUT | not needed yet — per-company SoQL queries cover the pilot; Phase 2 may revisit for statewide runs |
| data-texas-gov:dataset-metadata | OPT-OUT | not needed — field names are fixed in code from the verified research (Pitfall 13) |
| tx-comptroller:franchise-tax-detail-by-taxpayer-id | INTEGRATE | |
| tx-comptroller:name-search | OPT-OUT | not needed — "starts with" only; the open-data contains-search finds the taxpayer number instead |
| tx-comptroller:file-number-search | OPT-OUT | not needed — taxpayer id from open data is sufficient |
| cslb-dataportal:licence-master-csv | INTEGRATE | |
| cslb-dataportal:personnel-csv | INTEGRATE | |
| cslb-dataportal:workers-comp-file | OPT-OUT | not needed — holds no owner or contact field |
| cslb-dataportal:excel-variants | OPT-OUT | not needed — same data as the CSV downloads |
| cslb:per-licence-lookup | INTEGRATE | |
| nj-mylicense:roster-bulk-download-per-town | INTEGRATE | |
| nj-mylicense:verification-search-and-details | INTEGRATE | |
| nj-mylicense:statewide-roster-download | OPT-OUT | not needed yet — untested at statewide size; the pilot pulls per town; Phase 2 decides |
| njportal:principal-name-search | INTEGRATE | |
| njportal:business-name-search | OPT-OUT | not needed — returns no officers; the HIC roster already gives the legal name |
| njportal:status-report-and-copies-order | OPT-OUT | explicitly out of scope — a paid order; never ordered (D-21) |
| njportal:business-entity-lists | OPT-OUT | explicitly out of scope — paid product with unknown price/format |
| njconsumeraffairs-gov:hic-pages | OPT-OUT | not needed — Incapsula bot challenge; the official mylicense lookup covers the same register |
| bbb:business-profile-sitemaps | INTEGRATE | |
| bbb:profile-page-json-ld | INTEGRATE | |
| bbb:api-search | OPT-OUT | explicitly out of scope — robots.txt disallows query-string URLs (D-21) |
| census:zcta-relationship-files-and-gazetteer | INTEGRATE | |
| census:tigerweb-zcta-polygons | INTEGRATE | |
| census:1990-first-name-lists | INTEGRATE | |
| ssa:baby-names-national-file | INTEGRATE | |
| company-websites:html-pages-json-ld-same-site-bundles | INTEGRATE | |
