import { Worker } from "bullmq";
import { connection, ingestionQueue, scanQueue, paperQueue, backtestQueue, notificationQueue, monitorQueue } from "./queues.js";
import { ingestAll } from "./ingestion.js";
import { processScan } from "./scanner.js";
import { deliverPending } from "./telegram.js";
import { processPaperTrades } from "./paper-tracker.js";
import { processBacktests } from "./backtests.js";
import { reportWorkerHealth } from "./health.js";
import { backfillHistory, processBackfillRequests } from "./backfill.js";
import { runMonitoring } from "./monitoring.js";

type Role = "ingestion" | "scanner" | "paper" | "notifications" | "backtests" | "monitor";
const allRoles: Role[] = ["ingestion", "scanner", "paper", "notifications", "backtests", "monitor"];
const requested = (process.env.WORKER_ROLE ?? "all") as Role | "all";
const roles: Role[] = requested === "all" ? allRoles : allRoles.includes(requested) ? [requested] : [];
if (!roles.length) throw new Error(`Invalid WORKER_ROLE: ${requested}`);

const workers: Worker[] = [];
const interval = (name: string, fallback: number) => Number(process.env[name] ?? String(fallback));

async function start() {
  const health = (role: Role) => `worker:${role}`;
  const onFailed = (role: Role) => (job: { id?: string; name?: string } | undefined, error: Error) => {
    console.error(`${role} job failed`, job?.id, error);
    void reportWorkerHealth(health(role), "degraded", { queue: role, job: job?.name, error: error.message });
  };
  const onCompleted = (role: Role) => (job: { name?: string }) => {
    void reportWorkerHealth(health(role), "ok", { queue: role, lastJob: job.name, completedAt: new Date().toISOString() });
  };

  if (roles.includes("ingestion")) {
    const worker = new Worker(
      "market-ingestion",
      async (job) => {
        if (job.name === "backfill") return backfillHistory();
        if (job.name === "backfill-requests") return processBackfillRequests();
        return ingestAll();
      },
      { connection, concurrency: 1 }
    );
    worker.on("failed", onFailed("ingestion"));
    worker.on("completed", onCompleted("ingestion"));
    workers.push(worker);
    if (process.env.RUN_INITIAL_BACKFILL === "true") {
      const startValue = process.env.BACKFILL_START ?? "missing";
      const endValue = process.env.BACKFILL_END ?? "missing";
      await ingestionQueue.add("backfill", {}, { jobId: `historical-backfill-${startValue}-${endValue}`.replace(/[^a-zA-Z0-9_-]/g, "_"), removeOnComplete: 100, removeOnFail: 500 });
    }
    await ingestionQueue.add("ingest", {}, { jobId: "initial-market-ingestion", removeOnComplete: true, removeOnFail: 500 });
    await ingestionQueue.add("ingest", {}, { repeat: { every: interval("INGEST_INTERVAL_MS", 300_000) }, removeOnComplete: 100, removeOnFail: 500 });
    await ingestionQueue.add("backfill-requests", {}, { repeat: { every: interval("BACKFILL_REQUEST_INTERVAL_MS", 60_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("scanner")) {
    const worker = new Worker("market-scan", async () => processScan(), { connection, concurrency: 1 });
    worker.on("failed", onFailed("scanner"));
    worker.on("completed", onCompleted("scanner"));
    workers.push(worker);
    await scanQueue.add("evaluate", {}, { repeat: { every: interval("SCAN_INTERVAL_MS", 60_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("paper")) {
    const worker = new Worker("paper-tracking", async () => processPaperTrades(), { connection, concurrency: 1 });
    worker.on("failed", onFailed("paper"));
    worker.on("completed", onCompleted("paper"));
    workers.push(worker);
    await paperQueue.add("paper", {}, { repeat: { every: interval("PAPER_INTERVAL_MS", 60_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("notifications")) {
    const worker = new Worker("notification-delivery", async () => deliverPending(), { connection, concurrency: 2 });
    worker.on("failed", onFailed("notifications"));
    worker.on("completed", onCompleted("notifications"));
    workers.push(worker);
    await notificationQueue.add("deliver", {}, { repeat: { every: interval("NOTIFICATION_INTERVAL_MS", 10_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("backtests")) {
    const worker = new Worker("backtests", async () => processBacktests(), { connection, concurrency: 1 });
    worker.on("failed", onFailed("backtests"));
    worker.on("completed", onCompleted("backtests"));
    workers.push(worker);
    await backtestQueue.add("backtests", {}, { repeat: { every: interval("BACKTEST_INTERVAL_MS", 30_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  if (roles.includes("monitor")) {
    const worker = new Worker("monitoring", async () => runMonitoring(), { connection, concurrency: 1 });
    worker.on("failed", onFailed("monitor"));
    worker.on("completed", onCompleted("monitor"));
    workers.push(worker);
    await monitorQueue.add("monitor", {}, { repeat: { every: interval("MONITOR_INTERVAL_MS", 60_000) }, removeOnComplete: 100, removeOnFail: 500 });
  }

  await Promise.all(roles.map((role) => reportWorkerHealth(health(role), "ok", { startedAt: new Date().toISOString(), pid: process.pid })));
  console.log(`Signal Engine workers started for role(s): ${roles.join(",")}. Strategy configs remain disabled by default.`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all([ingestionQueue.close(), scanQueue.close(), paperQueue.close(), backtestQueue.close(), notificationQueue.close(), monitorQueue.close()]);
    await connection.quit();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void start().catch((error) => {
  console.error(error);
  process.exit(1);
});
