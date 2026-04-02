/**
 * USPTO Patent Term Extension (PTE) pipeline script.
 *
 * PTE is granted per 35 U.S.C. §156 to compensate for time lost during
 * FDA regulatory review. Only one patent per NDA can receive PTE.
 *
 * Sources PTE data from two locally-stored bulk files:
 *
 *   1. pte_summary.csv  — from PatEx Research Dataset (ECOPAIR)
 *      Columns: application_number, pto_adjustment, pto_delay,
 *               applicant_delay, patent_term_extension
 *      Download: https://data.uspto.gov/bulkdata/datasets/ecopair
 *      Updates:  Annually
 *
 *   2. g_application.tsv — from PatentsView Granted Patent Disambiguated Data (PVGPATDIS)
 *      Columns: application_id, patent_id, ...
 *      Download: https://data.uspto.gov/bulkdata/datasets/pvgpatdis
 *      Updates:  Quarterly
 *
 * These files require a CAPTCHA to download (human-only) and are stored at
 * DATA_DIR/patex/. Copy new versions there when the datasets are updated.
 *
 * Join: pte_summary.application_number → g_application.application_id → g_application.patent_id
 *
 * Run via: bun pipeline/fetch-pte.ts
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

const PTE_SUMMARY_PATH = process.env["PTE_SUMMARY_PATH"] ?? join(PATEX_DIR, "pte_summary.csv");
const G_APPLICATION_PATH = process.env["G_APPLICATION_PATH"] ?? join(PATEX_DIR, "g_application.tsv");

interface PipelineResult {
  source: "pte";
  status: "success" | "partial" | "failed";
  rows_inserted: number;
  rows_skipped: number;
  last_updated: string;
  errors: string[];
}

interface PTERow {
  patent_number: string;
  pte_days: number;
  pto_adjustment: number;
  pto_delay: number;
  applicant_delay: number;
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

    await assertFileExists(PTE_SUMMARY_PATH, "pte_summary.csv", "ecopair");
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
      level: "info", source: "pte",
      message: `Building application→patent map for ${targetSet.size} target patents...`,
    }));

    const patentToApp = await buildPatentToApplicationMap(G_APPLICATION_PATH, targetSet);
    const appToPatent = new Map<string, string>();
    for (const [patent, app] of patentToApp) appToPatent.set(app, patent);

    console.error(JSON.stringify({
      level: "info", source: "pte",
      message: `Scanning pte_summary.csv for ${appToPatent.size} application numbers...`,
    }));

    // pte_summary.csv is tiny (~350KB) — load fully into memory
    const pteRows = await collectPTERows(PTE_SUMMARY_PATH, appToPatent);

    console.error(JSON.stringify({
      level: "info", source: "pte",
      message: `Found PTE data for ${pteRows.length} patents`,
    }));

    const insertPTE = db.prepare(`
      INSERT OR REPLACE INTO pte_records
        (patent_number, pte_days, testing_phase_credit, approval_phase_credit,
         pre_grant_deduction, cap_applied, nda_submission_date, nda_approval_date,
         grant_date, uspto_pte_days, last_updated)
      VALUES
        (?, ?, 0, 0, 0, 'none', NULL, NULL, NULL, ?, ?)
    `);

    const runInserts = db.transaction((rows: PTERow[]) => {
      for (const row of rows) {
        try {
          insertPTE.run(
            row.patent_number,
            row.pte_days,
            row.pte_days,
            result.last_updated
          );
          result.rows_inserted++;
        } catch {
          result.rows_skipped++;
        }
      }
    });

    runInserts(pteRows);

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('pte', ?, ?, 'success')
    `).run(result.last_updated, result.rows_inserted);

    result.status = result.rows_skipped > 0 ? "partial" : "success";
    console.error(JSON.stringify({
      level: "info", source: "pte",
      message: "PTE pipeline complete",
      rows_inserted: result.rows_inserted,
      rows_skipped: result.rows_skipped,
    }));
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

async function collectPTERows(
  filePath: string,
  appToPatent: Map<string, string>
): Promise<PTERow[]> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const rows: PTERow[] = [];
  let col: Record<string, number> = {};
  let isFirst = true;

  for await (const line of rl) {
    if (isFirst) {
      isFirst = false;
      const headers = line.split(",").map((h) => h.trim());
      col = Object.fromEntries(headers.map((h, i) => [h, i]));

      const required = ["application_number", "patent_term_extension"];
      for (const r of required) {
        if (!(r in col)) {
          throw new Error(`pte_summary.csv missing column "${r}". Found: ${headers.join(", ")}`);
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
    const pteDays = int("patent_term_extension");
    if (pteDays <= 0) continue; // Only store patents that actually received PTE

    rows.push({
      patent_number: patentId,
      pte_days: pteDays,
      pto_adjustment: int("pto_adjustment"),
      pto_delay: int("pto_delay"),
      applicant_delay: int("applicant_delay"),
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

fetchPTE().catch((err) => {
  console.error(err);
  process.exit(1);
});
