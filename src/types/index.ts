// ============================================================
// Database row types — mirror src/cache/schema.sql
// ============================================================

export interface ProductRow {
  nda_number: string;
  drug_name: string;
  active_ingredient: string;
  applicant: string;
  strength: string;
  dosage_form: string;
  route: string;
  approval_date: string | null;
  te_code: string | null;
  rld: number;
  type: string;
}

export interface OBPatentRow {
  nda_number: string;
  patent_number: string;
  patent_expire_date: string;
  drug_substance_flag: number;
  drug_product_flag: number;
  patent_use_code: string | null;
  delist_flag: number;
  submission_date: string | null;
}

export interface ExclusivityRow {
  nda_number: string;
  exclusivity_code: string;
  exclusivity_date: string;
}

export interface ParagraphIVRow {
  nda_number: string;
  patent_number: string;
  applicant_name: string | null;
  anda_number: string | null;
  submission_date: string | null;
}

export interface PTARecordRow {
  patent_number: string;
  pta_days: number;
  category_a_days: number;
  category_b_days: number;
  category_c_days: number;
  overlap_deduction: number;
  applicant_delay: number;
  grant_date: string | null;
  application_date: string | null;
  uspto_pta_days: number | null;
  last_updated: string;
}

export interface PTERecordRow {
  patent_number: string;
  pte_days: number;
  testing_phase_credit: number;
  approval_phase_credit: number;
  pre_grant_deduction: number;
  cap_applied: string | null;
  nda_submission_date: string | null;
  nda_approval_date: string | null;
  grant_date: string | null;
  uspto_pte_days: number | null;
  last_updated: string;
}

export interface PTABProceedingRow {
  case_number: string;
  patent_number: string;
  petitioner: string | null;
  respondent: string | null;
  status: string;
  type: string;
  filed_date: string | null;
  institution_date: string | null;
  decision_date: string | null;
  last_updated: string;
}

export interface DataFreshnessRow {
  source: string;
  last_updated: string;
  rows_current: number;
  last_run_status: string;
}

// ============================================================
// Calculation result types
// ============================================================

export interface PTAResult {
  patent_number: string;
  base_expiry: string;
  pta_days: number;
  pta_adjusted_expiry: string;
  breakdown: {
    category_a_days: number;
    category_b_days: number;
    category_c_days: number;
    overlap_deduction: number;
    applicant_delay_deduction: number;
  };
  is_estimate: true;
  data_available: boolean;
}

export type PTECapApplied = "5_year" | "14_year_post_approval" | "none";

export interface PTEResult {
  patent_number: string;
  base_expiry: string;
  pte_days: number;
  pte_adjusted_expiry: string;
  breakdown: {
    testing_phase_credit: number;
    approval_phase_credit: number;
    pre_grant_deduction: number;
    cap_applied: PTECapApplied;
  };
  is_estimate: true;
  data_available: boolean;
}

export interface PediatricResult {
  applies: boolean;
  end_date: string | null;
  extension_days: number;
}

// ============================================================
// Final PatentCliff response
// ============================================================

export type RiskLevel = "low" | "moderate" | "elevated" | "high" | "critical";

export interface PatentCliffResponse {
  drug_name: string;
  active_ingredient: string;
  nda_number: string;
  applicant: string;

  // Date fields — always estimates
  base_expiry: string;
  pta_adjusted_expiry: string | null;
  pte_adjusted_expiry: string | null;
  final_adjusted_expiry: string;
  expiry_is_estimate: true;

  pta: PTAResult | null;
  pte: PTEResult | null;

  paragraph_iv: {
    active: boolean;
    filers: string[];
    stay_active: boolean;
    stay_expires: string | null;
  };

  ptab: {
    active_proceedings: number;
    proceedings: Array<{
      case_number: string;
      petitioner: string | null;
      status: string;
      filed_date: string | null;
    }>;
  };

  pediatric_exclusivity: PediatricResult;

  risk_score: RiskLevel;
  risk_factors: string[];

  // Required in every response — never omit
  disclaimers: {
    estimate_notice: string;
    sealed_paragraph_iv_notice: string;
    pre_anda_notice: string;
  };

  data_freshness: {
    orangebook_last_updated: string | null;
    uspto_last_updated: string | null;
    ptab_last_updated: string | null;
    any_source_stale: boolean;
  };
}

export interface DrugNotFoundResponse {
  drug_name: string;
  found: false;
  message: string;
  disclaimers: {
    sealed_paragraph_iv_notice: string;
    pre_anda_notice: string;
  };
}

export type ToolResponse = PatentCliffResponse | DrugNotFoundResponse;

// ============================================================
// Pipeline result type (shared by all pipeline scripts)
// ============================================================

export type DataSource = "orangebook" | "pta" | "pte" | "ptab";

export interface PipelineResult {
  source: DataSource;
  status: "success" | "partial" | "failed";
  rows_inserted: number;
  rows_skipped: number;
  last_updated: string;
  errors: string[];
}
