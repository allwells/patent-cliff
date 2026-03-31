import { describe, it, expect } from "bun:test";
import { addDays, format, parseISO } from "date-fns";
import { calculatePTA, latestPTAExpiry } from "../src/calculations/pta.js";
import type { PTARecordRow } from "../src/types/index.js";

const BASE_EXPIRY = "2030-06-15";

function makePTARow(overrides: Partial<PTARecordRow> = {}): PTARecordRow {
  return {
    patent_number: "12345678",
    pta_days: 0,
    category_a_days: 0,
    category_b_days: 0,
    category_c_days: 0,
    overlap_deduction: 0,
    applicant_delay: 0,
    grant_date: "2010-01-01",
    application_date: "2007-01-01",
    uspto_pta_days: null,
    last_updated: "2024-01-01",
    ...overrides,
  };
}

describe("calculatePTA", () => {
  it("returns base expiry unchanged when no PTA record exists", () => {
    const result = calculatePTA(BASE_EXPIRY, null);
    expect(result.pta_adjusted_expiry).toBe(BASE_EXPIRY);
    expect(result.pta_days).toBe(0);
    expect(result.data_available).toBe(false);
  });

  it("returns base expiry unchanged when PTA days are zero", () => {
    const result = calculatePTA(BASE_EXPIRY, makePTARow({ pta_days: 0 }));
    expect(result.pta_adjusted_expiry).toBe(BASE_EXPIRY);
    expect(result.pta_days).toBe(0);
    expect(result.data_available).toBe(true);
  });

  it("adds PTA days to base expiry", () => {
    const result = calculatePTA(BASE_EXPIRY, makePTARow({ pta_days: 180 }));
    const expected = format(addDays(parseISO(BASE_EXPIRY), 180), "yyyy-MM-dd");
    expect(result.pta_adjusted_expiry).toBe(expected);
    expect(result.pta_days).toBe(180);
  });

  it("clamps negative PTA days to zero", () => {
    // Should not happen in real data but guard against malformed records
    const result = calculatePTA(BASE_EXPIRY, makePTARow({ pta_days: -50 }));
    expect(result.pta_adjusted_expiry).toBe(BASE_EXPIRY);
    expect(result.pta_days).toBe(0);
  });

  it("preserves breakdown fields from the PTA record", () => {
    const result = calculatePTA(
      BASE_EXPIRY,
      makePTARow({
        pta_days: 300,
        category_a_days: 100,
        category_b_days: 150,
        category_c_days: 80,
        overlap_deduction: 20,
        applicant_delay: 10,
      })
    );
    expect(result.breakdown.category_a_days).toBe(100);
    expect(result.breakdown.category_b_days).toBe(150);
    expect(result.breakdown.category_c_days).toBe(80);
    expect(result.breakdown.overlap_deduction).toBe(20);
    expect(result.breakdown.applicant_delay_deduction).toBe(10);
  });

  it("always sets is_estimate to true", () => {
    const withRecord = calculatePTA(BASE_EXPIRY, makePTARow({ pta_days: 100 }));
    const withoutRecord = calculatePTA(BASE_EXPIRY, null);
    expect(withRecord.is_estimate).toBe(true);
    expect(withoutRecord.is_estimate).toBe(true);
  });

  it("throws on invalid base expiry date", () => {
    expect(() => calculatePTA("not-a-date", makePTARow())).toThrow();
  });
});

describe("latestPTAExpiry", () => {
  it("returns null for empty array", () => {
    expect(latestPTAExpiry([])).toBeNull();
  });

  it("returns the single result for a one-element array", () => {
    const result = calculatePTA(BASE_EXPIRY, makePTARow({ pta_days: 100 }));
    expect(latestPTAExpiry([result])).toBe(result);
  });

  it("returns the result with the latest adjusted expiry", () => {
    const earlier = calculatePTA("2028-01-01", makePTARow({ pta_days: 0, patent_number: "A" }));
    const later = calculatePTA("2031-06-01", makePTARow({ pta_days: 90, patent_number: "B" }));
    const middle = calculatePTA("2029-12-31", makePTARow({ pta_days: 180, patent_number: "C" }));

    const result = latestPTAExpiry([earlier, later, middle]);
    expect(result?.patent_number).toBe("B");
  });
});
