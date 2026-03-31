import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";

let db: Database | null = null;

export function initDatabase(dbPath: string): void {
  try {
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    const schema = readFileSync(
      join(import.meta.dirname, "schema.sql"),
      "utf-8"
    );
    db.exec(schema);

    logger.info("db", "Database initialized", { path: dbPath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("db", "Failed to initialize database", { message });
    // Graceful degradation: server will start but queries will fail cleanly
    db = null;
  }
}

export function getDb(): Database {
  if (!db) {
    throw new Error(
      "Database not initialized. Run initDatabase() at startup."
    );
  }
  return db;
}

export function isDbAvailable(): boolean {
  return db !== null;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
