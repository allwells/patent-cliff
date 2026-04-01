/**
 * FDA Orange Book pipeline script.
 *
 * Downloads and normalizes three Orange Book flat files:
 *   product.txt     — approved drug products
 *   patent.txt      — associated patents and Paragraph IV certifications
 *   exclusivity.txt — exclusivity periods (NCE, ODE, PED, etc.)
 *
 * FDA distributes these as a single zip (EOBZIP_YYYY_MM.zip).
 * Files are tilde-delimited (~). Updated monthly by FDA.
 * Run via: bun pipeline/fetch-orangebook.ts
 */

import { Database } from "bun:sqlite";
import { config } from "dotenv";
import { unzipSync } from "fflate";

config();

const DB_PATH = process.env["DB_PATH"] ?? "/data/patent-cliff.db";
const OB_ZIP_URL = "https://www.fda.gov/media/76860/download";

interface PipelineResult {
  source: "orangebook";
  status: "success" | "partial" | "failed";
  rows_inserted: number;
  rows_skipped: number;
  last_updated: string;
  errors: string[];
}

// Orange Book ships as a zip with three pipe-delimited .txt files.
// We fetch and parse each in memory.
async function fetchOrangeBook(): Promise<void> {
  const result: PipelineResult = {
    source: "orangebook",
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
    // Initialize schema if needed
    const schemaPath = new URL("../src/cache/schema.sql", import.meta.url).pathname;
    const { readFileSync } = await import("fs");
    db.exec(readFileSync(schemaPath, "utf-8"));

    console.error(
      JSON.stringify({ level: "info", source: "orangebook", message: "Fetching Orange Book zip..." })
    );

    const zipRes = await fetch(OB_ZIP_URL, {
      headers: { "User-Agent": "PatentCliff/1.0 (patent data pipeline)" },
    });

    if (!zipRes.ok) {
      throw new Error(`Failed to fetch Orange Book zip: ${zipRes.status} ${zipRes.statusText}`);
    }

    const zipBuffer = new Uint8Array(await zipRes.arrayBuffer());
    const files = unzipSync(zipBuffer);

    const decoder = new TextDecoder("utf-8");
    const products = extractZipEntry(files, "products.txt", decoder);
    const patents = extractZipEntry(files, "patent.txt", decoder);
    const exclusivity = extractZipEntry(files, "exclusivity.txt", decoder);

    const insertProduct = db.prepare(`
      INSERT OR REPLACE INTO products
        (nda_number, drug_name, active_ingredient, applicant, strength, dosage_form, route, approval_date, te_code, rld, type)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertPatent = db.prepare(`
      INSERT OR REPLACE INTO ob_patents
        (nda_number, patent_number, patent_expire_date, drug_substance_flag, drug_product_flag, patent_use_code, delist_flag, submission_date)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertExclusivity = db.prepare(`
      INSERT OR REPLACE INTO exclusivity (nda_number, exclusivity_code, exclusivity_date)
      VALUES (?, ?, ?)
    `);

    const insertParaIV = db.prepare(`
      INSERT OR REPLACE INTO paragraph_iv (nda_number, patent_number, applicant_name, anda_number, submission_date)
      VALUES (?, ?, ?, ?, ?)
    `);

    // Run all inserts in a single transaction
    const runAll = db.transaction(() => {
      // Full refresh — clear all Orange Book tables before re-inserting.
      // paragraph_iv uses NULL anda_number, so INSERT OR REPLACE can't deduplicate
      // across runs; products/ob_patents are cleared for consistency.
      db.exec("DELETE FROM paragraph_iv");
      db.exec("DELETE FROM ob_patents");
      db.exec("DELETE FROM exclusivity");
      db.exec("DELETE FROM products");

      // Track inserted Para IV (nda, patent) pairs to avoid NULL-key duplicates within run
      const insertedParaIV = new Set<string>();

      // Products
      // products.txt columns (tilde-delimited):
      // 0=Ingredient, 1=DF;Route, 2=Trade_Name, 3=Applicant, 4=Strength,
      // 5=Appl_Type, 6=Appl_No, 7=Product_No, 8=TE_Code, 9=Approval_Date,
      // 10=RLD, 11=RS, 12=Type, 13=Applicant_Full_Name
      for (const row of parseOBFile(products)) {
        try {
          const [dosageForm, route] = (row[1] ?? "").split(";").map((s) => s.trim());
          const ndaNumber = (row[5] ?? "") + (row[6] ?? "");
          insertProduct.run(
            ndaNumber,
            row[2] ?? "",          // Trade_Name → drug_name
            row[0] ?? "",          // Ingredient → active_ingredient
            row[3] ?? "",          // Applicant
            row[4] ?? "",          // Strength
            dosageForm ?? "",
            route ?? "",
            parseOBDate(row[9]),   // Approval_Date
            row[8] ?? null,        // TE_Code
            row[10] === "Yes" ? 1 : 0,
            row[12] ?? "RX",       // Type
          );
          result.rows_inserted++;
        } catch {
          result.rows_skipped++;
        }
      }

      // Patents + Paragraph IV
      // patent.txt columns (tilde-delimited):
      // 0=Appl_Type, 1=Appl_No, 2=Product_No, 3=Patent_No,
      // 4=Patent_Expire_Date_Text, 5=Drug_Substance_Flag, 6=Drug_Product_Flag,
      // 7=Patent_Use_Code, 8=Delist_Flag, 9=Submission_Date
      for (const row of parseOBFile(patents)) {
        try {
          const ndaNumber = (row[0] ?? "") + (row[1] ?? "");
          const patentNumber = row[3] ?? "";

          insertPatent.run(
            ndaNumber,
            patentNumber,
            parseOBDate(row[4]) ?? row[4] ?? "",
            row[5] === "Y" ? 1 : 0,  // Drug_Substance_Flag
            row[6] === "Y" ? 1 : 0,  // Drug_Product_Flag
            row[7] ?? null,           // Patent_Use_Code
            row[8] === "Y" ? 1 : 0,  // Delist_Flag
            parseOBDate(row[9]),      // Submission_Date
          );
          result.rows_inserted++;

          // Paragraph IV indicator: Patent_Use_Code starts with "U-"
          // Deduplicate per (nda, patent) — NULL anda_number bypasses SQLite UNIQUE
          const paraKey = `${ndaNumber}|${patentNumber}`;
          if ((row[7] ?? "").startsWith("U-") && !insertedParaIV.has(paraKey)) {
            insertedParaIV.add(paraKey);
            insertParaIV.run(
              ndaNumber,
              patentNumber,
              null, // applicant detail not in patent.txt
              null,
              parseOBDate(row[9]),
            );
            result.rows_inserted++;
          }
        } catch {
          result.rows_skipped++;
        }
      }

      // Exclusivity
      // exclusivity.txt columns (tilde-delimited):
      // 0=Appl_Type, 1=Appl_No, 2=Product_No, 3=Exclusivity_Code, 4=Exclusivity_Date
      for (const row of parseOBFile(exclusivity)) {
        try {
          const ndaNumber = (row[0] ?? "") + (row[1] ?? "");
          insertExclusivity.run(
            ndaNumber,
            row[3] ?? "",             // Exclusivity_Code
            parseOBDate(row[4]) ?? row[4] ?? "",
          );
          result.rows_inserted++;
        } catch {
          result.rows_skipped++;
        }
      }
    });

    runAll();

    // Update freshness tracking
    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('orangebook', ?, ?, 'success')
    `).run(result.last_updated, result.rows_inserted);

    result.status = result.rows_skipped > 0 ? "partial" : "success";
    console.error(
      JSON.stringify({
        level: "info",
        source: "orangebook",
        message: "Orange Book pipeline complete",
        rows_inserted: result.rows_inserted,
        rows_skipped: result.rows_skipped,
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    result.status = "failed";
    console.error(
      JSON.stringify({ level: "error", source: "orangebook", message, error: message })
    );

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('orangebook', ?, 0, 'failed')
    `).run(result.last_updated);
  } finally {
    db.close();
  }

  console.log(JSON.stringify(result));
}

