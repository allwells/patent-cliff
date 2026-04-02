/**
 * PTAB docket pipeline script.
 *
 * Fetches inter partes review (IPR) proceedings from the USPTO PTAB API
 * for all patents tracked in ob_patents. An active IPR represents a risk
 * that the patent could be invalidated before its nominal expiry date.
 *
 * PTAB API v3 (current): https://data.uspto.gov/apis/ptab-trials
 *   Endpoint: POST /api/v1/patent/trials/proceedings/search
 *   Requires: ODP API key (X-API-KEY header)
 *   Key registration: https://data.uspto.gov — requires ID.me identity verification
 *
 * NOTE: The ODP API key requires ID.me, which has regional restrictions.
 * If unavailable, this pipeline returns 0 rows and the tool degrades gracefully
 * (PTAB risk factor is omitted from the verdict score).
 *
 * Rate limited — uses backoff on 429 responses.
 *
 * Run via: bun pipeline/fetch-ptab.ts
 */

import { Database } from "bun:sqlite";
import { config } from "dotenv";

config();

const DB_PATH = process.env["DB_PATH"] ?? "/data/patent-cliff.db";
// PTAB API v2 at developer.uspto.gov/ptab-api was decommissioned January 6, 2026.
// PTAB API v3 is at data.uspto.gov but requires an ODP API key (ID.me verification).
// Without a key, all responses return HTML — the HTML-detection guard below handles this.
const PTAB_API_BASE = process.env["PTAB_API_BASE"] ?? "https://developer.uspto.gov/ptab-api";

interface PipelineResult {
  source: "ptab";
  status: "success" | "partial" | "failed";
  rows_inserted: number;
  rows_skipped: number;
  last_updated: string;
  errors: string[];
}

interface PTABProceeding {
  trialNumber: string;
  respondentPatentNumber: string;
  petitionerPartyName?: string;
  respondentPartyName?: string;
  prosecutionStatus: string;
  subproceeding_type_category?: string;
  filingDate?: string;
  institutionDecisionDate?: string;
  decisionDate?: string;
}

