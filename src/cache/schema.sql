-- PatentCliff SQLite Schema
-- All data sourced from US government public domain databases.
-- Updated via pipeline scripts in /pipeline — not written at query time.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- FDA Orange Book: Approved Drug Products
-- Source: products.txt
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  nda_number        TEXT NOT NULL,          -- e.g. "N022426"
  drug_name         TEXT NOT NULL,          -- brand name
  active_ingredient TEXT NOT NULL,
  applicant         TEXT NOT NULL,
  strength          TEXT NOT NULL,
  dosage_form       TEXT NOT NULL,
  route             TEXT NOT NULL,
  approval_date     TEXT,                   -- ISO 8601
  te_code           TEXT,                   -- therapeutic equivalence code
  rld               INTEGER NOT NULL DEFAULT 0,  -- reference listed drug flag
  type              TEXT NOT NULL,          -- "RX", "OTC", etc.
  PRIMARY KEY (nda_number, active_ingredient, strength, dosage_form, route)
);

CREATE INDEX IF NOT EXISTS idx_products_drug_name       ON products(drug_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_active_ingredient ON products(active_ingredient COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_nda_number      ON products(nda_number);

-- ============================================================
-- FDA Orange Book: Patents
-- Source: patent.txt
-- ============================================================
CREATE TABLE IF NOT EXISTS ob_patents (
  nda_number        TEXT NOT NULL,
  patent_number     TEXT NOT NULL,          -- without "US" prefix
  patent_expire_date TEXT NOT NULL,         -- ISO 8601, base expiry from Orange Book
  drug_substance_flag INTEGER NOT NULL DEFAULT 0,
  drug_product_flag   INTEGER NOT NULL DEFAULT 0,
  patent_use_code   TEXT,                   -- use code or NULL
  delist_flag       INTEGER NOT NULL DEFAULT 0,
  submission_date   TEXT,                   -- ISO 8601
  PRIMARY KEY (nda_number, patent_number, patent_use_code)
);

CREATE INDEX IF NOT EXISTS idx_ob_patents_nda       ON ob_patents(nda_number);
CREATE INDEX IF NOT EXISTS idx_ob_patents_patent    ON ob_patents(patent_number);

-- ============================================================
-- FDA Orange Book: Exclusivity Periods
-- Source: exclusivity.txt
-- ============================================================
CREATE TABLE IF NOT EXISTS exclusivity (
  nda_number        TEXT NOT NULL,
  exclusivity_code  TEXT NOT NULL,          -- e.g. "NCE", "ODE", "PED"
  exclusivity_date  TEXT NOT NULL,          -- ISO 8601, exclusivity expiry date
  PRIMARY KEY (nda_number, exclusivity_code)
);

CREATE INDEX IF NOT EXISTS idx_exclusivity_nda ON exclusivity(nda_number);

-- ============================================================
-- FDA Orange Book: Paragraph IV Certifications
-- Source: patent.txt (para_iv column)
-- Note: certifications under litigation seal are NOT present here —
-- this gap must be disclosed in every PatentCliff response.
-- ============================================================
CREATE TABLE IF NOT EXISTS paragraph_iv (
  nda_number        TEXT NOT NULL,
  patent_number     TEXT NOT NULL,
  applicant_name    TEXT,                   -- ANDA filer, if available
  anda_number       TEXT,
  submission_date   TEXT,                   -- ISO 8601
  PRIMARY KEY (nda_number, patent_number, anda_number)
);

CREATE INDEX IF NOT EXISTS idx_para_iv_nda     ON paragraph_iv(nda_number);
CREATE INDEX IF NOT EXISTS idx_para_iv_patent  ON paragraph_iv(patent_number);

-- ============================================================
-- USPTO: Patent Term Adjustment (PTA)
-- Source: USPTO PatentsView / PAIR bulk data
-- Calculated per 35 U.S.C. §154(b)
-- ============================================================
CREATE TABLE IF NOT EXISTS pta_records (
  patent_number       TEXT PRIMARY KEY,     -- without "US" prefix
  pta_days            INTEGER NOT NULL DEFAULT 0,
  -- Delay breakdown (days)
  category_a_days     INTEGER NOT NULL DEFAULT 0,
  category_b_days     INTEGER NOT NULL DEFAULT 0,
  category_c_days     INTEGER NOT NULL DEFAULT 0,
  overlap_deduction   INTEGER NOT NULL DEFAULT 0,
  applicant_delay     INTEGER NOT NULL DEFAULT 0,
  -- Dates
  grant_date          TEXT,                 -- ISO 8601
  application_date    TEXT,                 -- ISO 8601
  -- Raw USPTO value for cross-check
  uspto_pta_days      INTEGER,
  last_updated        TEXT NOT NULL         -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_pta_patent ON pta_records(patent_number);

-- ============================================================
-- USPTO: Patent Term Extension (PTE)
-- Source: USPTO PatentsView / Official Gazette
-- Calculated per 35 U.S.C. §156
-- ============================================================
CREATE TABLE IF NOT EXISTS pte_records (
  patent_number           TEXT PRIMARY KEY,  -- without "US" prefix
  pte_days                INTEGER NOT NULL DEFAULT 0,
  -- Breakdown (days)
  testing_phase_credit    INTEGER NOT NULL DEFAULT 0,
  approval_phase_credit   INTEGER NOT NULL DEFAULT 0,
  pre_grant_deduction     INTEGER NOT NULL DEFAULT 0,
  cap_applied             TEXT,              -- "5_year" | "14_year_post_approval" | "none"
  -- Dates used in calculation
  nda_submission_date     TEXT,             -- ISO 8601, start of regulatory review
  nda_approval_date       TEXT,             -- ISO 8601, end of regulatory review
  grant_date              TEXT,             -- ISO 8601
  -- Raw USPTO value for cross-check
  uspto_pte_days          INTEGER,
  last_updated            TEXT NOT NULL     -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_pte_patent ON pte_records(patent_number);

-- ============================================================
-- PTAB: Inter Partes Review Proceedings
-- Source: USPTO PTAB API
-- ============================================================
CREATE TABLE IF NOT EXISTS ptab_proceedings (
  case_number         TEXT PRIMARY KEY,     -- e.g. "IPR2024-00123"
  patent_number       TEXT NOT NULL,        -- without "US" prefix
  petitioner          TEXT,
  respondent          TEXT,
  status              TEXT NOT NULL,        -- "Instituted" | "Final Written Decision" | "Settled" | "Denied"
  type                TEXT NOT NULL DEFAULT 'IPR',  -- "IPR" | "PGR" | "CBM"
  filed_date          TEXT,                 -- ISO 8601
  institution_date    TEXT,                 -- ISO 8601
  decision_date       TEXT,                 -- ISO 8601
  last_updated        TEXT NOT NULL         -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_ptab_patent ON ptab_proceedings(patent_number);
CREATE INDEX IF NOT EXISTS idx_ptab_status ON ptab_proceedings(status);

-- ============================================================
-- Data Freshness Tracking
-- Updated by pipeline scripts after each successful run
-- ============================================================
CREATE TABLE IF NOT EXISTS data_freshness (
  source        TEXT PRIMARY KEY,           -- "orangebook" | "pta" | "pte" | "ptab"
  last_updated  TEXT NOT NULL,              -- ISO 8601
  rows_current  INTEGER NOT NULL DEFAULT 0,
  last_run_status TEXT NOT NULL DEFAULT 'unknown',  -- "success" | "partial" | "failed"
  ttl_days      INTEGER NOT NULL DEFAULT 30  -- stale threshold per source
);

-- Seed default TTLs — pipeline scripts update rows on successful runs.
-- orangebook: monthly (30d), pta/pte: quarterly (90d), ptab: bi-weekly (14d)
INSERT OR IGNORE INTO data_freshness (source, last_updated, rows_current, last_run_status, ttl_days)
VALUES
  ('orangebook', '1970-01-01T00:00:00.000Z', 0, 'never_run', 30),
  ('pta',        '1970-01-01T00:00:00.000Z', 0, 'never_run', 90),
  ('pte',        '1970-01-01T00:00:00.000Z', 0, 'never_run', 90),
  ('ptab',       '1970-01-01T00:00:00.000Z', 0, 'never_run', 14);

-- ============================================================
-- Query Log (Analytics)
-- Written at query time by the MCP tool handler
-- ============================================================
CREATE TABLE IF NOT EXISTS query_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  drug_name     TEXT NOT NULL,
  resolved_nda  TEXT,
  risk_score    TEXT,
  response_ms   INTEGER,
  cache_hit     INTEGER NOT NULL DEFAULT 0,
  queried_at    TEXT NOT NULL               -- ISO 8601
);
