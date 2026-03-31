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

const DB_PATH = process.env["DB_PATH"] ?? "./patent-cliff.db";
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
    const products = extractZipEntry(files, "product.txt", decoder);
    const patents = extractZipEntry(files, "patent.txt", decoder);
    const exclusivity = extractZipEntry(files, "exclusivity.txt", decoder);

    const insertProduct = db.prepare(`
      INSERT OR REPLACE INTO products
        (nda_number, drug_name, active_ingredient, applicant, strength, dosage_form, route, approval_date, te_code, rld, type)
      VALUES
        (@nda_number, @drug_name, @active_ingredient, @applicant, @strength, @dosage_form, @route, @approval_date, @te_code, @rld, @type)
    `);

    const insertPatent = db.prepare(`
      INSERT OR REPLACE INTO ob_patents
        (nda_number, patent_number, patent_expire_date, drug_substance_flag, drug_product_flag, patent_use_code, delist_flag, submission_date)
      VALUES
        (@nda_number, @patent_number, @patent_expire_date, @drug_substance_flag, @drug_product_flag, @patent_use_code, @delist_flag, @submission_date)
    `);

    const insertExclusivity = db.prepare(`
      INSERT OR REPLACE INTO exclusivity (nda_number, exclusivity_code, exclusivity_date)
      VALUES (@nda_number, @exclusivity_code, @exclusivity_date)
    `);

    const insertParaIV = db.prepare(`
      INSERT OR REPLACE INTO paragraph_iv (nda_number, patent_number, applicant_name, anda_number, submission_date)
      VALUES (@nda_number, @patent_number, @applicant_name, @anda_number, @submission_date)
    `);

    // Run all inserts in a single transaction
    const runAll = db.transaction(() => {
      // Products
      for (const row of parseOBFile(products)) {
        try {
          insertProduct.run({
            nda_number: row[0] ?? "",
            drug_name: row[1] ?? "",
            active_ingredient: row[2] ?? "",
            applicant: row[3] ?? "",
            strength: row[4] ?? "",
            dosage_form: row[5] ?? "",
            route: row[6] ?? "",
            approval_date: parseOBDate(row[7]),
            te_code: row[8] ?? null,
            rld: row[9] === "Yes" ? 1 : 0,
            type: row[10] ?? "RX",
          });
          result.rows_inserted++;
        } catch {
          result.rows_skipped++;
        }
      }

      // Patents + Paragraph IV
      for (const row of parseOBFile(patents)) {
        try {
          const ndaNumber = row[0] ?? "";
          const patentNumber = row[1] ?? "";

          insertPatent.run({
            nda_number: ndaNumber,
            patent_number: patentNumber,
            patent_expire_date: parseOBDate(row[2]) ?? row[2] ?? "",
            drug_substance_flag: row[3] === "Y" ? 1 : 0,
            drug_product_flag: row[4] === "Y" ? 1 : 0,
            patent_use_code: row[5] ?? null,
            delist_flag: row[6] === "Y" ? 1 : 0,
            submission_date: parseOBDate(row[7]),
          });
          result.rows_inserted++;

          // Paragraph IV: use_code starts with "U-" and para_iv column = "Y"
          // In Orange Book patent.txt: col[8] is the Paragraph IV indicator
          if (row[8] === "Y" || (row[5] ?? "").startsWith("U-")) {
            insertParaIV.run({
              nda_number: ndaNumber,
              patent_number: patentNumber,
              applicant_name: null, // applicant detail is in ANDA records
              anda_number: null,
              submission_date: parseOBDate(row[7]),
            });
            result.rows_inserted++;
          }
        } catch {
          result.rows_skipped++;
        }
      }

      // Exclusivity
      for (const row of parseOBFile(exclusivity)) {
        try {
          insertExclusivity.run({
            nda_number: row[0] ?? "",
            exclusivity_code: row[1] ?? "",
            exclusivity_date: parseOBDate(row[2]) ?? row[2] ?? "",
          });
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

// Orange Book dates are in MM/DD/YYYY format — normalize to ISO 8601
function parseOBDate(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  const trimmed = raw.trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // MM/DD/YYYY
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, mm, dd, yyyy] = match;
    return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
  }
  return null;
}

fetchOrangeBook().catch((err) => {
  console.error(err);
  process.exit(1);
});
