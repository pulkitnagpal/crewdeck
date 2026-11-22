# Company directory seed: source and licence

`seed.csv` is derived from the **LastRound AI ATS company directory** (August 2026 edition).

| | |
| --- | --- |
| Dataset page | https://datahub.io/lastroundai-hiring-data/lastroundai-hiring-data/ats-directory |
| File downloaded | https://datahub.io/lastroundai-hiring-data/lastroundai-hiring-data/_r/-/ats-directory/lastroundai-ats-company-directory-2026-08.csv (served from `r2.datahub.io`) |
| Retrieved | 2026-11-20 (one download) |
| Licence | Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/ |
| DOI | 10.6084/m9.figshare.33154145 |
| Original file | 442,356 bytes, 9,935 data rows + header; columns `ats_vendor,company_name,board_slug,last_crawled` |
| Original SHA-256 | `e637a04d06561bb3839dbf95a291e5fd11ac26b8f2858dc207939c1b723974a3` |
| Shipped `seed.csv` SHA-256 | `5ea6dfb764e57913f9a76272472ea7b1f26216ef8cc354995e2cfb4028f6a0db` (pinned in `src/jobs/directory/seed.ts`) |

Vendors in the original: Greenhouse 4,966 · Ashby 2,856 · Lever 2,113. `last_crawled` dates run 2026-07-11 to 2026-08-01.

## Attribution (required by CC BY 4.0)

> Company directory data: "ATS company directory" by LastRound AI, https://datahub.io/lastroundai-hiring-data/lastroundai-hiring-data/ats-directory,
> licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). See also the LastRound AI pay transparency study,
> https://lastroundai.com/blog/salary-transparency-study-2026. Modified by Crewdeck: rows withheld, as described below.

The dataset page asks for attribution to LastRound AI and a link to the pay transparency study; the README and the
Sources tab must carry the attribution above (ADR-0002).

## Changes made (CC BY 4.0 requires indicating them)

- **3 rows withheld** (2 Ashby, 1 Lever): they match the repository's private leak-scan list (`scripts/leak-scan.mjs`),
  so they cannot be committed here. Otherwise every row, column, order and byte is as downloaded; header unchanged.
- Nothing else is altered. Industry, region, remote and size labels are **not** in the dataset: Crewdeck derives them
  at load time from the company name and board slug (`src/jobs/directory/enrich.ts`) and marks them low/medium
  confidence. Hand-curated facts live separately in `curated.yaml`, each with its evidence URL.

## Pinning

`loadSeed()` hashes `seed.csv` and refuses to load it when the SHA-256 differs from the pin, so the directory can only
change through a reviewed commit that updates the file, this note and the pin together.

## Known limits (measured, not guessed)

- No domains, industries, locations or departments in the dataset: names and slugs only.
- Staleness: a 4-board spot check on 2026-11-20 found 1 of 4 boards gone (Greenhouse `phonepe` → 404). Every board must
  be validated by its feed adapter before use; `curated.yaml` quarantines boards known to be gone.
