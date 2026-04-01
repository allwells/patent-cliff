/**
 * Main PatentCliff tool handler.
 *
 * Orchestrates the full analysis pipeline for a drug query:
 *   1. Resolve drug name → NDA number
 *   2. Fetch all patents, exclusivity, Para IV, PTA, PTE, PTAB data
 *   3. Run PTA + PTE calculations on the controlling (latest-expiry) patent
 *   4. Apply pediatric exclusivity
 *   5. Synthesize risk score
 *   6. Return PatentCliffResponse with required disclaimers
 *
 * REQUIRED in every response (CTX grant non-negotiables):
 *   - expiry_is_estimate: true on all date outputs
 *   - disclaimers.estimate_notice
 *   - disclaimers.sealed_paragraph_iv_notice
 *   - disclaimers.pre_anda_notice
 */

import { parseISO, isValid, differenceInDays } from "date-fns";
import type { Database } from "bun:sqlite";
import {
  findProductsByName,
  getPatentsByNDA,
  getExclusivityByNDA,
  getParagraphIVByNDA,
  getPTARecord,
  getPTERecord,
  getPTABProceedingsByPatent,
  getPEDPatentExpiry,
  getDataFreshness,
  logQuery,
} from "../cache/queries.js";
import { calculatePTA } from "../calculations/pta.js";
import { calculatePTE } from "../calculations/pte.js";
import {
  calculatePediatricExclusivity,
  applyPediatricExtension,
} from "../calculations/pediatric.js";
import { synthesizeVerdict } from "./verdict.js";
import { logger } from "../utils/logger.js";
import type {
  PatentCliffResponse,
  DrugNotFoundResponse,
  ToolResponse,
  OBPatentRow,
  DataFreshnessRow,
} from "../types/index.js";

// ── Disclaimer text ────────────────────────────────────────────────────────────
// These strings appear in every response — they are part of the data contract.

const ESTIMATE_NOTICE =
  "PTA and PTE-adjusted expiration dates are calculated estimates based on publicly available USPTO and FDA data. " +
  "USPTO frequently corrects PTA after initial grant; these dates may differ from final legally certified dates. " +
  "Consult qualified patent counsel for legal certainty.";

const SEALED_PARA_IV_NOTICE =
  "Paragraph IV certifications under litigation seal are not visible in public FDA ANDA records. " +
  "A result showing no active Paragraph IV does not guarantee that no challenge exists. " +
  "When a generic filer initiates a challenge and the brand files suit within 45 days, " +
  "certain details enter a confidential litigation phase not reflected here.";

const PRE_ANDA_NOTICE =
  "This tool covers publicly filed ANDAs in the FDA database only. " +
  "Pre-ANDA confidential development activity, pre-submission inquiries, and undisclosed generic programs " +
  "are not visible. Generic competition risk may exist beyond what public records show.";

const STALE_WARNING_TEMPLATE =
  "One or more data sources have not been updated within their expected refresh window. " +
  "Results may not reflect the latest patent status. " +
  "Stale sources: {sources}. Run the data pipeline to refresh.";

// ── Main handler ───────────────────────────────────────────────────────────────

