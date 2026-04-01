/**
 * USPTO Patent Term Adjustment (PTA) pipeline script.
 *
 * Sources PTA data from USPTO PatentsView bulk downloads.
 * PTA is granted per 35 U.S.C. §154(b) to compensate for USPTO examination delays.
 *
 * PatentsView patent table includes `patent_term_adjustment` (total PTA days).
 * Detailed Category A/B/C breakdowns are only in USPTO PAIR — we use the total
 * from PatentsView and store zeros for breakdown fields (to be enriched later).
 *
 * Run via: bun pipeline/fetch-pta.ts
 */

import { Database } from "bun:sqlite";
import { config } from "dotenv";

config();

const DB_PATH = process.env["DB_PATH"] ?? "/data/patent-cliff.db";
const PATENTSVIEW_API_KEY = process.env["PATENTSVIEW_API_KEY"] ?? "";

interface PipelineResult {
  source: "pta";
  status: "success" | "partial" | "failed";
  rows_inserted: number;
  rows_skipped: number;
  last_updated: string;
  errors: string[];
}

async function fetchPTA(): Promise<void> {
  const result: PipelineResult = {
    source: "pta",
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
    if (!PATENTSVIEW_API_KEY) {
      console.error(
        JSON.stringify({
          level: "warn",
          source: "pta",
          message: "PATENTSVIEW_API_KEY is not set — skipping PTA pipeline. Register at https://search.patentsview.org/apikey",
        })
      );
      result.status = "partial";
      result.errors.push("PATENTSVIEW_API_KEY not set");
      console.log(JSON.stringify(result));
      return;
    }

    const schemaPath = new URL("../src/cache/schema.sql", import.meta.url).pathname;
    const { readFileSync } = await import("fs");
    db.exec(readFileSync(schemaPath, "utf-8"));

    // We only need patents that are referenced in our ob_patents table.
    // Pull the list of patent numbers we care about first.
    const targetPatents = db
      .prepare("SELECT DISTINCT patent_number FROM ob_patents WHERE patent_number NOT LIKE '%*PED'")
      .all() as Array<{ patent_number: string }>;

    if (targetPatents.length === 0) {
      console.error(
        JSON.stringify({
          level: "warn",
          source: "pta",
          message: "No patents in ob_patents table — run orangebook pipeline first",
        })
      );
      result.status = "failed";
      result.errors.push("ob_patents table is empty — run orangebook pipeline first");
      return;
    }

    const targetSet = new Set(targetPatents.map((r) => r.patent_number));

    console.error(
      JSON.stringify({
        level: "info",
        source: "pta",
        message: `Fetching PTA data for ${targetSet.size} patents from PatentsView`,
      })
    );

    // PatentsView API — query specific patents by number instead of bulk download
    // More efficient than downloading the full patent.tsv (~1GB)
    const insertPTA = db.prepare(`
      INSERT OR REPLACE INTO pta_records
        (patent_number, pta_days, category_a_days, category_b_days, category_c_days,
         overlap_deduction, applicant_delay, grant_date, application_date, uspto_pta_days, last_updated)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // PatentsView query API — batch by 25 patents per request
    const BATCH_SIZE = 25;
    const patents = [...targetSet];

    const runInserts = db.transaction((rows: PTARow[]) => {
      for (const row of rows) {
        insertPTA.run(
          row.patent_number,
          row.pta_days,
          row.category_a_days,
          row.category_b_days,
          row.category_c_days,
          row.overlap_deduction,
          row.applicant_delay,
          row.grant_date,
          row.application_number,
          row.uspto_pta_days,
          row.last_updated
        );
        result.rows_inserted++;
      }
    });

    for (let i = 0; i < patents.length; i += BATCH_SIZE) {
      const batch = patents.slice(i, i + BATCH_SIZE);
      const rows = await fetchPatentsViewBatch(batch, result.last_updated);
      if (rows.length > 0) {
        runInserts(rows);
      }
      if (i + BATCH_SIZE < patents.length) {
        await sleep(200);
      }
    }

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('pta', ?, ?, 'success')
    `).run(result.last_updated, result.rows_inserted);

    result.status = result.rows_skipped > 0 ? "partial" : "success";
    console.error(
      JSON.stringify({
        level: "info",
        source: "pta",
        message: "PTA pipeline complete",
        rows_inserted: result.rows_inserted,
        rows_skipped: result.rows_skipped,
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    result.status = "failed";
    console.error(
      JSON.stringify({ level: "error", source: "pta", message })
    );

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('pta', ?, 0, 'failed')
    `).run(result.last_updated);
  } finally {
    db.close();
  }

  console.log(JSON.stringify(result));
}

interface PatentsViewPatent {
  patent_id: string;
  patent_date: string;
  patent_term_adjustment?: number;
}

interface PTARow {
  patent_number: string;
  pta_days: number;
  category_a_days: number;
  category_b_days: number;
  category_c_days: number;
  overlap_deduction: number;
  applicant_delay: number;
  grant_date: string | null;
  application_number: null;
  uspto_pta_days: number | null;
  last_updated: string;
}

async function fetchPatentsViewBatch(
  patentNumbers: string[],
  timestamp: string
): Promise<PTARow[]> {
  const q = JSON.stringify({ patent_id: patentNumbers });
  const f = JSON.stringify(["patent_id", "patent_date", "patent_term_adjustment"]);
  const o = JSON.stringify({ per_page: patentNumbers.length });
  const url = `https://search.patentsview.org/api/v1/patents?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}&o=${encodeURIComponent(o)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Api-Key": PATENTSVIEW_API_KEY,
      "User-Agent": "PatentCliff/1.0 (patent data pipeline)",
    },
  });

  if (!res.ok) {
    throw new Error(`PatentsView API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { patents?: PatentsViewPatent[] };
  const patents = data.patents ?? [];

  return patents.map((p) => ({
    patent_number: p.patent_id,
    pta_days: p.patent_term_adjustment ?? 0,
    category_a_days: 0,
    category_b_days: 0,
    category_c_days: 0,
    overlap_deduction: 0,
    applicant_delay: 0,
    grant_date: p.patent_date ?? null,
    application_number: null,
    uspto_pta_days: p.patent_term_adjustment ?? null,
    last_updated: timestamp,
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

fetchPTA().catch((err) => {
  console.error(err);
  process.exit(1);
});
