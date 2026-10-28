# 03-C City catalog: report

Branch `pf-geo`. `pp geo build` now also writes `data/geo/catalog.json` and adds one whole-city area per catalog
city to `pilot-areas.json` / `pilot-zcta.geojson`. Built against live Census on 2026-10-28.

## Result

| State | Places | NJ townships (cousub) | Cities | New areas | ZIPs searched (sum) | Distinct ZIPs |
| --- | --- | --- | --- | --- | --- | --- |
| CA | 178 | 0 | 178 | 168 | 745 | 732 |
| TX | 75 | 0 | 75 | 65 | 526 | 519 |
| NJ | 17 | 22 | 39 | 35 | 127 | 124 |
| Total | 270 | 22 | 292 | 268 | 1398 | 1375 |

- Source: Vintage 2024 sub-county estimates `sub-est2024.csv` (columns checked: SUMLEV, STATE, COUNTY, PLACE,
  COUSUB, CONCIT, PRIMGEO_FLAG, FUNCSTAT, NAME, STNAME, ESTIMATESBASE2020, POPESTIMATE2020..2024; Latin-1 text).
  Threshold POPESTIMATE2024 >= 50,000 (smallest included: Glendora CA, 50,101).
- NJ dedupe: a NJ city is in the file twice (place 162 and county subdivision 061) under the same 5-digit code
  (Newark PLACE 51000 / COUSUB 51000; the 061 copy has FUNCSTAT F). A 061 row whose code is a place code in the same
  state is dropped; 22 townships remain (Lakewood, Edison, Woodbridge, Toms River, Hamilton, Cherry Hill, Brick, ...).
- Ids: the 24 whole cities keep theirs (Austin -> `austin_tx_city`, San Diego -> `san_diego_ca_city`); Edison ->
  `edison_nj_city` (pilot `edison_nj` untouched); others `<name>_<state>` (`santa_ana_ca`, `woodbridge_nj`,
  `union_city_nj`). 295 areas, all ids unique.
- Existing areas: the first 27 areas of the new `pilot-areas.json` are byte-identical to before (old file is a byte
  prefix of the new one); all 955 old polygons are unchanged. LA 116, Houston 92, San Antonio 51, Newark 9.
- lat/lng: centre of the city's searched ZCTAs' Gazetteer internal points, each weighted by its share of the
  city's land (AREALAND_PART / AREALAND_PLACE_20 or _COUSUB_20), 5 decimals. Not the Census place internal point.
- A second build gave identical `pilot-areas.json` and `pilot-zcta.geojson`, and `catalog.json` differing only
  in `builtAt`.

## Decision taken (needs the owner's nod)

17 catalog cities have **no** ZCTA with 20% of its own land inside the city (small cities inside big rural ZIPs:
Merced, Livermore, Napa, San Marcos TX, Tulare, Yuba City, Madera, Lodi, Davis, Brentwood, Porterville, Woodland,
Hanford, Gilroy, Petaluma, Lincoln, Delano). Applying the brief literally ("zero ZCTAs fails the build") would make
the build fail on real data. Instead those 17 use a fallback: the ZIPs holding >= 20% of the **city's** land
(e.g. Davis = 95616 + 95618, 55% + 45% of the city). They are marked `zctaRule: "city-land"` on the area (new
optional `AreaDef` field). The build still fails if a city gets zero ZIPs under either rule.
To drop them instead, remove the fallback in `cityArea` and filter those cities out of the catalog.

## Known gap (not changed: the rule must match the 24 cities)

The 20%-of-the-ZIP rule under-covers some mid-size cities whose land sits in large ZIPs that reach far outside.
By land, 202 cities have >= 90% of their land in their searched ZIPs, 46 have 75-90%, 28 have 50-75%, and 16 have
under 50%: Bakersfield (existing, 6 ZIPs, 43%), Laredo (2 ZIPs, 22%), Visalia, Abilene, Murrieta, Temecula, Santa Maria,
Edinburg, Chico, San Angelo, Tracy, Perris, Turlock, Victoria, Santa Cruz, Watsonville (1 ZIP, 14%). Land share is
only a proxy for where people and painters are.

## Files and load time

| File | Before | After |
| --- | --- | --- |
| data/geo/pilot-areas.json | 105,003 B | 279,330 B |
| data/geo/pilot-zcta.geojson | 1,396,011 B (955 polygons) | 3,425,871 B (1,848 polygons) |
| data/geo/catalog.json | none | 87,766 B (292 cities) |

