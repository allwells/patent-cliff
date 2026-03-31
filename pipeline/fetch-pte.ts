/**
 * USPTO Patent Term Extension (PTE) pipeline script.
 *
 * PTE is granted per 35 U.S.C. §156 to compensate for time lost during
 * FDA regulatory review. Only one patent per NDA can receive PTE.
 *
 * Data source: USPTO PTE list (published in the Official Gazette and
 * available as a structured list from the USPTO website).
 *
 * Run via: bun pipeline/fetch-pte.ts
 */

import { Database } from "bun:sqlite";
import { config } from "dotenv";

config();

const DB_PATH = process.env["DB_PATH"] ?? "./patent-cliff.db";

// USPTO publishes a list of all PTE grants. This page has a structured table.
const USPTO_PTE_LIST_URL =
  "https://www.uspto.gov/patent/laws-and-regulations/patent-term-extension/patent-term-extension-status-report";

interface PipelineResult {
  source: "pte";
  status: "success" | "partial" | "failed";
  rows_inserted: number;
  rows_skipped: number;
  last_updated: string;
  errors: string[];
}

interface PTERecord {
  patent_number: string;
  pte_days: number;
  nda_submission_date: string | null;
  nda_approval_date: string | null;
  grant_date: string | null;
  uspto_pte_days: number;
}

async function fetchPTE(): Promise<void> {
  const result: PipelineResult = {
    source: "pte",
    status: "failed",
    rows_inserted: 0,
    rows_skipped: 0,
    last_updated: new Date().toISOString(),
    errors: [],
  };

  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  try {
    const schemaPath = new URL("../src/cache/schema.sql", import.meta.url).pathname;
    const { readFileSync } = await import("fs");
    db.exec(readFileSync(schemaPath, "utf-8"));

    // Only fetch PTE for patents we track in ob_patents
    const targetPatents = db
      .prepare("SELECT DISTINCT patent_number FROM ob_patents")
      .all() as Array<{ patent_number: string }>;

    if (targetPatents.length === 0) {
      result.status = "failed";
      result.errors.push("ob_patents table is empty — run orangebook pipeline first");
      return;
    }

    const targetSet = new Set(targetPatents.map((r) => r.patent_number));

    console.error(
      JSON.stringify({
        level: "info",
        source: "pte",
        message: "Fetching USPTO PTE records...",
      })
    );

    // Fetch the USPTO PTE status report page and parse the table
    const pteRecords = await fetchPTEFromUSPTO(targetSet);

    const insertPTE = db.prepare(`
      INSERT OR REPLACE INTO pte_records
        (patent_number, pte_days, testing_phase_credit, approval_phase_credit,
         pre_grant_deduction, cap_applied, nda_submission_date, nda_approval_date,
         grant_date, uspto_pte_days, last_updated)
      VALUES
        (@patent_number, @pte_days, @testing_phase_credit, @approval_phase_credit,
         @pre_grant_deduction, @cap_applied, @nda_submission_date, @nda_approval_date,
         @grant_date, @uspto_pte_days, @last_updated)
    `);

    const runInserts = db.transaction((records: PTERecord[]) => {
      for (const rec of records) {
        try {
          insertPTE.run({
            patent_number: rec.patent_number,
            pte_days: rec.pte_days,
            // Breakdown fields computed by calculations engine (Phase 3)
            // Here we store the raw PTE days from USPTO; breakdown computed on query
            testing_phase_credit: 0,
            approval_phase_credit: 0,
            pre_grant_deduction: 0,
            cap_applied: "none",
            nda_submission_date: rec.nda_submission_date,
            nda_approval_date: rec.nda_approval_date,
            grant_date: rec.grant_date,
            uspto_pte_days: rec.uspto_pte_days,
            last_updated: result.last_updated,
          });
          result.rows_inserted++;
        } catch {
          result.rows_skipped++;
        }
      }
    });

    runInserts(pteRecords);

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('pte', ?, ?, 'success')
    `).run(result.last_updated, result.rows_inserted);

    result.status = result.rows_skipped > 0 ? "partial" : "success";
    console.error(
      JSON.stringify({
        level: "info",
        source: "pte",
        message: "PTE pipeline complete",
        rows_inserted: result.rows_inserted,
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    result.status = "failed";
    console.error(JSON.stringify({ level: "error", source: "pte", message }));

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('pte', ?, 0, 'failed')
    `).run(result.last_updated);
  } finally {
    db.close();
  }

  console.log(JSON.stringify(result));
}

async function fetchPTEFromUSPTO(targetSet: Set<string>): Promise<PTERecord[]> {
  // USPTO PTE data is available in the PatentsView dataset as well.
  // We query the PatentsView API for PTE-specific fields.
  const url = "https://api.patentsview.org/patents/query";

  const targetPatents = [...targetSet];
  const records: PTERecord[] = [];
  const BATCH_SIZE = 25;

  for (let i = 0; i < targetPatents.length; i += BATCH_SIZE) {
    const batch = targetPatents.slice(i, i + BATCH_SIZE);

    const body = {
      q: { patent_number: batch },
      f: [
        "patent_number",
        "patent_date",
        "patent_term_extension",
        "patent_term_extension_application_date",
        "patent_term_extension_approved_date",
      ],
      o: { per_page: batch.length },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PatentCliff/1.0 (patent data pipeline)",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) continue;

    const data = (await res.json()) as {
      patents?: Array<{
        patent_id: string;
        patent_date?: string;
        patent_term_extension?: number;
        patent_term_extension_application_date?: string;
        patent_term_extension_approved_date?: string;
      }>;
    };

    for (const p of data.patents ?? []) {
      if (p.patent_term_extension && p.patent_term_extension > 0) {
        records.push({
          patent_number: p.patent_id,
          pte_days: p.patent_term_extension,
          nda_submission_date: p.patent_term_extension_application_date ?? null,
          nda_approval_date: p.patent_term_extension_approved_date ?? null,
          grant_date: p.patent_date ?? null,
          uspto_pte_days: p.patent_term_extension,
        });
      }
    }

    if (i + BATCH_SIZE < targetPatents.length) {
      await sleep(200);
    }
  }

  return records;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

fetchPTE().catch((err) => {
  console.error(err);
  process.exit(1);
});
