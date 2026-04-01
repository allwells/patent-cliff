/**
 * Database query layer.
 *
 * All SQL is hand-written — no ORM. Queries return typed rows matching
 * the interfaces in src/types/index.ts.
 */

import type { Database } from "bun:sqlite";
import type {
  ProductRow,
  OBPatentRow,
  ExclusivityRow,
  ParagraphIVRow,
  PTARecordRow,
  PTERecordRow,
  PTABProceedingRow,
  DataFreshnessRow,
} from "../types/index.js";

// ── Drug lookup ────────────────────────────────────────────────────────────────

/**
 * Find drugs by brand name or active ingredient (case-insensitive).
 * Returns all matching products — the caller picks the best match.
 */
export function findProductsByName(
  db: Database,
  query: string
): ProductRow[] {
  return db
    .prepare(
      `SELECT * FROM products
       WHERE drug_name LIKE ? COLLATE NOCASE
          OR active_ingredient LIKE ? COLLATE NOCASE
       ORDER BY rld DESC, nda_number ASC
       LIMIT 20`
    )
    .all(`%${query}%`, `%${query}%`) as ProductRow[];
}

/**
 * Find the Reference Listed Drug (rld=1) for a given NDA number.
 */
export function findRLDByNDA(
  db: Database,
  ndaNumber: string
): ProductRow | null {
  return (
    (db
      .prepare(`SELECT * FROM products WHERE nda_number = ? AND rld = 1 LIMIT 1`)
      .get(ndaNumber) as ProductRow | undefined) ?? null
  );
}

// ── Patents ────────────────────────────────────────────────────────────────────

export function getPatentsByNDA(
  db: Database,
  ndaNumber: string
): OBPatentRow[] {
  return db
    .prepare(
      `SELECT * FROM ob_patents
       WHERE nda_number = ? AND delist_flag = 0
         AND patent_number NOT LIKE '%*PED'
       ORDER BY patent_expire_date DESC`
    )
    .all(ndaNumber) as OBPatentRow[];
}

/**
 * Returns the Orange Book *PED-extended expiry for a patent, if one exists.
 * Orange Book creates a separate row suffixed with "*PED" showing the patent's
 * expiry date after the 6-month pediatric extension is applied.
 */
export function getPEDPatentExpiry(
  db: Database,
  ndaNumber: string,
  patentNumber: string
): string | null {
  const row = db
    .prepare(
      `SELECT patent_expire_date FROM ob_patents
       WHERE nda_number = ? AND patent_number = ?`
    )
    .get(ndaNumber, `${patentNumber}*PED`) as { patent_expire_date: string } | undefined;
  return row?.patent_expire_date ?? null;
}

// ── Exclusivity ────────────────────────────────────────────────────────────────

export function getExclusivityByNDA(
  db: Database,
  ndaNumber: string
): ExclusivityRow[] {
  return db
    .prepare(`SELECT * FROM exclusivity WHERE nda_number = ?`)
    .all(ndaNumber) as ExclusivityRow[];
}

// ── Paragraph IV ──────────────────────────────────────────────────────────────

export function getParagraphIVByNDA(
  db: Database,
  ndaNumber: string
): ParagraphIVRow[] {
  return db
    .prepare(`SELECT * FROM paragraph_iv WHERE nda_number = ?`)
    .all(ndaNumber) as ParagraphIVRow[];
}

// ── PTA / PTE ─────────────────────────────────────────────────────────────────

export function getPTARecord(
  db: Database,
  patentNumber: string
): PTARecordRow | null {
  return (
    (db
      .prepare(`SELECT * FROM pta_records WHERE patent_number = ?`)
      .get(patentNumber) as PTARecordRow | undefined) ?? null
  );
}

export function getPTERecord(
  db: Database,
  patentNumber: string
): PTERecordRow | null {
  return (
    (db
      .prepare(`SELECT * FROM pte_records WHERE patent_number = ?`)
      .get(patentNumber) as PTERecordRow | undefined) ?? null
  );
}

// ── PTAB ──────────────────────────────────────────────────────────────────────

export function getPTABProceedingsByPatent(
  db: Database,
  patentNumber: string
): PTABProceedingRow[] {
  return db
    .prepare(
      `SELECT * FROM ptab_proceedings
       WHERE patent_number = ?
       ORDER BY filed_date DESC`
    )
    .all(patentNumber) as PTABProceedingRow[];
}

// ── Data freshness ─────────────────────────────────────────────────────────────

export function getDataFreshness(
  db: Database
): Record<string, DataFreshnessRow> {
  const rows = db
    .prepare(`SELECT * FROM data_freshness`)
    .all() as DataFreshnessRow[];

  return Object.fromEntries(rows.map((r) => [r.source, r]));
}

// ── Query log ──────────────────────────────────────────────────────────────────

export function logQuery(
  db: Database,
  entry: {
    drug_name: string;
    resolved_nda: string | null;
    risk_score: string | null;
    response_ms: number;
    cache_hit: boolean;
  }
): void {
  db.prepare(
    `INSERT INTO query_log (drug_name, resolved_nda, risk_score, response_ms, cache_hit, queried_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    entry.drug_name,
    entry.resolved_nda,
    entry.risk_score,
    entry.response_ms,
    entry.cache_hit ? 1 : 0,
    new Date().toISOString()
  );
}