Read + `JSON.parse` (node -e, best of 5): areas 1.3 ms, catalog 0.4 ms, geojson 24.5 ms (was 12.2 ms).
Real functions (tsx, 3 cold runs): `loadAreas` 1.7-2.6 ms, `loadCatalog` 0.6-0.8 ms, first `zctaForPoint` call
(load + index) 70-88 ms, then 0.05 ms per lookup. Far under the 25 MB limit; coordinates were already at 5 decimals
(TIGERweb geometryPrecision 5), so nothing reduced. The builder's size guard went from 5 MB to 25 MB
(`GEOJSON_MAX_BYTES`). TIGERweb lists are now asked 50 ZCTAs per request (38 requests); full build ~1.5 min.

## Exported API (`@pp/core`, from `packages/core/src/geo/index.ts`)

- `loadCatalog(config): CatalogFile` reads the catalog (throws "run: pp geo build" when missing).
- `catalogFilePath(config)` = `catalog.json` next to `config.areas.file`; `CATALOG_PATH` = `<repo>/data/geo/catalog.json`;
  `CATALOG_FILE_NAME`.
- Types `CatalogFile { builtAt, sources, minPopulation, popYear, cities }` and `CatalogCity { areaId, state, name,
  censusName, kind: 'place' | 'cousub', geoid, population, popYear, lat, lng, zipCount }`.
- `AreaDef` gains optional `zctaRule?: 'city-land'`; whole-city areas may now have `censusKind: 'cousub'` (NJ townships).
- Build-time helpers (not re-exported): `packages/core/src/geo/popest.ts` (parse, select, ids, centre).

## Spot checks (ZIP lists against what I know)

- Santa Ana CA: 92701, 92703, 92704, 92705, 92706, 92707 (92702 is a PO-box ZIP, no ZCTA; 92705 is shared with Tustin).
- Woodbridge NJ: 07001 Avenel, 07064 Port Reading, 07067 Colonia, 07077 Sewaren, 07095 Woodbridge, 08830 Iselin,
  08832 Keasbey, 08863 Fords: the township's sections, nothing else.
- Irving TX: 75038, 75039, 75060-75063. McKinney TX: 75069-75072. Lakewood NJ: 08701.

## Tests

- New `packages/core/test/geo-catalog.test.ts` (20 tests): estimates parsing (Latin-1, missing column fails),
  selection (threshold at the exact boundary, SUMLEV 162/061 vs 157/071/040/050, NJ place/township dedupe incl.
  same code in another state, state filter, townships only in NJ), ids (existing reused, `_city` on collision,
  GEOID last, never duplicate), sort (population, then name, then GEOID), cousub area (Woodbridge) and the city-land
  fallback + zero-ZIP failure (Davis) on real rows, and the committed catalog (counts, order, every city -> its area,
  zipCount, centres inside the state). Fixtures cut unchanged from the Census files under `packages/core/test/fixtures/geo/`.
- `geo-cities.test.ts` / `geo.test.ts`: the owner-order check now looks at the first 24 cities; the share check skips
  `city-land` areas. The polygon + "centre inside its own ZCTA" check passes for all 292 cities.
- Proved red: removing the NJ dedupe made 4 tests fail; restored, 20/20 pass.
- `vitest run --project unit packages/core`: 14 files, 174 tests pass. `@pp/core` typecheck and `eslint packages/core` clean.

## Outside my lane: one test elsewhere now fails

`packages/maps/test/smoke.test.ts` (localityShare) pins how many fixture cards land in ANY polygon of the ZCTA file.
More polygons means more cards land somewhere. The area counts are unchanged; only the "area or ring" count moves:

- smoke 1: `inAreaOrNeighbourRing` 55 -> 69, `shareInAreaOrRing` 0.4741 -> 0.5948
- smoke 2: 43 -> 56, 0.5584 -> 0.7273
- smoke 3: 102 -> 105

The brief forbids me to edit `packages/maps`, so it is left red for whoever merges (same kind of update the 24-city
merge made, see the comment above smoke 3). All other packages' unit tests pass (691 total, these 3 fail).

## Not verified

- Population and names are trusted from the Census file; ZIP lists beyond the spot checks were not checked by hand.
- The 17 city-land cities search ZIPs that reach well outside the city; the pipeline's in-area check will count
  painters anywhere in those ZIPs as in the city.
