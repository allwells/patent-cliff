import { describe, it, expect } from "bun:test";
import { addDays, addYears, format, parseISO } from "date-fns";
import { calculatePTE } from "../src/calculations/pte.js";
import type { PTERecordRow } from "../src/types/index.js";

const BASE_EXPIRY = "2028-03-20";
const NDA_APPROVAL = "2010-03-20"; // 14-year post-approval cap = 2024-03-20

function makePTERow(overrides: Partial<PTERecordRow> = {}): PTERecordRow {
  return {
    patent_number: "87654321",
    pte_days: 0,
    testing_phase_credit: 0,
    approval_phase_credit: 0,
    pre_grant_deduction: 0,
    cap_applied: null,
    nda_submission_date: "2005-01-01",
    nda_approval_date: NDA_APPROVAL,
    grant_date: "2008-01-01",
    uspto_pte_days: null,
    last_updated: "2024-01-01",
    ...overrides,
  };
}

describe("calculatePTE", () => {
  it("returns base expiry unchanged when no PTE record exists", () => {
    const result = calculatePTE(BASE_EXPIRY, null);
    expect(result.pte_adjusted_expiry).toBe(BASE_EXPIRY);
    expect(result.pte_days).toBe(0);
    expect(result.data_available).toBe(false);
  });

  it("returns base expiry unchanged when PTE days are zero", () => {
    const result = calculatePTE(BASE_EXPIRY, makePTERow({ pte_days: 0 }));
    expect(result.pte_adjusted_expiry).toBe(BASE_EXPIRY);
    expect(result.pte_days).toBe(0);
    expect(result.data_available).toBe(true);
  });

  it("adds PTE days to base expiry when no cap is hit", () => {
    // 365 days extension — well under both caps.
    // nda_approval_date 2025 → 14yr cap = 2039, well after proposed 2029 expiry.
    const result = calculatePTE(BASE_EXPIRY, makePTERow({ pte_days: 365, nda_approval_date: "2025-01-01" }));
    const expected = format(addDays(parseISO(BASE_EXPIRY), 365), "yyyy-MM-dd");
    expect(result.pte_adjusted_expiry).toBe(expected);
    expect(result.breakdown.cap_applied).toBe("none");
  });

  it("applies 5-year absolute cap", () => {
    // Request 6 years of extension — should be capped at 5 * 365.
    // nda_approval_date 2025 → 14yr cap = 2039, so only 5-year cap fires.
    const result = calculatePTE(
      BASE_EXPIRY,
      makePTERow({ pte_days: 6 * 365, nda_approval_date: "2025-01-01" })
    );
    const maxDays = 5 * 365;
    const expected = format(addDays(parseISO(BASE_EXPIRY), maxDays), "yyyy-MM-dd");
    expect(result.pte_adjusted_expiry).toBe(expected);
    expect(result.breakdown.cap_applied).toBe("5_year");
  });

  it("applies 14-year post-approval cap", () => {
    // NDA approved 2010-03-20 → max expiry = 2024-03-20
    // Base expiry 2022-01-01 + 1000 days would exceed 2024-03-20
    const base = "2022-01-01";
    const approval = "2010-01-01";
    const maxExpiry = format(addYears(parseISO(approval), 14), "yyyy-MM-dd");

    const result = calculatePTE(base, makePTERow({ pte_days: 1000, nda_approval_date: approval }));

    expect(result.pte_adjusted_expiry).toBe(maxExpiry);
    expect(result.breakdown.cap_applied).toBe("14_year_post_approval");
  });

  it("always sets is_estimate to true", () => {
    const withRecord = calculatePTE(BASE_EXPIRY, makePTERow({ pte_days: 365 }));
    const withoutRecord = calculatePTE(BASE_EXPIRY, null);
    expect(withRecord.is_estimate).toBe(true);
    expect(withoutRecord.is_estimate).toBe(true);
  });

  it("throws on invalid base expiry", () => {
    expect(() => calculatePTE("bad-date", makePTERow())).toThrow();
  });

  it("handles missing nda_approval_date gracefully — only applies 5-year cap", () => {
    const result = calculatePTE(
      BASE_EXPIRY,
      makePTERow({ pte_days: 6 * 365, nda_approval_date: null })
    );
    expect(result.breakdown.cap_applied).toBe("5_year");
  });
});
