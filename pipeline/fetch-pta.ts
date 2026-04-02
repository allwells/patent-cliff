/**
 * USPTO Patent Term Adjustment (PTA) pipeline script.
 *
 * Sources PTA data from two locally-stored bulk files:
 *
 *   1. pta_summary.csv  — from PatEx Research Dataset (ECOPAIR)
 *      Columns: application_number, pto_delay_a, pto_delay_b, pto_delay_c,
 *               overlap_pto_delay, nonoverlap_pto_delay, pto_manual_adjustment,
 *               applicant_delay, patent_term_adjustment
 *      Download: https://data.uspto.gov/bulkdata/datasets/ecopair
 *      Updates:  Annually
 *
 *   2. g_application.tsv — from PatentsView Granted Patent Disambiguated Data (PVGPATDIS)
 *      Columns: application_id, patent_id, patent_application_type, filing_date, ...
 *      Download: https://data.uspto.gov/bulkdata/datasets/pvgpatdis
 *      Updates:  Quarterly
 *
 * These files require a CAPTCHA to download (human-only) and are stored at
 * DATA_DIR/patex/. Copy new versions there when the datasets are updated.
 *
 * Join: pta_summary.application_number → g_application.application_id → g_application.patent_id
 *
 * Run via: bun pipeline/fetch-pta.ts
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { config } from "dotenv";

config();

const DB_PATH = process.env["DB_PATH"] ?? "/data/patent-cliff.db";
const DATA_DIR = process.env["DATA_DIR"] ?? "/data";
const PATEX_DIR = join(DATA_DIR, "patex");

const PTA_SUMMARY_PATH = process.env["PTA_SUMMARY_PATH"] ?? join(PATEX_DIR, "pta_summary.csv");
const G_APPLICATION_PATH = process.env["G_APPLICATION_PATH"] ?? join(PATEX_DIR, "g_application.tsv");

interface PipelineResult {
  source: "pta";
  status: "success" | "partial" | "failed";
  rows_inserted: number;
  rows_skipped: number;
  last_updated: string;
  errors: string[];
}

interface PTARow {
  patent_number: string;
  pta_days: number;
  category_a_days: number;
  category_b_days: number;
  category_c_days: number;
  overlap_deduction: number;
  applicant_delay: number;
  nonoverlap_pto_delay: number;
  pto_manual_adjustment: number;
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
    const schemaPath = new URL("../src/cache/schema.sql", import.meta.url).pathname;
    const { readFileSync } = await import("fs");
    db.exec(readFileSync(schemaPath, "utf-8"));

    await assertFileExists(PTA_SUMMARY_PATH, "pta_summary.csv", "ecopair");
    await assertFileExists(G_APPLICATION_PATH, "g_application.tsv", "pvgpatdis");

    const targetPatents = db
      .prepare("SELECT DISTINCT patent_number FROM ob_patents WHERE patent_number NOT LIKE '%*PED'")
      .all() as Array<{ patent_number: string }>;

    if (targetPatents.length === 0) {
      result.status = "failed";
      result.errors.push("ob_patents table is empty — run orangebook pipeline first");
      console.log(JSON.stringify(result));
      return;
    }

    const targetSet = new Set(targetPatents.map((r) => normalizePatentNumber(r.patent_number)));

    console.error(JSON.stringify({
      level: "info", source: "pta",
      message: `Building application→patent map for ${targetSet.size} target patents...`,
    }));

    // Step 1: stream g_application.tsv → build map of application_id for target patents only
    const patentToApp = await buildPatentToApplicationMap(G_APPLICATION_PATH, targetSet);
    const appToPatent = new Map<string, string>();
    for (const [patent, app] of patentToApp) appToPatent.set(app, patent);

    console.error(JSON.stringify({
      level: "info", source: "pta",
      message: `Mapped ${patentToApp.size} of ${targetSet.size} target patents to application numbers`,
    }));

    // Step 2: stream pta_summary.csv → collect PTA rows for matched application numbers
    const ptaRows = await collectPTARows(PTA_SUMMARY_PATH, appToPatent);

    console.error(JSON.stringify({
      level: "info", source: "pta",
      message: `Found PTA data for ${ptaRows.length} patents`,
    }));

    const insertPTA = db.prepare(`
      INSERT OR REPLACE INTO pta_records
        (patent_number, pta_days, category_a_days, category_b_days, category_c_days,
         overlap_deduction, applicant_delay, grant_date, application_date, uspto_pta_days, last_updated)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `);

    const runInserts = db.transaction((rows: PTARow[]) => {
      for (const row of rows) {
        try {
          insertPTA.run(
            row.patent_number,
            row.pta_days,
            row.category_a_days,
            row.category_b_days,
            row.category_c_days,
            row.overlap_deduction,
            row.applicant_delay,
            row.pta_days,
            result.last_updated
          );
          result.rows_inserted++;
        } catch {
          result.rows_skipped++;
        }
      }
    });

    runInserts(ptaRows);

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('pta', ?, ?, 'success')
    `).run(result.last_updated, result.rows_inserted);

    result.status = result.rows_skipped > 0 ? "partial" : "success";
    console.error(JSON.stringify({
      level: "info", source: "pta",
      message: "PTA pipeline complete",
      rows_inserted: result.rows_inserted,
      rows_skipped: result.rows_skipped,
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    result.status = "failed";
    console.error(JSON.stringify({ level: "error", source: "pta", message }));

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('pta', ?, 0, 'failed')
    `).run(result.last_updated);
  } finally {
    db.close();
  }

  console.log(JSON.stringify(result));
}

/**
 * Streams g_application.tsv and builds a map of patent_id → application_id
 * for only the patents in targetSet.
 */
