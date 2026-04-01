/**
 * MCP server registration.
 *
 * Registers the `get_patent_cliff` tool with the MCP SDK.
 * One McpServer instance per request (stateless — no shared mutable state).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handlePatentCliff } from "./tools/patent-cliff.js";
import { getDb, isDbAvailable } from "./cache/db.js";
import { logger } from "./utils/logger.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "patent-cliff",
    version: "1.0.0",
  });

  server.registerTool(
    "get_patent_cliff",
    {
      title: "PatentCliff — Pharmaceutical Patent Expiration Analysis",
      description:
        "Returns the true patent expiration date and generic entry risk for a branded drug or active ingredient. " +
        "Calculates Patent Term Adjustment (PTA) and Patent Term Extension (PTE) corrections, " +
        "surfaces active Paragraph IV certifications and 30-month stay status, " +
        "identifies active PTAB invalidity proceedings, and synthesizes a generic entry risk score " +
        "(low → critical). Covers FDA Orange Book, USPTO PTA/PTE records, and PTAB docket data.",
      inputSchema: {
        drug_name: z
          .string()
          .min(1)
          .describe(
            "Brand name or active ingredient of the drug. " +
              "Examples: 'Eliquis', 'apixaban', 'Humira', 'adalimumab', 'Jardiance', 'Ozempic'."
          ),
      },
      outputSchema: {
        // Shared
        drug_name: z.string(),
        disclaimers: z.object({
          estimate_notice: z.string().optional(),
          sealed_paragraph_iv_notice: z.string(),
          pre_anda_notice: z.string(),
        }),
        // DrugNotFoundResponse
        found: z.boolean().optional(),
        message: z.string().optional(),
        // PatentCliffResponse
        active_ingredient: z.string().optional(),
        nda_number: z.string().optional(),
        applicant: z.string().optional(),
        base_expiry: z.string().optional(),
        pta_adjusted_expiry: z.string().nullable().optional(),
        pte_adjusted_expiry: z.string().nullable().optional(),
        final_adjusted_expiry: z.string().optional(),
        expiry_is_estimate: z.literal(true).optional(),
        pta: z.record(z.unknown()).nullable().optional(),
        pte: z.record(z.unknown()).nullable().optional(),
        paragraph_iv: z.record(z.unknown()).optional(),
        ptab: z.record(z.unknown()).optional(),
        pediatric_exclusivity: z.record(z.unknown()).optional(),
        risk_score: z.string().optional(),
        risk_factors: z.array(z.string()).optional(),
        data_freshness: z.record(z.unknown()).optional(),
      },
    },
    async ({ drug_name }) => {
      if (!isDbAvailable()) {
        logger.error("mcp", "Database unavailable — cannot process query", { drug_name });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Database unavailable",
                message:
                  "The patent database is currently unavailable. Please try again shortly.",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const db = getDb();
        const result = await handlePatentCliff(db, { drug_name });

        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("mcp", "Tool handler error", { drug_name, message });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Internal error",
                message: "An error occurred processing your request. Please try again.",
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}
