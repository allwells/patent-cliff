/**
 * Generic entry risk score synthesis.
 *
 * Combines all patent protection signals into a single RiskLevel verdict
 * and a list of human-readable risk factors.
 *
 * Thresholds (from verdict-agent/agent.md):
 *   low      — no Para IV, no PTAB, >5 years to expiry
 *   moderate — no Para IV, no PTAB, 2–5 years to expiry
 *   elevated — active Para IV, no stay, >2 years to expiry
 *   high     — active Para IV + 30-month stay OR active PTAB
 *   critical — active Para IV + active PTAB + stay expiring within 12 months
 */

import { parseISO, isValid, differenceInDays, differenceInYears, addMonths, format } from "date-fns";
import type {
  RiskLevel,
  ParagraphIVRow,
  PTABProceedingRow,
  PediatricResult,
  ExclusivityRow,
} from "../types/index.js";

const STAY_DURATION_MONTHS = 30;
const DAYS_IN_YEAR = 365;

export interface VerdictInput {
  finalAdjustedExpiry: string;
  paragraphIVRows: ParagraphIVRow[];
  ptabRows: PTABProceedingRow[];
  ptabDataAvailable: boolean;
  pediatric: PediatricResult;
  exclusivityRows: ExclusivityRow[];
}

export interface VerdictOutput {
  risk_score: RiskLevel;
  risk_factors: string[];
  paragraph_iv: {
    active: boolean;
    filers: string[];
    stay_active: boolean;
    stay_expires: string | null;
  };
  ptab: {
    data_available: boolean;
    active_proceedings: number;
    proceedings: Array<{
      case_number: string;
      petitioner: string | null;
      status: string;
      filed_date: string | null;
    }>;
  };
}

export function synthesizeVerdict(input: VerdictInput): VerdictOutput {
  const today = new Date();
  const expiryDate = parseISO(input.finalAdjustedExpiry);
  const riskFactors: string[] = [];

  // ── Paragraph IV analysis ──────────────────────────────────────
  const activeParagraphIV = input.paragraphIVRows.length > 0;
  const filers = [
    ...new Set(
      input.paragraphIVRows
        .map((r) => r.applicant_name)
        .filter((n): n is string => n !== null)
    ),
  ];

  // 30-month stay: triggered when brand sues within 45 days of Para IV notice.
  // Stay expires 30 months from the later of: NDA approval date or Para IV submission date.
  // We estimate from the earliest Para IV submission date available.
  let stayActive = false;
  let stayExpires: string | null = null;

  if (activeParagraphIV) {
    const earliestSubmission = input.paragraphIVRows
      .map((r) => r.submission_date)
      .filter((d): d is string => d !== null)
      .map((d) => parseISO(d))
      .filter(isValid)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    if (earliestSubmission) {
      const estimatedStayEnd = addMonths(earliestSubmission, STAY_DURATION_MONTHS);
      stayActive = estimatedStayEnd > today;
      stayExpires = format(estimatedStayEnd, "yyyy-MM-dd");
    }
  }

  // ── PTAB analysis ──────────────────────────────────────────────
  const activePTABRows = input.ptabDataAvailable
    ? input.ptabRows.filter((r) => r.status === "Instituted")
    : [];
  const activePTABCount = activePTABRows.length;

  // ── Years to expiry ────────────────────────────────────────────
  const yearsToExpiry = isValid(expiryDate)
    ? differenceInYears(expiryDate, today)
    : 999;
  const daysToExpiry = isValid(expiryDate)
    ? differenceInDays(expiryDate, today)
    : 999 * DAYS_IN_YEAR;

  // ── Risk scoring ────────────────────────────────────────────────
  let riskScore: RiskLevel = "low";

  if (
    activeParagraphIV &&
    activePTABCount > 0 &&
    stayActive &&
    stayExpires !== null &&
    differenceInDays(parseISO(stayExpires), today) <= 365
  ) {
    riskScore = "critical";
    riskFactors.push(
      `Active Paragraph IV certification with ${activePTABCount} instituted PTAB proceeding(s) and 30-month stay expiring within 12 months`
    );
  } else if (activeParagraphIV && (stayActive || activePTABCount > 0)) {
    riskScore = "high";
    if (stayActive) {
      riskFactors.push(`Active 30-month stay (estimated expiry: ${stayExpires ?? "unknown"})`);
    }
    if (activePTABCount > 0) {
      riskFactors.push(
        `${activePTABCount} instituted PTAB proceeding(s) — patent validity challenged`
      );
    }
  } else if (activeParagraphIV) {
    riskScore = "elevated";
    riskFactors.push(
      `Active Paragraph IV certification by ${filers.length > 0 ? filers.join(", ") : "unknown filer(s)"}`
    );
  } else if (yearsToExpiry <= 5 && yearsToExpiry > 2) {
    riskScore = "moderate";
    riskFactors.push(
      `Patent expires in approximately ${yearsToExpiry} year(s) — within 5-year generic entry window`
    );
  } else if (yearsToExpiry <= 2) {
    // Close expiry with no challenges is still elevated risk
    riskScore = "elevated";
    riskFactors.push(
      `Patent expires in approximately ${daysToExpiry} days — imminent generic entry window`
    );
  } else {
    riskFactors.push(`No active generic challenges detected; patent expires in ${yearsToExpiry} year(s)`);
  }

  // Additional risk factors (appended regardless of primary score)
  if (input.pediatric.applies) {
    riskFactors.push(
      `Pediatric exclusivity extends protection to ${input.pediatric.end_date ?? "unknown"}`
    );
  }

  const nceRow = input.exclusivityRows.find((r) => r.exclusivity_code === "NCE");
  if (nceRow) {
    const nceExpiry = parseISO(nceRow.exclusivity_date);
    if (isValid(nceExpiry) && nceExpiry > today) {
      riskFactors.push(
        `NCE exclusivity active until ${nceRow.exclusivity_date} — blocks generic ANDA approval until then`
      );
    }
  }

  if (activePTABCount > 0 && riskScore !== "critical" && riskScore !== "high") {
    riskFactors.push(
      `${activePTABCount} instituted PTAB proceeding(s) present — monitor for validity ruling`
    );
  }

  if (!input.ptabDataAvailable) {
    riskFactors.push(
      "PTAB proceedings data unavailable — IPR/PGR challenge history cannot be assessed; risk score does not account for active PTAB proceedings"
    );
  }

  return {
    risk_score: riskScore,
    risk_factors: riskFactors,
    paragraph_iv: {
      active: activeParagraphIV,
      filers,
      stay_active: stayActive,
      stay_expires: stayExpires,
    },
    ptab: {
      data_available: input.ptabDataAvailable,
      active_proceedings: activePTABCount,
      proceedings: input.ptabRows.map((r) => ({
        case_number: r.case_number,
        petitioner: r.petitioner,
        status: r.status,
        filed_date: r.filed_date,
      })),
    },
  };
}