export async function handlePatentCliff(
  db: Database,
  input: { drug_name: string }
): Promise<ToolResponse> {
  const startMs = Date.now();
  const { drug_name } = input;

  logger.info("patent-cliff", "Query received", { drug_name });

  // ── 1. Resolve drug name → product row ──────────────────────────────────────
  const products = findProductsByName(db, drug_name.trim());

  if (products.length === 0) {
    logQuery(db, {
      drug_name,
      resolved_nda: null,
      risk_score: null,
      response_ms: Date.now() - startMs,
      cache_hit: false,
    });

    return buildNotFoundResponse(drug_name);
  }

  // Prefer Reference Listed Drug; fall back to first result
  const product = products.find((p) => p.rld === 1) ?? products[0]!;
  const ndaNumber = product.nda_number;

  logger.info("patent-cliff", "Drug resolved", {
    drug_name,
    nda_number: ndaNumber,
    matched_name: product.drug_name,
  });

  // ── 2. Fetch all associated data ─────────────────────────────────────────────
  const [patents, exclusivityRows, paragraphIVRows] = [
    getPatentsByNDA(db, ndaNumber),
    getExclusivityByNDA(db, ndaNumber),
    getParagraphIVByNDA(db, ndaNumber),
  ];

  if (patents.length === 0) {
    logQuery(db, {
      drug_name,
      resolved_nda: ndaNumber,
      risk_score: null,
      response_ms: Date.now() - startMs,
      cache_hit: false,
    });
    return buildNotFoundResponse(drug_name, "Drug found in products table but has no associated patents in Orange Book.");
  }

  // ── 3. Select controlling patent (latest base expiry) ────────────────────────
  const controllingPatent = selectControllingPatent(patents);
  const baseExpiry = controllingPatent.patent_expire_date;

  // ── 4. Fetch PTA / PTE for controlling patent ────────────────────────────────
  const [ptaRow, pteRow, ptabRows] = [
    getPTARecord(db, controllingPatent.patent_number),
    getPTERecord(db, controllingPatent.patent_number),
    getPTABProceedingsByPatent(db, controllingPatent.patent_number),
  ];

  // ── 5. Run calculations ──────────────────────────────────────────────────────
  const ptaResult = calculatePTA(baseExpiry, ptaRow);
  const pteResult = calculatePTE(baseExpiry, pteRow);

  // Determine final adjusted expiry before pediatric:
  //   - If PTE applies, use PTE-adjusted (PTE and PTA are mutually exclusive)
  //   - If only PTA applies, use PTA-adjusted
  //   - Otherwise use base expiry
  let preExclusivityExpiry = baseExpiry;
  if (pteResult.data_available && pteResult.pte_days > 0) {
    preExclusivityExpiry = pteResult.pte_adjusted_expiry;
  } else if (ptaResult.data_available && ptaResult.pta_days > 0) {
    preExclusivityExpiry = ptaResult.pta_adjusted_expiry;
  }

  // ── 6. Pediatric exclusivity ─────────────────────────────────────────────────
  let pediatric = calculatePediatricExclusivity(exclusivityRows, preExclusivityExpiry);

  // Orange Book *PED rows encode the patent-specific PED-extended expiry
  // (patent base + 6 months). This is authoritative for blocking generic entry.
  // Override the exclusivity-table PED result when the patent *PED expiry is later.
  const pedPatentExpiry = getPEDPatentExpiry(db, ndaNumber, controllingPatent.patent_number);
  if (pedPatentExpiry) {
    const pedDate = parseISO(pedPatentExpiry);
    const baseDate = parseISO(preExclusivityExpiry);
    if (isValid(pedDate) && isValid(baseDate) && pedDate > baseDate) {
      pediatric = {
        applies: true,
        end_date: pedPatentExpiry,
        extension_days: differenceInDays(pedDate, baseDate),
      };
    }
  }

  const finalAdjustedExpiry = applyPediatricExtension(preExclusivityExpiry, pediatric);

  // ── 7. Risk verdict ──────────────────────────────────────────────────────────
  const verdict = synthesizeVerdict({
    finalAdjustedExpiry,
    paragraphIVRows,
    ptabRows,
    pediatric,
    exclusivityRows,
  });

  // ── 8. Data freshness ────────────────────────────────────────────────────────
  const freshness = getDataFreshness(db);
  const dataFreshness = buildDataFreshness(freshness);

  // ── 9. Compose response ──────────────────────────────────────────────────────
  const response: PatentCliffResponse = {
    drug_name: product.drug_name,
    active_ingredient: product.active_ingredient,
    nda_number: ndaNumber,
    applicant: product.applicant,

    base_expiry: baseExpiry,
    pta_adjusted_expiry: ptaResult.data_available && ptaResult.pta_days > 0
      ? ptaResult.pta_adjusted_expiry
      : null,
    pte_adjusted_expiry: pteResult.data_available && pteResult.pte_days > 0
      ? pteResult.pte_adjusted_expiry
      : null,
    final_adjusted_expiry: finalAdjustedExpiry,
    expiry_is_estimate: true,

    pta: ptaResult.data_available ? ptaResult : null,
    pte: pteResult.data_available ? pteResult : null,

    paragraph_iv: verdict.paragraph_iv,
    ptab: verdict.ptab,
    pediatric_exclusivity: pediatric,

    risk_score: verdict.risk_score,
    risk_factors: verdict.risk_factors,

    // Required in every response
    disclaimers: {
      estimate_notice: ESTIMATE_NOTICE,
      sealed_paragraph_iv_notice: SEALED_PARA_IV_NOTICE,
      pre_anda_notice: PRE_ANDA_NOTICE,
    },

    data_freshness: dataFreshness,
  };

  logQuery(db, {
    drug_name,
    resolved_nda: ndaNumber,
    risk_score: verdict.risk_score,
    response_ms: Date.now() - startMs,
    cache_hit: false,
  });

  logger.info("patent-cliff", "Query complete", {
    drug_name,
    nda_number: ndaNumber,
    risk_score: verdict.risk_score,
    response_ms: Date.now() - startMs,
  });

  return response;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function selectControllingPatent(patents: OBPatentRow[]): OBPatentRow {
  // Sort descending by expiry date — controlling patent is the latest expiry
  return patents.slice().sort((a, b) => {
    const da = parseISO(a.patent_expire_date);
    const db_ = parseISO(b.patent_expire_date);
    if (!isValid(da)) return 1;
    if (!isValid(db_)) return -1;
    return db_.getTime() - da.getTime();
  })[0]!;
}

function buildDataFreshness(freshness: Record<string, DataFreshnessRow>) {
  const obRow = freshness["orangebook"];
  const usptoRow = freshness["pta"] ?? freshness["pte"];
  const ptabRow = freshness["ptab"];

  const isStale = (row: DataFreshnessRow | undefined): boolean => {
    if (!row) return true;
    const d = parseISO(row.last_updated);
    if (!isValid(d)) return true;
    return differenceInDays(new Date(), d) > row.ttl_days;
  };

  const staleSources: string[] = [];
  if (isStale(obRow)) staleSources.push("FDA Orange Book");
  if (isStale(usptoRow)) staleSources.push("USPTO PTA/PTE");
  if (isStale(ptabRow)) staleSources.push("PTAB");

  const anyStale = staleSources.length > 0;
  const staleWarning = anyStale
    ? STALE_WARNING_TEMPLATE.replace("{sources}", staleSources.join(", "))
    : null;

  return {
    orangebook_last_updated: obRow?.last_updated ?? null,
    uspto_last_updated: usptoRow?.last_updated ?? null,
    ptab_last_updated: ptabRow?.last_updated ?? null,
    any_source_stale: anyStale,
    stale_sources: staleSources,
    stale_warning: staleWarning,
  };
}

function buildNotFoundResponse(
  drugName: string,
  message?: string
): DrugNotFoundResponse {
  return {
    drug_name: drugName,
    found: false,
    message:
      message ??
      `No drug matching "${drugName}" was found in the FDA Orange Book database. ` +
        "Check the spelling or try the active ingredient name instead.",
    disclaimers: {
      sealed_paragraph_iv_notice: SEALED_PARA_IV_NOTICE,
      pre_anda_notice: PRE_ANDA_NOTICE,
    },
  };
}
