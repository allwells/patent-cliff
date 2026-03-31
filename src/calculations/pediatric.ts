/**
 * Pediatric exclusivity extension.
 *
 * When the FDA issues a Written Request for pediatric studies and the
 * sponsor complies, the drug receives 6 months of additional protection
 * appended beyond ALL other patents and exclusivity periods.
 *
 * Tracked in the Orange Book exclusivity table as exclusivity_code = "PED".
 * The exclusivity_date in the Orange Book is the final end date of the
 * pediatric period (i.e., base protection end + 6 months).
 */

import { addMonths, parseISO, isValid, format, differenceInDays } from "date-fns";
import type { ExclusivityRow, PediatricResult } from "../types/index.js";

const PEDIATRIC_MONTHS = 6;

/**
 * Determine whether pediatric exclusivity applies and compute its end date.
 *
 * @param exclusivityRows  All exclusivity rows for the NDA
 * @param baseProtectionEnd  The final adjusted expiry before pediatric extension
 */
export function calculatePediatricExclusivity(
  exclusivityRows: ExclusivityRow[],
  baseProtectionEnd: string
): PediatricResult {
  const pedRow = exclusivityRows.find((r) => r.exclusivity_code === "PED");

  if (!pedRow) {
    return { applies: false, end_date: null, extension_days: 0 };
  }

  // Orange Book stores the actual pediatric end date directly.
  // Use it if valid; otherwise compute from base protection end.
  const obEndDate = parseISO(pedRow.exclusivity_date);

  if (isValid(obEndDate)) {
    const base = parseISO(baseProtectionEnd);
    const extensionDays = isValid(base)
      ? Math.max(0, differenceInDays(obEndDate, base))
      : PEDIATRIC_MONTHS * 30;

    return {
      applies: true,
      end_date: format(obEndDate, "yyyy-MM-dd"),
      extension_days: extensionDays,
    };
  }

  // Fallback: compute +6 months from base protection end
  const base = parseISO(baseProtectionEnd);
  if (!isValid(base)) {
    return { applies: true, end_date: null, extension_days: PEDIATRIC_MONTHS * 30 };
  }

  const endDate = addMonths(base, PEDIATRIC_MONTHS);
  return {
    applies: true,
    end_date: format(endDate, "yyyy-MM-dd"),
    extension_days: differenceInDays(endDate, base),
  };
}

/**
 * Apply pediatric extension to a final expiry date.
 * Returns the new final expiry if pediatric applies, otherwise returns the input unchanged.
 */
export function applyPediatricExtension(
  finalExpiry: string,
  pediatric: PediatricResult
): string {
  if (!pediatric.applies || !pediatric.end_date) return finalExpiry;

  const existing = parseISO(finalExpiry);
  const pedEnd = parseISO(pediatric.end_date);

  if (!isValid(existing) || !isValid(pedEnd)) return finalExpiry;

  // Pediatric end date is authoritative from Orange Book when available
  return pedEnd > existing ? format(pedEnd, "yyyy-MM-dd") : finalExpiry;
}
