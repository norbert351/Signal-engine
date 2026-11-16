import { sql } from "@signal-engine/database";
import { listHealth } from "@signal-engine/database/system-repository";
import { connection } from "./queues.js";

const VALID_ROLES = ["ingestion", "scanner", "paper", "notifications", "backtests", "monitor"] as const;
type Role = (typeof VALID_ROLES)[number];

export function resolveExpectedWorkerComponents(workerRole = process.env.WORKER_ROLE ?? "all"): string[] {
  if (workerRole === "all") return VALID_ROLES.map((role) => `worker:${role}`);
  if ((VALID_ROLES as readonly string[]).includes(workerRole)) return [`worker:${workerRole as Role}`];
  throw new Error(`Invalid WORKER_ROLE: ${workerRole}`);
}

export function evaluateWorkerHealthRows(
  rows: Array<{ component: string; status: string; checkedAt: Date; details?: unknown }>,
  expectedComponents: string[],
  nowMs = Date.now(),
  maxAgeMs = Number(process.env.WORKER_HEALTH_MAX_AGE_SECONDS ?? "180") * 1000
): { ok: boolean; reason?: string; checked: string[] } {
  const byComponent = new Map(rows.map((row) => [row.component, row]));
  for (const component of expectedComponents) {
    const row = byComponent.get(component);
    if (!row) return { ok: false, reason: `missing health record for ${component}`, checked: expectedComponents };
    if (row.status === "error") {
      return { ok: false, reason: `${component} reported error status`, checked: expectedComponents };
    }
    const ageMs = nowMs - new Date(row.checkedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
      return { ok: false, reason: `${component} heartbeat is stale (${Math.round(ageMs / 1000)}s old)`, checked: expectedComponents };
    }
    const details = (row.details ?? {}) as { stalled?: boolean; workerRunning?: boolean; redisReady?: boolean };
    if (details.stalled === true || details.workerRunning === false || details.redisReady === false) {
      return { ok: false, reason: `${component} internal processing is stalled or disconnected`, checked: expectedComponents };
    }
  }
  return { ok: true, checked: expectedComponents };
}

export async function runWorkerHealthcheck(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const expected = resolveExpectedWorkerComponents();
    const [pong, rows] = await Promise.all([connection.ping(), listHealth()]);
    if (pong !== "PONG") {
      return { ok: false, reason: `Unexpected Redis ping response: ${String(pong)}` };
    }
    const evaluation = evaluateWorkerHealthRows(rows, expected);
    return evaluation;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Healthcheck failed" };
  }
}

const isMain = process.argv[1]?.endsWith("healthcheck.js") || process.argv[1]?.endsWith("healthcheck.ts");
if (isMain) {
  void runWorkerHealthcheck()
    .then(async (result) => {
      await Promise.allSettled([connection.quit(), sql.end({ timeout: 2 })]);
      if (!result.ok) {
        console.error(`Worker healthcheck failed: ${result.reason ?? "unknown"}`);
        process.exit(1);
      }
      process.exit(0);
    })
    .catch(async (error) => {
      await Promise.allSettled([connection.quit(), sql.end({ timeout: 2 })]);
      console.error("Worker healthcheck exception:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