async function buildPatentToApplicationMap(
  filePath: string,
  targetSet: Set<string>
): Promise<Map<string, string>> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const map = new Map<string, string>();
  let appIdx = -1;
  let patentIdx = -1;
  let isFirst = true;

  for await (const line of rl) {
    const cols = line.split("\t").map((c) => c.replace(/"/g, "").trim());

    if (isFirst) {
      isFirst = false;
      appIdx = cols.indexOf("application_id");
      patentIdx = cols.indexOf("patent_id");
      if (appIdx === -1 || patentIdx === -1) {
        throw new Error(
          `g_application.tsv missing required columns. Found: ${cols.slice(0, 10).join(", ")}`
        );
      }
      continue;
    }

    const patentId = cols[patentIdx]?.trim();
    const appId = cols[appIdx]?.trim();
    if (!patentId || !appId) continue;
    if (targetSet.has(patentId)) map.set(patentId, appId);
  }

  return map;
}

/**
 * Streams pta_summary.csv and returns PTA rows for patents in appToPatent map.
 */
async function collectPTARows(
  filePath: string,
  appToPatent: Map<string, string>
): Promise<PTARow[]> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const rows: PTARow[] = [];

  let col: Record<string, number> = {};
  let isFirst = true;

  for await (const line of rl) {
    if (isFirst) {
      isFirst = false;
      const headers = line.split(",").map((h) => h.trim());
      col = Object.fromEntries(headers.map((h, i) => [h, i]));

      const required = ["application_number", "patent_term_adjustment"];
      for (const r of required) {
        if (!(r in col)) {
          throw new Error(`pta_summary.csv missing column "${r}". Found: ${headers.join(", ")}`);
        }
      }
      continue;
    }

    const cells = line.split(",");
    const appNum = cells[col["application_number"] ?? -1]?.trim();
    if (!appNum) continue;

    const patentId = appToPatent.get(appNum);
    if (!patentId) continue;

    const int = (key: string) => parseInt(cells[col[key] ?? -1]?.trim() ?? "0", 10) || 0;

    rows.push({
      patent_number: patentId,
      pta_days: int("patent_term_adjustment"),
      category_a_days: int("pto_delay_a"),
      category_b_days: int("pto_delay_b"),
      category_c_days: int("pto_delay_c"),
      overlap_deduction: int("overlap_pto_delay"),
      applicant_delay: int("applicant_delay"),
      nonoverlap_pto_delay: int("nonoverlap_pto_delay"),
      pto_manual_adjustment: int("pto_manual_adjustment"),
    });
  }

  return rows;
}

async function assertFileExists(filePath: string, fileName: string, dataset: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(
      `Required data file not found: ${filePath}\n` +
      `Download "${fileName}" from https://data.uspto.gov/bulkdata/datasets/${dataset} ` +
      `and place it at ${filePath}`
    );
  }
}

function normalizePatentNumber(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

fetchPTA().catch((err) => {
  console.error(err);
  process.exit(1);
});