async function fetchPTAB(): Promise<void> {
  const result: PipelineResult = {
    source: "ptab",
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

    // Exclude *PED variants — Orange Book constructs, not real USPTO patent numbers
    const targetPatents = db
      .prepare("SELECT DISTINCT patent_number FROM ob_patents WHERE patent_number NOT LIKE '%*PED'")
      .all() as Array<{ patent_number: string }>;

    if (targetPatents.length === 0) {
      result.status = "failed";
      result.errors.push("ob_patents table is empty — run orangebook pipeline first");
      return;
    }

    console.error(
      JSON.stringify({
        level: "info",
        source: "ptab",
        message: `Querying PTAB for ${targetPatents.length} patents`,
      })
    );

    const insertProceeding = db.prepare(`
      INSERT OR REPLACE INTO ptab_proceedings
        (case_number, patent_number, petitioner, respondent, status, type,
         filed_date, institution_date, decision_date, last_updated)
      VALUES
        (@case_number, @patent_number, @petitioner, @respondent, @status, @type,
         @filed_date, @institution_date, @decision_date, @last_updated)
    `);

    const runInserts = db.transaction((proceedings: PTABProceeding[]) => {
      for (const p of proceedings) {
        try {
          // Normalize patent number — PTAB includes "US" prefix, ob_patents does not
          const patentNumber = p.respondentPatentNumber
            .replace(/^US/i, "")
            .replace(/[^0-9]/g, "");

          insertProceeding.run({
            case_number: p.trialNumber,
            patent_number: patentNumber,
            petitioner: p.petitionerPartyName ?? null,
            respondent: p.respondentPartyName ?? null,
            status: normalizePTABStatus(p.prosecutionStatus),
            type: deriveType(p.trialNumber),
            filed_date: parseDate(p.filingDate),
            institution_date: parseDate(p.institutionDecisionDate),
            decision_date: parseDate(p.decisionDate),
            last_updated: result.last_updated,
          });
          result.rows_inserted++;
        } catch {
          result.rows_skipped++;
        }
      }
    });

    // Query PTAB API per patent — only IPR and PGR proceedings are relevant.
    // Abort early if the API returns HTML (endpoint has moved).
    let consecutiveHtmlResponses = 0;
    for (const { patent_number } of targetPatents) {
      try {
        const { proceedings, apiMoved } = await queryPTABForPatent(patent_number);
        if (apiMoved) {
          consecutiveHtmlResponses++;
          result.rows_skipped++;
          if (consecutiveHtmlResponses >= 3) {
            const msg = "PTAB API is returning HTML for all requests — endpoint has moved. Aborting pipeline. Update PTAB_API_BASE.";
            result.errors.push(msg);
            console.error(JSON.stringify({ level: "error", source: "ptab", message: msg }));
            break;
          }
          continue;
        }
        consecutiveHtmlResponses = 0;
        if (proceedings.length > 0) {
          runInserts(proceedings);
        }
        // Polite delay between patent queries
        await sleep(150);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Patent ${patent_number}: ${message}`);
        result.rows_skipped++;
      }
    }

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('ptab', ?, ?, 'success')
    `).run(result.last_updated, result.rows_inserted);

    result.status =
      result.errors.length > 0
        ? "partial"
        : "success";

    console.error(
      JSON.stringify({
        level: "info",
        source: "ptab",
        message: "PTAB pipeline complete",
        rows_inserted: result.rows_inserted,
        rows_skipped: result.rows_skipped,
        errors: result.errors.length,
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    result.status = "failed";
    console.error(JSON.stringify({ level: "error", source: "ptab", message }));

    db.prepare(`
      INSERT OR REPLACE INTO data_freshness (source, last_updated, rows_current, last_run_status)
      VALUES ('ptab', ?, 0, 'failed')
    `).run(result.last_updated);
  } finally {
    db.close();
  }

  console.log(JSON.stringify(result));
}

async function queryPTABForPatent(
  patentNumber: string
): Promise<{ proceedings: PTABProceeding[]; apiMoved: boolean }> {
  // PTAB API uses "US" prefixed patent numbers
  const formattedNumber = `US${patentNumber}`;
  const url = `${PTAB_API_BASE}/proceedings?respondentPatentNumber=${encodeURIComponent(formattedNumber)}&proceedingTypeCategory=AIA+Trial&rows=50&start=0`;

  const res = await fetchWithBackoff(url);
  if (!res.ok) {
    if (res.status === 404) return { proceedings: [], apiMoved: false };
    throw new Error(`PTAB API ${res.status}: ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return { proceedings: [], apiMoved: true };
  }

  const data = (await res.json()) as {
    results?: PTABProceeding[];
    trials?: PTABProceeding[];
  };

  return { proceedings: data.results ?? data.trials ?? [], apiMoved: false };
}

async function fetchWithBackoff(
  url: string,
  maxRetries = 3
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "User-Agent": "PatentCliff/1.0 (patent data pipeline)",
          },
        });
        if (res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          const delayMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.min(1000 * Math.pow(2, attempt), 30_000);
          await sleep(delayMs);
          continue;
        }
        return res;
      } finally {
        clearTimeout(timer);
      }
    } catch (err: unknown) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 30_000));
      }
    }
  }
  throw lastErr;
}

function normalizePTABStatus(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.includes("instituted")) return "Instituted";
  if (s.includes("final written")) return "Final Written Decision";
  if (s.includes("settled") || s.includes("terminated")) return "Settled";
  if (s.includes("denied")) return "Denied";
  return raw.trim();
}

function deriveType(trialNumber: string): string {
  if (trialNumber.startsWith("IPR")) return "IPR";
  if (trialNumber.startsWith("PGR")) return "PGR";
  if (trialNumber.startsWith("CBM")) return "CBM";
  return "IPR";
}

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  // Normalize to ISO 8601 date
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

fetchPTAB().catch((err) => {
  console.error(err);
  process.exit(1);
});
