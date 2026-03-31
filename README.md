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

| Variable  | Default             | Description                  |
| --------- | ------------------- | ---------------------------- |
| `PORT`    | `8000`              | HTTP server port             |
| `DB_PATH` | `./patent-cliff.db` | Path to SQLite database file |

### Load data

Run each pipeline script once to populate the database. These download and parse government bulk files into SQLite — no live API calls happen at query time.

```sh
bun pipeline/fetch-orangebook.ts   # FDA Orange Book (products, patents, exclusivity, Para IV)
bun pipeline/fetch-pta.ts          # USPTO Patent Term Adjustment records
bun pipeline/fetch-pte.ts          # USPTO Patent Term Extension records
bun pipeline/fetch-ptab.ts         # PTAB IPR/PGR docket data
```

Pipeline scripts write last-updated timestamps to the `data_freshness` table. The server will warn in responses if any source exceeds its TTL (Orange Book: 30 days, PTA/PTE: 90 days, PTAB: 14 days).

> **Note:** FDA Orange Book download URLs in `pipeline/fetch-orangebook.ts` are placeholders — confirm the exact URLs against live FDA data before the first production pipeline run. See PLAN.md post-impl note.

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

| Source                                                                                           | Data                                                         | Update Frequency | TTL     |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------- | ------- |
| [FDA Orange Book](https://www.fda.gov/drugs/drug-approvals-and-databases/orange-book-data-files) | Approved drugs, patents, exclusivity, Para IV certifications | Monthly          | 30 days |
| [USPTO PatentsView](https://patentsview.org/download/data-download-tables)                       | Patent Term Adjustment (PTA) records                         | Periodic         | 90 days |
| [USPTO Official Gazette](https://www.uspto.gov/patents/patent-term-extension)                    | Patent Term Extension (PTE) records                          | Periodic         | 90 days |
| [USPTO PTAB](https://developer.uspto.gov/api-catalog/ptab-api-v2)                                | IPR/PGR/CBM proceedings                                      | Bi-weekly        | 14 days |

All data is public domain. Government bulk files are ingested offline — no live API calls at query time.

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
