/**
 * Patent Term Adjustment (PTA) calculation.
 * Statutory basis: 35 U.S.C. §154(b)
 *
 * PTA compensates patent holders for delays caused by the USPTO during
 * examination. The total PTA days are published by the USPTO and stored
 * in pta_records.pta_days (sourced from PatentsView).
 *
 * This module takes the USPTO-published PTA days and computes the
 * adjusted expiry date. The breakdown (Category A/B/C) is stored for
 * display when available from PAIR data, but does not affect the
 * adjusted date if only the total is known.
 *
 * All results are labeled is_estimate: true — PTA is frequently corrected
 * by the USPTO after initial grant and can be disputed through litigation.
 */

import { addDays, parseISO, isValid, format } from "date-fns";
import type { PTARecordRow, PTAResult } from "../types/index.js";

/**
 * Compute PTA-adjusted expiry for a patent.
 *
 * @param baseExpiry   ISO 8601 date string from Orange Book (ob_patents.patent_expire_date)
 * @param ptaRecord    PTA record from pta_records table, or null if no data
 */
export function calculatePTA(
  baseExpiry: string,
  ptaRecord: PTARecordRow | null
): PTAResult {
  const base = parseISO(baseExpiry);

  if (!isValid(base)) {
    throw new Error(`Invalid base expiry date: ${baseExpiry}`);
  }

  if (!ptaRecord || ptaRecord.pta_days === 0) {
    return {
      patent_number: ptaRecord?.patent_number ?? "",
      base_expiry: baseExpiry,
      pta_days: 0,
      pta_adjusted_expiry: baseExpiry,
      breakdown: {
        category_a_days: 0,
        category_b_days: 0,
        category_c_days: 0,
        overlap_deduction: 0,
        applicant_delay_deduction: 0,
      },
      is_estimate: true,
      data_available: ptaRecord !== null,
    };
  }

  // PTA days cannot be negative — clamp per statute
  const ptaDays = Math.max(0, ptaRecord.pta_days);
  const adjustedDate = addDays(base, ptaDays);

  return {
    patent_number: ptaRecord.patent_number,
    base_expiry: baseExpiry,
    pta_days: ptaDays,
    pta_adjusted_expiry: format(adjustedDate, "yyyy-MM-dd"),
    breakdown: {
      category_a_days: ptaRecord.category_a_days,
      category_b_days: ptaRecord.category_b_days,
      category_c_days: ptaRecord.category_c_days,
      overlap_deduction: ptaRecord.overlap_deduction,
      applicant_delay_deduction: ptaRecord.applicant_delay,
    },
    is_estimate: true,
    data_available: true,
  };
}

/**
 * Given multiple patents for the same NDA, return the one with the
 * latest PTA-adjusted expiry (the controlling expiry for the drug).
 */
export function latestPTAExpiry(results: PTAResult[]): PTAResult | null {
  if (results.length === 0) return null;

  return results.reduce((latest, current) => {
    const latestDate = parseISO(latest.pta_adjusted_expiry);
    const currentDate = parseISO(current.pta_adjusted_expiry);
    return currentDate > latestDate ? current : latest;
  });
}
