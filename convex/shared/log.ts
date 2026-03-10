export type LogLevel = "info" | "warn" | "error";

export function createCorrelationId() {
  return crypto.randomUUID();
}

export function log(level: LogLevel, phase: string, msg: string, context: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      level,
      phase,
      msg,
      ...context,
      ts: new Date().toISOString(),
    })
  );
}
