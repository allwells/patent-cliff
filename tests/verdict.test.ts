import { describe, it, expect } from "bun:test";
import { addYears, addMonths, subMonths, subYears, format } from "date-fns";
import { synthesizeVerdict } from "../src/tools/verdict.js";
import type { ParagraphIVRow, PTABProceedingRow, ExclusivityRow } from "../src/types/index.js";

const fmt = (d: Date) => format(d, "yyyy-MM-dd");
const today = new Date();

const noParagraphIV: ParagraphIVRow[] = [];
const noPTAB: PTABProceedingRow[] = [];
const noExclusivity: ExclusivityRow[] = [];
const noPediatric = { applies: false, end_date: null, extension_days: 0 };

function makeParagraphIV(submissionDate: string): ParagraphIVRow {
  return {
    nda_number: "N999001",
    patent_number: "12345678",
    applicant_name: "Generic Filer LLC",
    anda_number: "A999001",
    submission_date: submissionDate,
  };
}

function makePTAB(status = "Instituted"): PTABProceedingRow {
  return {
    case_number: "IPR2024-00123",
    patent_number: "12345678",
    petitioner: "Generic Petitioner Inc",
    respondent: "Brand Pharma Corp",
    status,
    type: "IPR",
    filed_date: fmt(subMonths(today, 8)),
    institution_date: fmt(subMonths(today, 2)),
    decision_date: null,
    last_updated: fmt(today),
  };
}

describe("synthesizeVerdict — risk scoring", () => {
  it("scores LOW: no Para IV, no PTAB, expires in 8 years", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 8)),
      paragraphIVRows: noParagraphIV,
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_score).toBe("low");
  });

  it("scores MODERATE: no Para IV, no PTAB, expires in 3.5 years", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addMonths(today, 42)),
      paragraphIVRows: noParagraphIV,
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_score).toBe("moderate");
  });

  it("scores ELEVATED: active Para IV, stay expired (>30 months old)", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 4)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 36)))],
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_score).toBe("elevated");
  });

  it("scores ELEVATED: imminent expiry (<2 years) with no challenges", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addMonths(today, 18)),
      paragraphIVRows: noParagraphIV,
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_score).toBe("elevated");
  });

  it("scores HIGH: active Para IV with active 30-month stay", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 3)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 6)))], // stay active
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_score).toBe("high");
  });

  it("scores HIGH: active Para IV + active PTAB, stay not active", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 4)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 36)))], // stay expired
      ptabRows: [makePTAB("Instituted")],
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_score).toBe("high");
  });

  it("scores CRITICAL: Para IV + PTAB + stay expiring within 12 months", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 2)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 21)))], // stay expires in ~9 months
      ptabRows: [makePTAB("Instituted")],
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_score).toBe("critical");
  });

  it("all five risk levels are representable", () => {
    // Ensures the scoring ladder has no gaps
    const levels = new Set<string>();

    levels.add(synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 8)),
      paragraphIVRows: [], ptabRows: [], pediatric: noPediatric, exclusivityRows: [],
    }).risk_score);

    levels.add(synthesizeVerdict({
      finalAdjustedExpiry: fmt(addMonths(today, 42)),
      paragraphIVRows: [], ptabRows: [], pediatric: noPediatric, exclusivityRows: [],
    }).risk_score);

    levels.add(synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 4)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 36)))],
      ptabRows: [], pediatric: noPediatric, exclusivityRows: [],
    }).risk_score);

    levels.add(synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 3)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 6)))],
      ptabRows: [], pediatric: noPediatric, exclusivityRows: [],
    }).risk_score);

    levels.add(synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 2)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 21)))],
      ptabRows: [makePTAB()], pediatric: noPediatric, exclusivityRows: [],
    }).risk_score);

    expect(levels).toContain("low");
    expect(levels).toContain("moderate");
    expect(levels).toContain("elevated");
    expect(levels).toContain("high");
    expect(levels).toContain("critical");
  });
});

describe("synthesizeVerdict — output shape", () => {
  it("always returns non-empty risk_factors", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 8)),
      paragraphIVRows: noParagraphIV,
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_factors.length).toBeGreaterThan(0);
  });

  it("reflects Para IV filer name in output", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 4)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 36)))],
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.paragraph_iv.active).toBe(true);
    expect(result.paragraph_iv.filers).toContain("Generic Filer LLC");
  });

  it("stay_active is false when submission was >30 months ago", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 4)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 36)))],
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.paragraph_iv.stay_active).toBe(false);
  });

  it("stay_active is true when submission was <30 months ago", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 4)),
      paragraphIVRows: [makeParagraphIV(fmt(subMonths(today, 6)))],
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.paragraph_iv.stay_active).toBe(true);
  });

  it("counts only Instituted PTAB proceedings as active", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 4)),
      paragraphIVRows: noParagraphIV,
      ptabRows: [makePTAB("Denied"), makePTAB("Settled"), makePTAB("Instituted")],
      pediatric: noPediatric,
      exclusivityRows: noExclusivity,
    });
    expect(result.ptab.active_proceedings).toBe(1);
    expect(result.ptab.proceedings).toHaveLength(3); // all returned, only 1 active
  });

  it("notes pediatric exclusivity in risk_factors when applicable", () => {
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 6)),
      paragraphIVRows: noParagraphIV,
      ptabRows: noPTAB,
      pediatric: { applies: true, end_date: fmt(addMonths(addYears(today, 6), 6)), extension_days: 183 },
      exclusivityRows: noExclusivity,
    });
    expect(result.risk_factors.some((f) => f.includes("Pediatric"))).toBe(true);
  });

  it("notes NCE exclusivity in risk_factors when active", () => {
    const nceRow: ExclusivityRow = {
      nda_number: "N999001",
      exclusivity_code: "NCE",
      exclusivity_date: fmt(addYears(today, 2)),
    };
    const result = synthesizeVerdict({
      finalAdjustedExpiry: fmt(addYears(today, 8)),
      paragraphIVRows: noParagraphIV,
      ptabRows: noPTAB,
      pediatric: noPediatric,
      exclusivityRows: [nceRow],
    });
    expect(result.risk_factors.some((f) => f.includes("NCE"))).toBe(true);
  });
});
