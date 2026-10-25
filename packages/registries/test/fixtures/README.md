# Registries fixtures

Everything here is public or synthetic. No test touches a live site.

| Folder | What | Real or synthetic |
| --- | --- | --- |
| `cslb/dataportal.html` | the CSLB data portal landing page (state licence board) | real page, public |
| `cslb/master-sample.csv` | the real master-file header plus 16 real painting-contractor licence rows (public licence data); insurance and bond columns blanked | real, public licence data |
| `cslb/cslb-people-*.csv` | personnel-file stand-ins with the real header and invented names | synthetic |
| `nj/*.html` | NJ Home Improvement Contractor verification pages for three public registrations | real pages, public |
| `nj/nj-roster-synthetic.txt` | roster download with the real header and 8 invented rows (emails on `example.test`) | **synthetic** — never a real roster; the guard script refuses any file named `Data.txt` |
| `njbiz/*.html` | NJ business register principal-name search pages | real pages, public |
| `tx/` | Texas Comptroller officer JSON (street addresses replaced with `REDACTED`) and data.texas.gov taxpayer rows | real, public |
| `bbb/` | BBB profile / sitemap / Cloudflare-block stand-ins | **synthetic** — real captures from a network where bbb.org loads replace them in plan 01-06 |

Rules: never commit a raw roster or personnel download, never log a full roster row, never copy anything from
the owner's Downloads folder.
