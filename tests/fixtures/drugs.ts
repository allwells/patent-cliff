/**
 * Test fixtures — synthetic drug data covering all five risk levels.
 *
 * These are not real drug records. They are constructed to exercise every
 * code path in the calculations and verdict layers. NDA numbers use the
 * "N999XXX" range which does not overlap with real Orange Book entries.
 */

import { addYears, addMonths, subMonths, subYears, format } from "date-fns";
import type { Database } from "bun:sqlite";

const today = new Date();
const fmt = (d: Date) => format(d, "yyyy-MM-dd");

// ── Shared helpers ─────────────────────────────────────────────────────────────

export const fixtures = {
  /**
   * LOW risk: no Para IV, no PTAB, expires 8 years from now.
   * PTA adds 180 days on top of a base 8-year expiry.
   */
  lowRisk: {
    nda_number: "N999001",
    drug_name: "TESTOVAX",
    active_ingredient: "testovaxin",
    applicant: "TestPharma Inc",
    base_expiry: fmt(addYears(today, 8)),
    pta_days: 180,
    pte_days: 0,
    has_para_iv: false,
    has_ptab: false,
    has_pediatric: false,
  },

  /**
   * MODERATE risk: no Para IV, no PTAB, expires 3.5 years from now.
   * No PTA or PTE — base expiry only.
   */
  moderateRisk: {
    nda_number: "N999002",
    drug_name: "CALCIPREX",
    active_ingredient: "calciprexin",
    applicant: "MedCo Pharmaceuticals",
    base_expiry: fmt(addMonths(today, 42)),
    pta_days: 0,
    pte_days: 0,
    has_para_iv: false,
    has_ptab: false,
    has_pediatric: false,
  },

  /**
   * ELEVATED risk: active Para IV, no 30-month stay (submission >30 months ago),
   * expires ~4 years from now. PTE adds 2 years.
   */
  elevatedRisk: {
    nda_number: "N999003",
    drug_name: "VORIMAX",
    active_ingredient: "vorimaxine",
    applicant: "GeneriX Corp",
    base_expiry: fmt(addYears(today, 2)),
    pta_days: 0,
    pte_days: 730, // 2-year PTE extension
    nda_approval_date: fmt(subYears(today, 5)),
    has_para_iv: true,
    para_iv_submission_date: fmt(subMonths(today, 36)), // stay expired
    has_ptab: false,
    has_pediatric: false,
  },

  /**
   * HIGH risk: active Para IV with active 30-month stay. No PTAB.
   */
  highRisk: {
    nda_number: "N999004",
    drug_name: "BREXIPINE",
    active_ingredient: "brexipinol",
    applicant: "NovaMed Therapeutics",
    base_expiry: fmt(addYears(today, 3)),
    pta_days: 90,
    pte_days: 0,
    has_para_iv: true,
    para_iv_submission_date: fmt(subMonths(today, 6)), // stay still active
    has_ptab: false,
    has_pediatric: false,
  },

  /**
   * CRITICAL risk: active Para IV + active PTAB + stay expiring within 12 months.
   * Pediatric exclusivity also applies.
   */
  criticalRisk: {
    nda_number: "N999005",
    drug_name: "INFLUXAR",
    active_ingredient: "influxarib",
    applicant: "BioPharma Solutions",
    base_expiry: fmt(addYears(today, 2)),
    pta_days: 0,
    pte_days: 0,
    has_para_iv: true,
    para_iv_submission_date: fmt(subMonths(today, 21)), // stay expires in ~9 months
    has_ptab: true,
    has_pediatric: true,
    pediatric_end_date: fmt(addMonths(addYears(today, 2), 6)),
  },

  /**
   * NOT FOUND: drug name that doesn't exist in the database.
   */
  notFound: {
    drug_name: "NONEXISTENTDRUG99",
  },
} as const;

// ── SQL seed helpers ───────────────────────────────────────────────────────────

type FixtureKey = keyof Omit<typeof fixtures, "notFound">;

