# Data provenance (packages/sites)

## first-names.txt

US first names used to validate owner names found on company websites (D-18). Lower-case, diacritics folded, sorted, one per line.

- Built: 2026-10-25
- Count: 5163
- Rule: union of the files below, folded to lower case

| File | URL | sha256 (response body) | Lines |
| --- | --- | --- | --- |
| Census 1990 male first names | https://www2.census.gov/topics/genealogy/1990surnames/dist.male.first | 0a5078ef6effe3b483d15b0f7f95047662126c9bfb624ecd5e5b978fc0f2470b | 1219 |
| Census 1990 female first names | https://www2.census.gov/topics/genealogy/1990surnames/dist.female.first | bd2f310fc4e5d5e5ea122c9d4342c9821145823118eb20db1647f305ec77b358 | 4275 |

- SSA is pending (D-37): ssa.gov returns 403 from this laptop. Plan 01-06 adds the SSA union with `pp sites names build --ssa-dir <folder of extracted yobYYYY.txt>` (names with a total count >= 50 over 1930-2005; source https://www.ssa.gov/oact/babynames/names.zip, public domain CC0).
