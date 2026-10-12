# data/raw/owid — provenance

Files in this folder are byte-for-byte as downloaded. Do not edit them; to update, download into new files and update the specs
(`data/sources/owid-*.source.json` record the SHA-256 of `owid_energy.csv`, and `npm run data:import` refuses a changed file).

| File | Downloaded from | Retrieved (UTC) | SHA-256 |
|---|---|---|---|
| `owid_energy.csv` | https://catalog.ourworldindata.org/energy/owid_energy/owid_energy.csv | 2026-10-12 19:10:38 (server `Last-Modified: Wed, 30 Sep 2026 14:42:02 GMT`, ETag `"a95c4bd1835a60fbe3fd20ea37a53d67-2"`, 9,081,888 bytes) | `9d8efc4a9b1cc2ffdfa7f7f6f1e171b2922e0be2d97c0edf2982e874357ed6de` |
| `owid_energy.codebook.csv` | https://catalog.ourworldindata.org/energy/owid_energy/owid_energy.codebook.csv | 2026-10-12 (same session) | `b00441944a4f84110709a858ae4ed3d54694df95f98286777dfad1c94c544cf9` |
| `owid_energy.sources.csv` | https://catalog.ourworldindata.org/energy/owid_energy/owid_energy.sources.csv | 2026-10-12 (same session) | `3b53e9087d7a17b9a49604f6d6ffe739fb847293214c39d78f76aeeeaffa8ac8` |

Dataset documentation: https://catalog.ourworldindata.org/energy/owid_energy/readme.md (19,494 rows × 130 columns, one row per country/region and year).
This is the current release of the Our World in Data energy dataset (energy measured as total energy supply). The older
`owid/energy-data` GitHub release uses the substitution method, is no longer updated, and was not used.

## Licences and credit

- **Our World in Data** (compilation and processing): CC BY 4.0. OWID states that the licences of the original sources still apply.
- **Ember – Yearly Electricity Data (2026)** and **Yearly Electricity Data Europe (2026)** (electricity generation by source, demand, net imports): CC BY 4.0 (https://ember-energy.org/creative-commons/, checked 2026-10-12).
- **Energy Institute – Statistical Review of World Energy (2026)** (fuel total energy supply and production): the EI describes the Review as free to access and asks to be cited as "Energy Institute – Statistical Review of World Energy (2026)". No open licence text was found on the EI pages checked on 2026-10-12 (statistical-review home and data-downloads pages); the data is used here with that citation, via OWID's republication.
- Per-capita demand uses OWID's population series (CC BY 4.0).

Cite as: Energy Institute – Statistical Review of World Energy (2026); Ember – Yearly Electricity Data (2026); Ember – Yearly Electricity Data Europe (2026) – with major processing by Our World in Data.
