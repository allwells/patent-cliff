// PatentCliff MCP — entry point
// Startup order: env validate → DB init → server start

import { config } from "dotenv";
import { initDatabase } from "./cache/db.js";
import { startServer } from "./server.js";
import { logger } from "./utils/logger.js";

config();

function validateEnv(): void {
  const missing: string[] = [];
  if (!process.env["PORT"]) {
    logger.info("startup", "PORT not set — defaulting to 8000");
  }
  if (!process.env["DB_PATH"]) {
    logger.info("startup", "DB_PATH not set — defaulting to ./patent-cliff.db");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

validateEnv();
initDatabase(process.env["DB_PATH"] ?? "./patent-cliff.db");
startServer();
