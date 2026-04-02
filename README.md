# PatentCliff

MCP tool that calculates true pharmaceutical patent expiration dates by joining four US government databases (FDA Orange Book, USPTO PTA/PTE records, PTAB dockets, FDA ANDA letters) and applying multi-step statutory calculations.

Sold at **$0.10/query** on the [CTX Protocol](https://ctxprotocol.com) marketplace.

---

## What It Does

Given a brand name or active ingredient, PatentCliff returns:

- **Adjusted expiration date** — base Orange Book date corrected for Patent Term Adjustment (35 U.S.C. §154) and Patent Term Extension (35 U.S.C. §156)
- **Paragraph IV status** — active ANDA challenges and estimated 30-month stay expiry
- **PTAB proceedings** — instituted IPR/PGR cases threatening patent validity
- **Pediatric exclusivity** — +6 month extension where applicable
- **Generic entry risk score** — `low` | `moderate` | `elevated` | `high` | `critical`
- **Data freshness** — per-source last-updated timestamps with stale warnings

All date outputs carry `expiry_is_estimate: true`. See [Disclaimer](#disclaimer).

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- A writable path for the SQLite database

### Install

```sh
git clone <repo>
cd patent-cliff
bun install
```

### Configure

```sh
cp .env.example .env
```

| Variable   | Default             | Description                        |
| ---------- | ------------------- | ---------------------------------- |
| `PORT`     | `8000`              | HTTP server port                   |
| `DB_PATH`  | `./patent-cliff.db` | Path to SQLite database file       |
| `DATA_DIR` | `/data`             | Root directory for bulk data files |

### Load data

#### 1. FDA Orange Book (prefer local ZIP in production)

The pipeline can fetch the Orange Book ZIP from FDA, but some VPS or Dokploy environments receive `404` responses from FDA edge URLs. For production, the safer path is to store the ZIP on the shared volume and let the pipeline read it locally.

Recommended production path:

```sh
mkdir -p $DATA_DIR/patex
cp ~/Downloads/orangebook.zip $DATA_DIR/patex/orangebook.zip
```

Set:

```sh
ORANGE_BOOK_ZIP_PATH=/data/patex/orangebook.zip
```

The pipeline reads the ZIP directly and extracts `products.txt`, `patent.txt`, and `exclusivity.txt` in memory. No manual unzip step is required.

```sh
bun pipeline/fetch-orangebook.ts
```

#### 2. USPTO PTA and PTE data (manual download required)

PTA and PTE data comes from USPTO bulk research datasets hosted at [data.uspto.gov](https://data.uspto.gov). These files require solving a CAPTCHA to download, so they cannot be fetched automatically. Download them manually and place them in `$DATA_DIR/patex/`.

**Files to download:**

| File                | Source Dataset                                            | Page                                                                                             | Update Frequency |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------- |
| `pta_summary.csv`   | PatEx Research Dataset (ECOPAIR)                          | [data.uspto.gov/bulkdata/datasets/ecopair](https://data.uspto.gov/bulkdata/datasets/ecopair)     | Annually         |
| `pte_summary.csv`   | PatEx Research Dataset (ECOPAIR)                          | [data.uspto.gov/bulkdata/datasets/ecopair](https://data.uspto.gov/bulkdata/datasets/ecopair)     | Annually         |
| `g_application.tsv` | PatentsView Granted Patent Disambiguated Data (PVGPATDIS) | [data.uspto.gov/bulkdata/datasets/pvgpatdis](https://data.uspto.gov/bulkdata/datasets/pvgpatdis) | Quarterly        |

After downloading, extract the zip files and place the CSVs/TSV at:

```
$DATA_DIR/patex/pta_summary.csv
$DATA_DIR/patex/pte_summary.csv
$DATA_DIR/patex/g_application.tsv
```

Then run the pipeline scripts:

```sh
bun pipeline/fetch-pta.ts
bun pipeline/fetch-pte.ts
```

> `g_application.tsv` is required by both scripts — it maps application numbers to patent numbers. The pipeline will print a clear error with the download URL if any file is missing.

#### 3. PTAB proceedings (currently best-effort)

PTAB ingestion is currently best-effort. The legacy PTAB endpoint has been unstable, and the replacement USPTO API may require credentials or endpoint updates depending on environment. The tool degrades gracefully when PTAB data is unavailable, but risk scores will not incorporate active PTAB proceedings in that case.

```sh
bun pipeline/fetch-ptab.ts
```

#### Run all pipelines at once

```sh
bun pipeline/run-all.ts
```

This runs Orange Book first (required by the others), then PTA, PTE, and PTAB in parallel.

Pipeline scripts write last-updated timestamps to the `data_freshness` table. The server warns in responses if any source exceeds its TTL (Orange Book: 30 days, PTA/PTE: 90 days, PTAB: 14 days).

### Start the server

```sh
bun run dev      # development (hot reload)
bun run start    # production
```

The server exposes two endpoints:

| Endpoint      | Description                                                    |
| ------------- | -------------------------------------------------------------- |
| `GET /health` | Returns DB availability, data freshness per source             |
| `POST /mcp`   | MCP endpoint — requires CTX Protocol auth JWT for `tools/call` |

---

## Production Deployment (Dokploy)

The project ships two Dockerfiles:

| File                  | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| `Dockerfile`          | MCP server — runs `bun dist/index.js`                     |
| `Dockerfile.pipeline` | Pipeline scheduler — runs `supercronic` on a monthly cron |

Both containers share the same bind-mounted `/data` volume. On Dokploy, create a second Application pointing to `Dockerfile.pipeline` with the same bind mount (`/var/lib/dokploy/volumes/patent-cliff` → `/data`).

**Initial data file setup on the server:**

```sh
ssh user@your-vps "mkdir -p /var/lib/dokploy/volumes/patent-cliff/patex"

scp ~/Downloads/orangebook.zip     user@your-vps:/var/lib/dokploy/volumes/patent-cliff/patex/
scp ~/Downloads/pta_summary.csv    user@your-vps:/var/lib/dokploy/volumes/patent-cliff/patex/
scp ~/Downloads/pte_summary.csv    user@your-vps:/var/lib/dokploy/volumes/patent-cliff/patex/
scp ~/Downloads/g_application.tsv  user@your-vps:/var/lib/dokploy/volumes/patent-cliff/patex/
```

Set this in the pipeline app:

```sh
ORANGE_BOOK_ZIP_PATH=/data/patex/orangebook.zip
```

**When to update data files:**

| File                                  | When                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orangebook.zip`                      | Monthly — download the latest ZIP from the [Orange Book Data Files](https://www.fda.gov/drugs/drug-approvals-and-databases/orange-book-data-files) page |
| `pta_summary.csv` / `pte_summary.csv` | Annually — check [ECOPAIR dataset](https://data.uspto.gov/bulkdata/datasets/ecopair) for new release                                                    |
| `g_application.tsv`                   | Quarterly — check [PVGPATDIS dataset](https://data.uspto.gov/bulkdata/datasets/pvgpatdis) for new release                                               |

---

## Usage

### Via MCP (Claude / CTX Protocol)

The tool is named `get_patent_cliff`.

```json
{
  "tool": "get_patent_cliff",
  "input": {
    "drug_name": "Eliquis"
  }
}
```

`drug_name` accepts brand names (`"Eliquis"`, `"Humira"`, `"Jardiance"`) or active ingredients (`"apixaban"`, `"adalimumab"`, `"empagliflozin"`).

### Local testing

```sh
bun run /check-tool <drug-name>
```

### Pipeline refresh

```sh
bun run /refresh-data              # refresh all sources
bun run /refresh-data orangebook   # refresh one source
```

---

## Data Sources

| Source                                                                                                          | Data                                                                                                                             | Update Frequency | TTL     |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------- |
| [FDA Orange Book](https://www.fda.gov/drugs/drug-approvals-and-databases/orange-book-data-files)                | Approved drugs, patents, exclusivity, Para IV certifications                                                                     | Monthly          | 30 days |
| [PatEx Research Dataset — ECOPAIR](https://data.uspto.gov/bulkdata/datasets/ecopair)                            | `pta_summary.csv` — Patent Term Adjustment totals and breakdown (§154); `pte_summary.csv` — Patent Term Extension records (§156) | Annually         | 90 days |
| [PatentsView Granted Patent Disambiguated Data — PVGPATDIS](https://data.uspto.gov/bulkdata/datasets/pvgpatdis) | `g_application.tsv` — application number to patent number mapping (join key for PTA/PTE)                                         | Quarterly        | 90 days |
| USPTO PTAB API / docket sources                                                                                 | IPR/PGR/CBM proceedings                                                                                                          | Ongoing          | 14 days |

All data is public domain. PTA/PTE bulk files are ingested offline from locally-stored copies. Orange Book can be fetched automatically but is more reliable in production from a locally-mounted ZIP. PTAB ingestion is best-effort and may be unavailable until the current USPTO endpoint is stabilized.

> **PTA data coverage note:** The PatEx dataset currently covers applications through June 2023. Patents granted after that date will have `pta_days = 0` until the dataset is next updated. This is disclosed in the `data_freshness` block of every response.

---

## Response Shape

```ts
{
  drug_name: string,
  active_ingredient: string,
  nda_number: string,
  applicant: string,

  base_expiry: string,           // ISO 8601, from FDA Orange Book
  pta_adjusted_expiry: string | null,
  pte_adjusted_expiry: string | null,
  final_adjusted_expiry: string, // controlling date after all adjustments
  expiry_is_estimate: true,      // always present

  pta: PTAResult | null,
  pte: PTEResult | null,
  paragraph_iv: { active, filers, stay_active, stay_expires },
  ptab: { active_proceedings, proceedings[] },
  pediatric_exclusivity: { applies, end_date, extension_days },

  risk_score: "low" | "moderate" | "elevated" | "high" | "critical",
  risk_factors: string[],

  disclaimers: {
    estimate_notice: string,
    sealed_paragraph_iv_notice: string,
    pre_anda_notice: string,
  },

  data_freshness: {
    orangebook_last_updated: string | null,
    uspto_last_updated: string | null,
    ptab_last_updated: string | null,
    any_source_stale: boolean,
    stale_sources: string[],
    stale_warning: string | null,
  }
}
```

---

## Development

```sh
bun run typecheck   # TypeScript strict check
bun test            # unit + integration tests
bun run build       # compile to dist/
```

Tests cover PTA/PTE calculation engines, risk score synthesis, and the full tool handler against an in-memory SQLite fixture database.

---

## Disclaimer

**PTA and PTE-adjusted expiration dates are calculated estimates** based on publicly available USPTO and FDA data. USPTO frequently corrects PTA after initial grant; these dates may differ from final legally certified dates. Consult qualified patent counsel for legal certainty.

**Coverage gaps:**

1. Paragraph IV certifications under litigation seal are not visible in public FDA ANDA records. A result showing no active Paragraph IV does not guarantee that no challenge exists.
2. Pre-ANDA confidential development activity is not visible. This tool covers publicly filed ANDAs only.

These disclosures appear in every API response and are non-negotiable per CTX Protocol grant requirements.

---

## License

Data sourced from US government public domain databases. See individual source sites for terms of use.
