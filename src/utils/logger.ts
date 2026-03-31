type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  context?: Record<string, unknown>;
}

function log(
  level: LogLevel,
  source: string,
  message: string,
  context?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    ...(context !== undefined && { context }),
  };
  // Stderr keeps stdout clean for MCP protocol messages
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  info: (source: string, message: string, context?: Record<string, unknown>) =>
    log("info", source, message, context),
  warn: (source: string, message: string, context?: Record<string, unknown>) =>
    log("warn", source, message, context),
  error: (source: string, message: string, context?: Record<string, unknown>) =>
    log("error", source, message, context),
  debug: (source: string, message: string, context?: Record<string, unknown>) =>
    log("debug", source, message, context),
};
