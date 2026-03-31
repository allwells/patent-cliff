# PatentCliff — Architecture

## Data Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  OFFLINE PIPELINE  (run on schedule, not at query time)            │
│                                                                    │
│  FDA Orange Book ──┐                                               │
│  USPTO PTA data ───┼──► pipeline/*.ts ──► SQLite (patent-cliff.db) │
│  USPTO PTE data ───┤                                               │
│  USPTO PTAB API ───┘                                               │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  QUERY PATH  (per-request, in-process)                             │
│                                                                    │
│  CTX Protocol client                                               │
│       │                                                            │
│       ▼                                                            │
│  POST /mcp  (Express + StreamableHTTPServerTransport)              │
│       │                                                            │
│       ▼                                                            │
│  createContextMiddleware()  ← CTX JWT auth                         │
│       │                                                            │
│       ▼                                                            │
│  McpServer.get_patent_cliff                                        │
│       │                                                            │
│       ├── isDbAvailable() → false? ──► error response (graceful)   │
│       │                                                            │
│       ▼                                                            │
│  handlePatentCliff(db, { drug_name })                              │
│       │                                                            │
│       ├── findProductsByName()  → products table                   │
│       ├── getPatentsByNDA()     → ob_patents table                 │
│       ├── getExclusivityByNDA() → exclusivity table                │
│       ├── getParagraphIVByNDA() → paragraph_iv table               │
│       ├── getPTARecord()        → pta_records table                │
│       ├── getPTERecord()        → pte_records table                │
│       └── getPTABProceedings()  → ptab_proceedings table           │
│                                                                    │
│       ▼                                                            │
│  calculatePTA()  ← 35 U.S.C. §154                                  │
│  calculatePTE()  ← 35 U.S.C. §156                                  │
│  calculatePediatricExclusivity()                                   │
│  synthesizeVerdict()                                               │
│                                                                    │
│       ▼                                                            │
│  PatentCliffResponse  (with disclaimers, expiry_is_estimate)       │
│       │                                                            │
│       ├── logQuery() → query_log table                             │
│       └── ──────────────────────────────────► CTX client           │
└────────────────────────────────────────────────────────────────────┘
```

---

## SQLite Schema

Eight tables in `src/cache/schema.sql`:

| Table              | Source                            | Notes                                      |
| ------------------ | --------------------------------- | ------------------------------------------ |
| `products`         | FDA Orange Book `products.txt`    | Brand name, active ingredient, NDA number  |
| `ob_patents`       | FDA Orange Book `patent.txt`      | Base expiry dates per NDA                  |
| `exclusivity`      | FDA Orange Book `exclusivity.txt` | NCE, ODE, PED codes and expiry dates       |
| `paragraph_iv`     | FDA Orange Book `patent.txt`      | ANDA filers, submission dates              |
| `pta_records`      | USPTO PatentsView                 | PTA days + breakdown per patent number     |
| `pte_records`      | USPTO Official Gazette            | PTE days + breakdown per patent number     |
| `ptab_proceedings` | USPTO PTAB API                    | IPR/PGR status per patent number           |
| `data_freshness`   | Written by pipeline scripts       | Last-updated + TTL per source              |
| `query_log`        | Written at query time             | Analytics — drug, NDA, risk score, latency |

All queries are hand-written SQL. No ORM.

---

## Calculation Logic

### Patent Term Adjustment (PTA) — 35 U.S.C. §154(b)

PTA compensates patent holders for USPTO examination delays:

```
PTA = Category_A + Category_B + Category_C
        − Overlap
        − Applicant_Delay
```

- **Category A** — USPTO failed to act within 14 months of filing, respond within 4 months, or issue within 4 months of allowance fee payment
- **Category B** — Total pendency exceeds 3 years (excluding RCEs and appeals)
- **Category C** — Delays caused by interference, secrecy orders, or appeals
- **Overlap deduction** — Days counted under multiple categories are counted once
- **Applicant delay deduction** — Days caused by applicant inaction

The USPTO publishes the total PTA days on the patent face. PatentsView bulk exports carry this value. PatentCliff stores it as `pta_records.pta_days` and computes `adjusted_expiry = base_expiry + pta_days`.

All PTA results carry `is_estimate: true` — PTA is frequently corrected by the USPTO after grant and can be litigated.

### Patent Term Extension (PTE) — 35 U.S.C. §156

PTE compensates for regulatory review time lost while the FDA evaluated the drug:

```
PTE = (Testing_Phase × 0.5) + Approval_Phase − Pre_Grant_Testing
```

Subject to two caps:

- **5-year absolute cap** on PTE days
- **14-year post-approval cap** on total patent life remaining after approval

PTE and PTA are mutually exclusive — only one applies to the controlling patent. The tool applies PTE when available; otherwise PTA.

### Pediatric Exclusivity

A 6-month extension granted by FDA under 21 U.S.C. §355a. Identified via `exclusivity_code = 'PED'` in the Orange Book exclusivity table. Applied on top of the PTE/PTA-adjusted expiry.

### Controlling Patent Selection

When a drug has multiple Orange Book patents, PatentCliff selects the one with the latest base expiry as the controlling patent. PTA/PTE calculations run only on the controlling patent.

### Risk Score

`synthesizeVerdict()` maps the combination of protection signals to a five-level score:

| Score      | Condition                                                         |
| ---------- | ----------------------------------------------------------------- |
| `low`      | No Para IV, no PTAB, >5 years to expiry                           |
| `moderate` | No Para IV, no PTAB, 2–5 years to expiry                          |
| `elevated` | Active Para IV (no stay), or <2 years to expiry                   |
| `high`     | Active Para IV + 30-month stay, or active PTAB                    |
| `critical` | Active Para IV + instituted PTAB + stay expiring within 12 months |

---

## Agent System

| Agent                  | Owns                                          | Responsibility                                                   |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| **pipeline-agent**     | `pipeline/`                                   | Download, parse, and normalize bulk government files into SQLite |
| **calculations-agent** | `src/calculations/`                           | PTA (§154) and PTE (§156) statutory math                         |
| **verdict-agent**      | `src/tools/verdict.ts`                        | Risk score synthesis from all protection layers                  |
| **mcp-agent**          | `src/mcp.ts`, `src/server.ts`, `src/index.ts` | MCP server, request routing, response formatting, disclaimers    |
| **guard-agent**        | `guard-agent/`                                | Pre/post quality gates on every implementation task              |

---

## Key Design Decisions

**No live government API calls at query time.** All data is pre-loaded via pipeline scripts. This keeps p99 latency predictable and the service independent of government API availability. The trade-off is that data is only as fresh as the last pipeline run — disclosed via `data_freshness` in every response.

**Controlling patent, not all patents.** PTA and PTE are applied only to the latest-expiry patent. This gives the worst-case (latest) generic entry date, which is the commercially relevant figure for BD and investment analysis.

**PTE and PTA are mutually exclusive.** 35 U.S.C. §156(c)(1) prohibits double-counting. The tool applies PTE when a PTE record exists; otherwise PTA.

**Stateless MCP server.** One `McpServer` + `StreamableHTTPServerTransport` instance per request. No shared mutable state between requests. Required for CTX Protocol compatibility.

**Graceful DB degradation.** `initDatabase()` catches all errors and leaves `db = null`. The MCP handler checks `isDbAvailable()` before every query and returns a structured error response rather than crashing.

---

## File Layout

```
patent-cliff/
├── pipeline/
│   ├── fetch-orangebook.ts     # FDA Orange Book ingestion
│   ├── fetch-pta.ts            # USPTO PTA ingestion
│   ├── fetch-pte.ts            # USPTO PTE ingestion
│   └── fetch-ptab.ts           # USPTO PTAB ingestion
├── src/
│   ├── cache/
│   │   ├── schema.sql          # SQLite schema + data_freshness seed rows
│   │   ├── db.ts               # DB init, migration, graceful degradation
│   │   └── queries.ts          # All hand-written SQL query functions
│   ├── calculations/
│   │   ├── pta.ts              # 35 U.S.C. §154 PTA math
│   │   ├── pte.ts              # 35 U.S.C. §156 PTE math
│   │   └── pediatric.ts        # +6 month pediatric exclusivity
│   ├── tools/
│   │   ├── patent-cliff.ts     # Main tool handler — orchestration
│   │   └── verdict.ts          # Risk score synthesis
│   ├── types/
│   │   └── index.ts            # All shared TypeScript interfaces
│   ├── utils/
│   │   ├── logger.ts           # Structured JSON logger
│   │   └── http.ts             # fetchWithTimeout
│   ├── mcp.ts                  # McpServer + tool registration
│   ├── server.ts               # Express server, /health, /mcp endpoints
│   └── index.ts                # Entry point: env → DB → server
├── tests/
│   ├── pta.test.ts             # PTA calculation unit tests
│   ├── pte.test.ts             # PTE calculation unit tests
│   ├── verdict.test.ts         # Risk score unit tests
│   └── patent-cliff.test.ts    # Integration tests (in-memory SQLite)
├── guard-agent/
│   └── memory/
│       └── check-history.md    # Guard pre/post run history
├── .claude/
│   └── PLAN.md                 # Implementation progress tracker
├── CLAUDE.md                   # Project instructions for Claude Code
├── .env.example
└── package.json
```
