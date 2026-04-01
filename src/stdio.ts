// Stdio entry point — used for local dev and IDE testing (no OAuth required).
// Production uses src/index.ts (HTTP + CTX Protocol auth).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "dotenv";
import { initDatabase } from "./cache/db.js";
import { createMcpServer } from "./mcp.js";
import { logger } from "./utils/logger.js";

config();

const dbPath = process.env["DB_PATH"] ?? "./patent-cliff.db";
initDatabase(dbPath);

logger.info("stdio", "PatentCliff MCP starting in stdio mode", { dbPath });

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