export function seedProduct(db: Database, key: FixtureKey): void {
  const f = fixtures[key];
  const approvalDate = "nda_approval_date" in f
    ? f.nda_approval_date
    : fmt(subYears(today, 3));
  db.query(`
    INSERT OR REPLACE INTO products
      (nda_number, drug_name, active_ingredient, applicant, strength, dosage_form, route, approval_date, rld, type)
    VALUES (?, ?, ?, ?, '10mg', 'Tablet', 'Oral', ?, 1, 'RX')
  `).run(f.nda_number, f.drug_name, f.active_ingredient, f.applicant, approvalDate);
}

export function seedPatent(db: Database, key: FixtureKey, patentNumber: string): void {
  const f = fixtures[key];
  db.query(`
    INSERT OR REPLACE INTO ob_patents
      (nda_number, patent_number, patent_expire_date, drug_substance_flag, drug_product_flag, delist_flag)
    VALUES (?, ?, ?, 1, 0, 0)
  `).run(f.nda_number, patentNumber, f.base_expiry);
}

export function seedPTA(db: Database, key: FixtureKey, patentNumber: string): void {
  const f = fixtures[key];
  if (f.pta_days === 0) return;
  db.query(`
    INSERT OR REPLACE INTO pta_records
      (patent_number, pta_days, category_a_days, category_b_days, category_c_days,
       overlap_deduction, applicant_delay, last_updated)
    VALUES (?, ?, 0, 0, 0, 0, 0, ?)
  `).run(patentNumber, f.pta_days, fmt(today));
}

export function seedPTE(db: Database, key: FixtureKey, patentNumber: string): void {
  const f = fixtures[key];
  if (f.pte_days === 0) return;
  const approvalDate = "nda_approval_date" in f ? f.nda_approval_date : null;
  db.query(`
    INSERT OR REPLACE INTO pte_records
      (patent_number, pte_days, testing_phase_credit, approval_phase_credit,
       pre_grant_deduction, cap_applied, nda_approval_date, last_updated)
    VALUES (?, ?, 0, ?, 0, 'none', ?, ?)
  `).run(patentNumber, f.pte_days, f.pte_days, approvalDate, fmt(today));
}

export function seedParagraphIV(db: Database, key: FixtureKey, patentNumber: string): void {
  const f = fixtures[key];
  if (!f.has_para_iv) return;
  const submissionDate = "para_iv_submission_date" in f
    ? f.para_iv_submission_date
    : fmt(subMonths(today, 6));
  db.query(`
    INSERT OR REPLACE INTO paragraph_iv
      (nda_number, patent_number, applicant_name, anda_number, submission_date)
    VALUES (?, ?, 'Generic Filer LLC', 'A999001', ?)
  `).run(f.nda_number, patentNumber, submissionDate);
}

export function seedPTAB(db: Database, key: FixtureKey, patentNumber: string): void {
  const f = fixtures[key];
  if (!f.has_ptab) return;
  db.query(`
    INSERT OR REPLACE INTO ptab_proceedings
      (case_number, patent_number, petitioner, respondent, status, type, filed_date, last_updated)
    VALUES (?, ?, 'Generic Petitioner Inc', ?, 'Instituted', 'IPR', ?, ?)
  `).run(
    `IPR2024-${f.nda_number.slice(-3)}`,
    patentNumber,
    f.applicant,
    fmt(subMonths(today, 8)),
    fmt(today)
  );
}

export function seedPediatric(db: Database, key: FixtureKey): void {
  const f = fixtures[key];
  if (!f.has_pediatric) return;
  const endDate = "pediatric_end_date" in f
    ? f.pediatric_end_date
    : fmt(addMonths(today, 6));
  db.query(`
    INSERT OR REPLACE INTO exclusivity (nda_number, exclusivity_code, exclusivity_date)
    VALUES (?, 'PED', ?)
  `).run(f.nda_number, endDate);
}

export function seedFreshness(db: Database): void {
  const now = fmt(today);
  for (const source of ["orangebook", "pta", "pte", "ptab"]) {
    db.query(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES (?, ?, 100, 'success')
    `).run(source, now);
  }
}

/**
 * Seed all data for a fixture in one call.
 */
export function seedAll(db: Database, key: FixtureKey, patentNumber: string): void {
  seedProduct(db, key);
  seedPatent(db, key, patentNumber);
  seedPTA(db, key, patentNumber);
  seedPTE(db, key, patentNumber);
  seedParagraphIV(db, key, patentNumber);
  seedPTAB(db, key, patentNumber);
  seedPediatric(db, key);
}
