/**
 * Patent Term Extension (PTE) calculation.
 * Statutory basis: 35 U.S.C. §156
 *
 * PTE compensates patent holders for time lost during FDA regulatory review.
 * Only ONE patent per NDA can receive PTE (the sponsor selects it, typically
 * the longest-lived patent).
 *
 * The calculation:
 *   pte_days = (½ × testing_phase_days) + approval_phase_days − pre_grant_testing_days
 *
 * Subject to two caps:
 *   1. Maximum 5 years absolute extension
 *   2. Final adjusted expiry cannot exceed 14 years after NDA approval date
 *
 * We source pte_days directly from USPTO (PatentsView) which reflects the
 * actual granted extension after both caps are applied. We recompute the
 * cap check independently as a cross-validation.
 *
 * All results are labeled is_estimate: true.
 */

import { addDays, addYears, parseISO, isValid, format, differenceInDays } from "date-fns";
import type { PTERecordRow, PTEResult, PTECapApplied } from "../types/index.js";

const MAX_PTE_DAYS = 5 * 365; // 5-year absolute cap (approx)
const POST_APPROVAL_YEARS = 14;

/**
 * Compute PTE-adjusted expiry for a patent.
 *
 * @param baseExpiry  ISO 8601 date string from Orange Book
 * @param pteRecord   PTE record from pte_records table, or null if no data
 */
export function calculatePTE(
  baseExpiry: string,
  pteRecord: PTERecordRow | null
): PTEResult {
  const base = parseISO(baseExpiry);

  if (!isValid(base)) {
    throw new Error(`Invalid base expiry date: ${baseExpiry}`);
  }

  if (!pteRecord || pteRecord.pte_days === 0) {
    return {
      patent_number: pteRecord?.patent_number ?? "",
      base_expiry: baseExpiry,
      pte_days: 0,
      pte_adjusted_expiry: baseExpiry,
      breakdown: {
        testing_phase_credit: 0,
        approval_phase_credit: 0,
        pre_grant_deduction: 0,
        cap_applied: "none",
      },
      is_estimate: true,
      data_available: pteRecord !== null,
    };
  }

  // Determine which cap was applied and compute adjusted expiry
  const { pteDays, capApplied } = applyPTECaps(
    pteRecord.pte_days,
    baseExpiry,
    pteRecord.nda_approval_date
  );

  const adjustedDate = addDays(base, pteDays);

  return {
    patent_number: pteRecord.patent_number,
    base_expiry: baseExpiry,
    pte_days: pteDays,
    pte_adjusted_expiry: format(adjustedDate, "yyyy-MM-dd"),
    breakdown: {
      testing_phase_credit: pteRecord.testing_phase_credit,
      approval_phase_credit: pteRecord.approval_phase_credit,
      pre_grant_deduction: pteRecord.pre_grant_deduction,
      cap_applied: capApplied,
    },
    is_estimate: true,
    data_available: true,
  };
}

/**
 * Apply the dual PTE cap:
 *   1. 5-year absolute cap
 *   2. 14-year post-approval cap
 *
 * Returns the final capped PTE days and which cap (if any) was applied.
 */
function applyPTECaps(
  rawPteDays: number,
  baseExpiry: string,
  ndaApprovalDate: string | null
): { pteDays: number; capApplied: PTECapApplied } {
  let pteDays = rawPteDays;
  let capApplied: PTECapApplied = "none";

  // Cap 1: 5-year absolute maximum
  if (pteDays > MAX_PTE_DAYS) {
    pteDays = MAX_PTE_DAYS;
    capApplied = "5_year";
  }

  // Cap 2: 14 years post-approval
  // Adjusted expiry cannot exceed NDA approval date + 14 years
  if (ndaApprovalDate) {
    const approvalDate = parseISO(ndaApprovalDate);
    const base = parseISO(baseExpiry);

    if (isValid(approvalDate) && isValid(base)) {
      const maxAllowedExpiry = addYears(approvalDate, POST_APPROVAL_YEARS);
      const proposedExpiry = addDays(base, pteDays);

      if (proposedExpiry > maxAllowedExpiry) {
        pteDays = differenceInDays(maxAllowedExpiry, base);
        pteDays = Math.max(0, pteDays);
        // 14-year cap is more restrictive only if it overrides the 5-year cap
        if (capApplied !== "5_year" || pteDays < MAX_PTE_DAYS) {
          capApplied = "14_year_post_approval";
        }
      }
    }
  }

  return { pteDays, capApplied };
}
