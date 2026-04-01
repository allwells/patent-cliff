// HTTP server — Express with /health and /mcp endpoints.

import express from "express";
import type { RequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import { createMcpServer } from "./mcp.js";
import { getDataFreshness } from "./cache/queries.js";
import { isDbAvailable, getDb } from "./cache/db.js";
import { logger } from "./utils/logger.js";

const PORT = parseInt(process.env["PORT"] ?? "8000", 10);

export function startServer(): void {
  const app = express();

  app.use(express.json());

  // Health check — reports data freshness per source, not just HTTP 200
  app.get("/health", (_req, res) => {
    const health: Record<string, unknown> = {
      status: "ok",
      service: "PatentCliff MCP",
      version: process.env["npm_package_version"] ?? "1.0.0",
      db_available: isDbAvailable(),
    };

    if (isDbAvailable()) {
      try {
        const freshness = getDataFreshness(getDb());
        health["data_freshness"] = freshness;
      } catch {
        health["data_freshness"] = "unavailable";
      }
    }

    res.json(health);
  });

  // CTX Protocol auth middleware — allows discovery (tools/list) without auth,
  // requires verified JWT for execution (tools/call).
  // Skipped in dev mode (NODE_ENV=development) for local testing without OAuth.
  if (process.env["NODE_ENV"] !== "development") {
    app.use("/mcp", createContextMiddleware() as unknown as RequestHandler);
  }

  // MCP endpoint — stateless HTTP Streaming transport (one server+transport per request).
  // No-arg constructor omits sessionIdGenerator, which is stateless mode at runtime.
  // Cast to Transport required: SDK optional property types conflict with exactOptionalPropertyTypes.
  app.post("/mcp", async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, req.body);
    res.on("finish", () => server.close());
  });

  app.listen(PORT, () => {
    logger.info("server", `PatentCliff MCP listening on port ${PORT}`);
    logger.info("server", `MCP endpoint: http://localhost:${PORT}/mcp`);
    logger.info("server", `Health: http://localhost:${PORT}/health`);
  });
}
