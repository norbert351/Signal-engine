import { Worker } from "bullmq";
import { sql } from "@signal-engine/database";
import { connection, ingestionQueue, scanQueue, paperQueue, backtestQueue, notificationQueue, monitorQueue } from "./queues.js";
import { ingestCrypto, ingestForex } from "./ingestion.js";
import { processScan } from "./scanner.js";
import { deliverPending } from "./telegram.js";
import { processPaperTrades } from "./paper-tracker.js";
import { processBacktests } from "./backtests.js";
import { reportWorkerHealth } from "./health.js";
import { backfillHistory, processBackfillRequests } from "./backfill.js";
import { runMonitoring } from "./monitoring.js";
import { errorText } from "./format.js";

export type Role = "ingestion" | "scanner" | "paper" | "notifications" | "backtests" | "monitor";
const allRoles: Role[] = ["ingestion", "scanner", "paper", "notifications", "backtests", "monitor"];
const requested = (process.env.WORKER_ROLE ?? "all") as Role | "all";
const roles: Role[] = requested === "all" ? allRoles : allRoles.includes(requested) ? [requested] : [];
if (!roles.length) throw new Error(`Invalid WORKER_ROLE: ${requested}`);

type RoleRuntimeState = {
  role: Role;
  startedAt: string;
  startedAtMs: number;
  expectedIntervalMs: number;
  lastJob?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastCompletedAtMs?: number;
  lastDurationMs?: number;
  lastError?: string | undefined;
  consecutiveFailures: number;
  activeJobs: number;
  worker?: Worker;
};

const workers: Worker[] = [];
const roleStates = new Map<Role, RoleRuntimeState>();
const interval = (name: string, fallback: number) => Number(process.env[name] ?? String(fallback));

export function evaluateRoleRuntimeHealth(
  state: Omit<RoleRuntimeState, "worker">,
  options: { workerRunning: boolean; redisReady: boolean; nowMs?: number }
): { status: "ok" | "degraded" | "error"; stalled: boolean; details: Record<string, unknown> } {
  const nowMs = options.nowMs ?? Date.now();
  const referenceMs = state.lastCompletedAtMs ?? state.startedAtMs;
  const idleMs = Math.max(0, nowMs - referenceMs);
  const maxIdleMs = Math.max(state.expectedIntervalMs * 4, 10 * 60_000);
  const stalled = state.activeJobs === 0 && idleMs > maxIdleMs;
  let status: "ok" | "degraded" | "error" = "ok";
  if (!options.workerRunning || !options.redisReady || stalled || state.consecutiveFailures >= 5) {
    status = "error";
  } else if (state.consecutiveFailures > 0) {
    status = "degraded";
  }
  return {
    status,
    stalled,
    details: {
      queue: state.role,
      pid: process.pid,
      startedAt: state.startedAt,
      heartbeatAt: new Date(nowMs).toISOString(),
      lastJob: state.lastJob ?? null,
      lastStartedAt: state.lastStartedAt ?? null,
      lastCompletedAt: state.lastCompletedAt ?? null,
      completedAt: state.lastCompletedAt ?? null,
      lastDurationMs: state.lastDurationMs ?? null,
      lastError: state.lastError ?? null,
      consecutiveFailures: state.consecutiveFailures,
      activeJobs: state.activeJobs,
      idleSeconds: Math.round(idleMs / 1000),
      maxIdleSeconds: Math.round(maxIdleMs / 1000),
      stalled,
      workerRunning: options.workerRunning,
      redisReady: options.redisReady
    }
  };
}

async function emitHeartbeats() {
  const redisReady = connection.status === "ready" || connection.status === "connect";
  for (const [role, state] of roleStates) {
    const workerRunning = state.worker ? state.worker.isRunning() : true;
    const evaluated = evaluateRoleRuntimeHealth(state, { workerRunning, redisReady });
    await reportWorkerHealth(`worker:${role}`, evaluated.status, evaluated.details);
  }
}