function extractZipEntry(
  files: Record<string, Uint8Array>,
  filename: string,
  decoder: TextDecoder
): string {
  // zip entries may be in a subdirectory — find case-insensitively
  const key = Object.keys(files).find(
    (k) => k.toLowerCase().endsWith(filename.toLowerCase())
  );
  if (!key) throw new Error(`${filename} not found in Orange Book zip`);
  return decoder.decode(files[key]);
}

function* parseOBFile(content: string): Generator<string[]> {
  const lines = content.split("\n");
  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    yield line.split("~"); // Orange Book flat files are tilde-delimited
  }
}

const MONTH_MAP: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// Orange Book dates appear as "Apr 12, 2023" or "MM/DD/YYYY" — normalize to ISO 8601
function parseOBDate(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  const trimmed = raw.trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // MM/DD/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, mm, dd, yyyy] = slashMatch;
    return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
  }
  // "Apr 12, 2023" or "Apr 1, 2023"
  const longMatch = trimmed.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (longMatch) {
    const [, mon, dd, yyyy] = longMatch;
    const mm = MONTH_MAP[mon!];
    if (mm) return `${yyyy}-${mm}-${dd!.padStart(2, "0")}`;
  }
  return null;
}

fetchOrangeBook().catch((err) => {
  console.error(err);
  process.exit(1);
});
