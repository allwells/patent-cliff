/**
 * Pipeline orchestrator.
 *
 * Runs all four data pipelines in the correct dependency order:
 *   1. Orange Book  (must succeed before any others run)
 *   2. PTA, PTE, PTAB in parallel (all read from ob_patents)
 *
 * Exits 0 only if Orange Book succeeds and all downstream pipelines
 * succeed or produce only partial results.
 * Exits 1 if Orange Book fails or if any downstream pipeline fails.
 *
 * Run via: bun pipeline/run-all.ts
 */

import { $ } from "bun";

interface PipelineResult {
  source: string;
  status: "success" | "partial" | "failed";
  rows_inserted: number;
  rows_skipped: number;
  last_updated: string;
  errors: string[];
}

function log(level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  console.error(JSON.stringify({ level, message, ...extra, ts: new Date().toISOString() }));
}

async function runPipeline(scriptPath: string): Promise<PipelineResult> {
  const proc = Bun.spawn(["bun", scriptPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // Pipeline scripts write structured JSON to stderr for logging; print it through
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }

  if (exitCode !== 0) {
    throw new Error(`${scriptPath} exited with code ${exitCode}`);
  }

  // Pipeline scripts write their PipelineResult JSON to stdout
  const lastLine = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(lastLine) as PipelineResult;
  } catch {
    throw new Error(`${scriptPath} produced non-JSON stdout: ${lastLine}`);
  }
}

async function main(): Promise<void> {
  log("info", "Pipeline run starting");
  const startedAt = Date.now();

  // Step 1 — Orange Book (required; downstream pipelines depend on ob_patents)
  log("info", "Running Orange Book pipeline");
  let obResult: PipelineResult;
  try {
    obResult = await runPipeline("pipeline/fetch-orangebook.ts");
  } catch (err) {
    log("error", "Orange Book pipeline failed — aborting all downstream pipelines", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  if (obResult.status === "failed") {
    log("error", "Orange Book reported failure status — aborting", { result: obResult });
    process.exit(1);
  }

  log("info", "Orange Book complete", {
    status: obResult.status,
    rows_inserted: obResult.rows_inserted,
    rows_skipped: obResult.rows_skipped,
  });

  // Step 2 — PTA, PTE, PTAB in parallel (independent, all read from ob_patents)
  log("info", "Running PTA, PTE, PTAB pipelines in parallel");
  const downstream = await Promise.allSettled([
    runPipeline("pipeline/fetch-pta.ts"),
    runPipeline("pipeline/fetch-pte.ts"),
    runPipeline("pipeline/fetch-ptab.ts"),
  ]);

  const labels = ["pta", "pte", "ptab"] as const;
  let anyFailed = false;

  for (let i = 0; i < downstream.length; i++) {
    const label = labels[i]!;
    const outcome = downstream[i]!;
    if (outcome.status === "fulfilled") {
      log("info", `${label} complete`, {
        status: outcome.value.status,
        rows_inserted: outcome.value.rows_inserted,
      });
      if (outcome.value.status === "failed") anyFailed = true;
    } else {
      log("error", `${label} pipeline threw`, { error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
      anyFailed = true;
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  if (anyFailed) {
    log("warn", "Pipeline run completed with failures", { elapsed_seconds: elapsed });
    process.exit(1);
  }

  log("info", "All pipelines completed successfully", { elapsed_seconds: elapsed });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
