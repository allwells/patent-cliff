/**
 * Integration tests for the patent-cliff tool handler.
 *
 * Uses an in-memory SQLite database seeded with fixtures.
 * Tests the full pipeline from drug_name input to PatentCliffResponse.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { handlePatentCliff } from "../src/tools/patent-cliff.js";
import { fixtures, seedAll, seedFreshness } from "./fixtures/drugs.js";
import type { PatentCliffResponse, DrugNotFoundResponse } from "../src/types/index.js";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const schema = readFileSync(
    join(import.meta.dirname, "../src/cache/schema.sql"),
    "utf-8"
  );
  db.exec(schema);
  return db;
}

// Patent numbers per fixture — arbitrary but unique
const PATENT_NUMBERS: Record<string, string> = {
  lowRisk: "11111111",
  moderateRisk: "22222222",
  elevatedRisk: "33333333",
  highRisk: "44444444",
  criticalRisk: "55555555",
};

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedFreshness(db);
  for (const key of Object.keys(PATENT_NUMBERS) as Array<keyof typeof PATENT_NUMBERS>) {
    seedAll(db, key as never, PATENT_NUMBERS[key]!);
  }
});

afterEach(() => {
  db.close();
});

// ── Not found ──────────────────────────────────────────────────────────────────

describe("drug not found", () => {
  it("returns found:false for an unknown drug name", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.notFound.drug_name });
    const res = result as DrugNotFoundResponse;
    expect(res.found).toBe(false);
    expect(res.drug_name).toBe(fixtures.notFound.drug_name);
  });

  it("not-found response still includes both coverage disclaimers", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.notFound.drug_name });
    const res = result as DrugNotFoundResponse;
    expect(res.disclaimers.sealed_paragraph_iv_notice).toBeTruthy();
    expect(res.disclaimers.pre_anda_notice).toBeTruthy();
  });
});

// ── Required fields — every successful response ────────────────────────────────

describe("required fields in every response", () => {
  it("expiry_is_estimate is always true", async () => {
    for (const key of ["lowRisk", "moderateRisk", "elevatedRisk", "highRisk", "criticalRisk"] as const) {
      const f = fixtures[key];
      const result = await handlePatentCliff(db, { drug_name: f.drug_name });
      const res = result as PatentCliffResponse;
      expect(res.expiry_is_estimate).toBe(true);
    }
  });

  it("estimate_notice is present in every response", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.lowRisk.drug_name });
    const res = result as PatentCliffResponse;
    expect(res.disclaimers.estimate_notice).toBeTruthy();
    expect(res.disclaimers.estimate_notice.length).toBeGreaterThan(20);
  });

  it("sealed_paragraph_iv_notice is present in every response", async () => {
    for (const key of ["lowRisk", "highRisk"] as const) {
      const result = await handlePatentCliff(db, { drug_name: fixtures[key].drug_name });
      const res = result as PatentCliffResponse;
      expect(res.disclaimers.sealed_paragraph_iv_notice).toBeTruthy();
    }
  });

  it("pre_anda_notice is present in every response", async () => {
    for (const key of ["lowRisk", "criticalRisk"] as const) {
      const result = await handlePatentCliff(db, { drug_name: fixtures[key].drug_name });
      const res = result as PatentCliffResponse;
      expect(res.disclaimers.pre_anda_notice).toBeTruthy();
    }
  });

  it("risk_factors is always a non-empty array", async () => {
    for (const key of ["lowRisk", "moderateRisk", "elevatedRisk", "highRisk", "criticalRisk"] as const) {
      const result = await handlePatentCliff(db, { drug_name: fixtures[key].drug_name });
      const res = result as PatentCliffResponse;
      expect(Array.isArray(res.risk_factors)).toBe(true);
      expect(res.risk_factors.length).toBeGreaterThan(0);
    }
  });

  it("data_freshness block is present", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.lowRisk.drug_name });
    const res = result as PatentCliffResponse;
    expect(res.data_freshness).toBeDefined();
    expect(res.data_freshness.orangebook_last_updated).toBeTruthy();
  });
});

// ── Risk scores per fixture ────────────────────────────────────────────────────

describe("risk scores", () => {
  it("low risk fixture scores low", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.lowRisk.drug_name });
    expect((result as PatentCliffResponse).risk_score).toBe("low");
  });

  it("moderate risk fixture scores moderate", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.moderateRisk.drug_name });
    expect((result as PatentCliffResponse).risk_score).toBe("moderate");
  });

  it("elevated risk fixture scores elevated", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.elevatedRisk.drug_name });
    expect((result as PatentCliffResponse).risk_score).toBe("elevated");
  });

  it("high risk fixture scores high", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.highRisk.drug_name });
    expect((result as PatentCliffResponse).risk_score).toBe("high");
  });

  it("critical risk fixture scores critical", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.criticalRisk.drug_name });
    expect((result as PatentCliffResponse).risk_score).toBe("critical");
  });
});

// ── Drug name matching ─────────────────────────────────────────────────────────

describe("drug name matching", () => {
  it("matches by brand name (case-insensitive)", async () => {
    const result = await handlePatentCliff(db, { drug_name: "testovax" });
    expect((result as PatentCliffResponse).drug_name).toBe("TESTOVAX");
  });

  it("matches by active ingredient", async () => {
    const result = await handlePatentCliff(db, { drug_name: "testovaxin" });
    expect((result as PatentCliffResponse).nda_number).toBe(fixtures.lowRisk.nda_number);
  });

  it("matches with partial name", async () => {
    const result = await handlePatentCliff(db, { drug_name: "CALCI" });
    expect((result as PatentCliffResponse).nda_number).toBe(fixtures.moderateRisk.nda_number);
  });
});

// ── PTA / PTE presence ─────────────────────────────────────────────────────────

describe("PTA and PTE in response", () => {
  it("includes PTA result when PTA data exists", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.lowRisk.drug_name });
    const res = result as PatentCliffResponse;
    expect(res.pta).not.toBeNull();
    expect(res.pta?.pta_days).toBe(fixtures.lowRisk.pta_days);
    expect(res.pta?.is_estimate).toBe(true);
    expect(res.pta_adjusted_expiry).not.toBeNull();
  });

  it("pta is null when no PTA record exists", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.moderateRisk.drug_name });
    const res = result as PatentCliffResponse;
    expect(res.pta).toBeNull();
    expect(res.pta_adjusted_expiry).toBeNull();
  });

  it("includes PTE result when PTE data exists", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.elevatedRisk.drug_name });
    const res = result as PatentCliffResponse;
    expect(res.pte).not.toBeNull();
    expect(res.pte?.pte_days).toBe(fixtures.elevatedRisk.pte_days);
    expect(res.pte?.is_estimate).toBe(true);
    expect(res.pte_adjusted_expiry).not.toBeNull();
  });
});

// ── Paragraph IV ───────────────────────────────────────────────────────────────

describe("Paragraph IV in response", () => {
  it("active is false when no Para IV exists", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.lowRisk.drug_name });
    expect((result as PatentCliffResponse).paragraph_iv.active).toBe(false);
  });

  it("active is true when Para IV exists", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.highRisk.drug_name });
    expect((result as PatentCliffResponse).paragraph_iv.active).toBe(true);
  });

  it("stay_active is true for recent Para IV filing", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.highRisk.drug_name });
    expect((result as PatentCliffResponse).paragraph_iv.stay_active).toBe(true);
  });
});

// ── Pediatric exclusivity ──────────────────────────────────────────────────────

describe("pediatric exclusivity", () => {
  it("applies is false when no PED exclusivity exists", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.lowRisk.drug_name });
    expect((result as PatentCliffResponse).pediatric_exclusivity.applies).toBe(false);
  });

  it("applies is true for critical risk fixture", async () => {
    const result = await handlePatentCliff(db, { drug_name: fixtures.criticalRisk.drug_name });
    const res = result as PatentCliffResponse;
    expect(res.pediatric_exclusivity.applies).toBe(true);
    expect(res.pediatric_exclusivity.end_date).toBeTruthy();
  });
});