async function start() {
  const now = new Date();
  const roleIntervals: Record<Role, number> = {
    ingestion: Math.min(interval("INGEST_INTERVAL_MS", 300_000), interval("BACKFILL_REQUEST_INTERVAL_MS", 60_000)),
    scanner: interval("SCAN_INTERVAL_MS", 60_000),
    paper: interval("PAPER_INTERVAL_MS", 60_000),
    notifications: interval("NOTIFICATION_INTERVAL_MS", 10_000),
    backtests: interval("BACKTEST_INTERVAL_MS", 30_000),
    monitor: interval("MONITOR_INTERVAL_MS", 60_000)
  };

  for (const role of roles) {
    roleStates.set(role, {
      role,
      startedAt: now.toISOString(),
      startedAtMs: now.getTime(),
      expectedIntervalMs: roleIntervals[role],
      consecutiveFailures: 0,
      activeJobs: 0
    });
  }

  const wrapProcessor = <T>(role: Role, fn: (job: { id?: string; name?: string }) => Promise<T>) => {
    return async (job: { id?: string; name?: string }): Promise<T> => {
      const state = roleStates.get(role)!;
      const started = Date.now();
      state.activeJobs += 1;
      state.lastJob = job.name ?? role;
      state.lastStartedAt = new Date(started).toISOString();
      try {
        const result = await fn(job);
        const completed = Date.now();
        state.lastCompletedAtMs = completed;
        state.lastCompletedAt = new Date(completed).toISOString();
        state.lastDurationMs = completed - started;
        state.consecutiveFailures = 0;
        state.lastError = undefined;
        return result;
      } catch (error) {
        state.consecutiveFailures += 1;
        state.lastError = errorText(error, `${role} job failed`);
        throw error;
      } finally {
        state.activeJobs = Math.max(0, state.activeJobs - 1);
      }
    };
  };

  const attachListeners = (role: Role, worker: Worker) => {
    const state = roleStates.get(role)!;
    state.worker = worker;
    worker.on("failed", (job, error) => {
      const safeMsg = errorText(error, `${role} job failed`);
      console.error(`${role} job failed`, job?.id, safeMsg);
      const evaluated = evaluateRoleRuntimeHealth(state, {
        workerRunning: worker.isRunning(),
        redisReady: connection.status === "ready"
      });
      void reportWorkerHealth(`worker:${role}`, "degraded", {
        ...evaluated.details,
        job: job?.name ?? role,
        error: safeMsg
      });
    });
    worker.on("completed", (job) => {
      const evaluated = evaluateRoleRuntimeHealth(state, {
        workerRunning: worker.isRunning(),
        redisReady: connection.status === "ready"
      });
      void reportWorkerHealth(`worker:${role}`, evaluated.status, {
        ...evaluated.details,
        lastJob: job.name
      });
    });
    worker.on("error", (error) => {
      console.error(`${role} worker error`, errorText(error));
    });
  };

  if (roles.includes("ingestion")) {
    const worker = new Worker(
      "market-ingestion",
      wrapProcessor("ingestion", async (job) => {
        if (job.name === "backfill") return backfillHistory();
        if (job.name === "backfill-requests") return processBackfillRequests();
        if (job.name === "ingest-forex") {
          const forexReport = await ingestForex();
          const forexErrors = forexReport.filter((item) => item.error);
          if (forexErrors.length) console.error("forex ingestion errors", JSON.stringify(forexErrors).slice(0, 4000));
          return { symbols: forexReport.length, inserted: forexReport.reduce((total, item) => total + item.inserted, 0), errors: forexErrors.length };
        }
        const report = await ingestCrypto();
        const errors = report.filter((item) => item.error);
        if (errors.length) console.error("ingestion errors", JSON.stringify(errors).slice(0, 4000));
        return { symbols: report.length, inserted: report.reduce((total, item) => total + item.inserted, 0), errors: errors.length };
      }),
      { connection, concurrency: 1 }
    );
    attachListeners("ingestion", worker);
    workers.push(worker);
    if (process.env.RUN_INITIAL_BACKFILL === "true") {
      const startValue = process.env.BACKFILL_START ?? "missing";
      const endValue = process.env.BACKFILL_END ?? "missing";
      await ingestionQueue.add("backfill", {}, { jobId: `historical-backfill-${startValue}-${endValue}`.replace(/[^a-zA-Z0-9_-]/g, "_"), removeOnComplete: 100, removeOnFail: 500 });
    }
    await ingestionQueue.add("ingest", {}, { jobId: "initial-market-ingestion", removeOnComplete: true, removeOnFail: 500 });
    await ingestionQueue.add("ingest", {}, { jobId: "repeat-crypto-ingestion", repeat: { every: interval("INGEST_INTERVAL_MS", 300_000) }, removeOnComplete: 100, removeOnFail: 500 });
    await ingestionQueue.add("ingest-forex", {}, { jobId: "initial-forex-ingestion", removeOnComplete: true, removeOnFail: 500 });
    await ingestionQueue.add("ingest-forex", {}, { jobId: "repeat-forex-ingestion", repeat: { every: interval("FOREX_INGEST_INTERVAL_MS", 300_000) }, removeOnComplete: 100, removeOnFail: 500 });
    await ingestionQueue.add("backfill-requests", {}, { jobId: "repeat-backfill-requests", repeat: { every: interval("BACKFILL_REQUEST_INTERVAL_MS", 60_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("scanner")) {
    const worker = new Worker("market-scan", wrapProcessor("scanner", async () => processScan()), { connection, concurrency: 1 });
    attachListeners("scanner", worker);
    workers.push(worker);
    await scanQueue.add("evaluate", {}, { jobId: "repeat-market-scan", repeat: { every: interval("SCAN_INTERVAL_MS", 60_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("paper")) {
    const worker = new Worker("paper-tracking", wrapProcessor("paper", async () => processPaperTrades()), { connection, concurrency: 1 });
    attachListeners("paper", worker);
    workers.push(worker);
    await paperQueue.add("paper", {}, { jobId: "repeat-paper-tracking", repeat: { every: interval("PAPER_INTERVAL_MS", 60_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("notifications")) {
    const worker = new Worker("notification-delivery", wrapProcessor("notifications", async () => deliverPending()), { connection, concurrency: 2 });
    attachListeners("notifications", worker);
    workers.push(worker);
    await notificationQueue.add("deliver", {}, { jobId: "repeat-notification-delivery", repeat: { every: interval("NOTIFICATION_INTERVAL_MS", 10_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("backtests")) {
    const worker = new Worker("backtests", wrapProcessor("backtests", async () => processBacktests()), { connection, concurrency: 1 });
    attachListeners("backtests", worker);
    workers.push(worker);
    await backtestQueue.add("backtests", {}, { jobId: "repeat-backtests", repeat: { every: interval("BACKTEST_INTERVAL_MS", 30_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("monitor")) {
    const worker = new Worker("monitoring", wrapProcessor("monitor", async () => runMonitoring()), { connection, concurrency: 1 });
    attachListeners("monitor", worker);
    workers.push(worker);
    await monitorQueue.add("monitor", {}, { jobId: "initial-monitoring", removeOnComplete: true, removeOnFail: 500 });
    await monitorQueue.add("monitor", {}, { jobId: "repeat-monitoring", repeat: { every: interval("MONITOR_INTERVAL_MS", 60_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  await emitHeartbeats();
  const heartbeatIntervalMs = interval("WORKER_HEARTBEAT_INTERVAL_MS", 30_000);
  const heartbeatTimer = setInterval(() => {
    void emitHeartbeats();
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  console.log(`Signal Engine workers started for role(s): ${roles.join(",")}. Strategy configs remain disabled by default.`);

  let shuttingDown = false;
  const shutdown = async (signalName: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    console.log(`Received ${signalName}; shutting down worker role(s): ${roles.join(",")}...`);
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await Promise.allSettled([
      ingestionQueue.close(),
      scanQueue.close(),
      paperQueue.close(),
      backtestQueue.close(),
      notificationQueue.close(),
      monitorQueue.close()
    ]);
    await Promise.allSettled([connection.quit(), sql.end({ timeout: 5 })]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isWorkerEntry = process.argv[1]?.endsWith("main.js") || process.argv[1]?.endsWith("main.ts");
if (isWorkerEntry) {
  void start().catch((error) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
