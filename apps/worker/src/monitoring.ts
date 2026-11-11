import os from "node:os";
import { statfs } from "node:fs/promises";
import { sql } from "@signal-engine/database";
import { isCandleStale, type CandleInterval } from "@signal-engine/market-data";
import {
  applyRetention,
  backfillSummary,
  candleFreshness,
  listHealth,
  notificationBacklog,
  recordHealth,
  resolveStaleAlerts,
  upsertAlert
} from "@signal-engine/database/system-repository";
import { enqueueNotification } from "@signal-engine/database/scanner-repository";
import { connection } from "./queues.js";

const TIMEFRAMES: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const STALE_TOLERANCE: Record<CandleInterval, number> = { "1m": 5, "5m": 4, "15m": 4, "1h": 3, "4h": 3, "1d": 3 };

type AlertInput = { component: string; severity?: "info" | "warning" | "critical"; dedupeKey: string; message: string };

const alertState = new Map<string, string>();

async function emitAlert(input: AlertInput) {
  try {
    const { isNew, alert } = await upsertAlert(input);
    alertState.set(input.dedupeKey, alert.id);
    if (!isNew) return;
    const cycle = alert.firstSeenAt.getTime();
    await enqueueNotification({
      eventType: "SYSTEM_ALERT",
      eventKey: `alert:${input.dedupeKey}:${cycle}:opened`,
      message: `<b>Signal Engine alert</b>\nComponent: ${escape(input.component)}\nSeverity: ${escape(input.severity ?? "warning")}\n${escape(input.message)}`
    });
  } catch (error) {
    console.error("Unable to persist alert", input.dedupeKey, error instanceof Error ? error.message : error);
  }
}

async function resolveComponentAlerts(component: string, activeKeys: string[]) {
  const resolved = await resolveStaleAlerts(component, activeKeys);
  for (const alert of resolved) {
    try {
      await enqueueNotification({
        eventType: "SYSTEM_RECOVERY",
        eventKey: `alert:${alert.dedupeKey}:${alert.firstSeenAt.getTime()}:resolved`,
        message: `<b>Signal Engine recovery</b>\nComponent: ${escape(alert.component)}\n${escape(alert.message)} has recovered.`
      });
    } catch (error) {
      console.error("Unable to persist recovery notification", alert.dedupeKey, error instanceof Error ? error.message : error);
    }
  }
  return resolved.length;
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function checkDatabase() {
  try {
    const started = Date.now();
    await sql`select 1`;
    await recordHealth("database", "ok", { latencyMs: Date.now() - started });
    await resolveComponentAlerts("database", []);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database check failed";
    await recordHealth("database", "error", { error: message });
    await emitAlert({ component: "database", severity: "critical", dedupeKey: "database:unavailable", message });
    return false;
  }
}

async function checkRedis() {
  try {
    const started = Date.now();
    const pong = await connection.ping();
    await recordHealth("redis", "ok", { latencyMs: Date.now() - started, pong });
    await resolveComponentAlerts("redis", []);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Redis check failed";
    await recordHealth("redis", "error", { error: message });
    await emitAlert({ component: "redis", severity: "critical", dedupeKey: "redis:unavailable", message });
    return false;
  }
}

async function checkBinance() {
  const baseUrl = process.env.BINANCE_BASE_URL ?? "https://fapi.binance.com";
  try {
    const started = Date.now();
    const response = await fetch(new URL("/fapi/v1/ping", baseUrl), { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Binance ping HTTP ${response.status}`);
    await recordHealth("provider:binance_usdm", "ok", { latencyMs: Date.now() - started });
    await resolveComponentAlerts("provider:binance_usdm", []);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Binance provider check failed";
    await recordHealth("provider:binance_usdm", "error", { error: message });
    await emitAlert({ component: "provider:binance_usdm", severity: "critical", dedupeKey: "provider:binance:unavailable", message });
  }
}

async function checkOanda() {
  const token = process.env.OANDA_API_TOKEN;
  if (!token) {
    await recordHealth("provider:oanda_v20", "degraded", { configured: false, reason: "OANDA_API_TOKEN not set" });
    await resolveComponentAlerts("provider:oanda_v20", []);
    return;
  }
  const baseUrl = process.env.OANDA_BASE_URL ?? "https://api-fxpractice.oanda.com";
  try {
    const started = Date.now();
    const response = await fetch(new URL("/v3/instruments/EUR_USD", baseUrl), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`OANDA check HTTP ${response.status}`);
    await recordHealth("provider:oanda_v20", "ok", { latencyMs: Date.now() - started });
    await resolveComponentAlerts("provider:oanda_v20", []);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OANDA provider check failed";
    await recordHealth("provider:oanda_v20", "error", { error: message });
    await emitAlert({ component: "provider:oanda_v20", severity: "critical", dedupeKey: "provider:oanda:unavailable", message });
  }
}

async function checkCandleFreshness(now: Date) {
  let rows: Awaited<ReturnType<typeof candleFreshness>>;
  try {
    rows = await candleFreshness();
  } catch (error) {
    console.error("Unable to read candle freshness", error instanceof Error ? error.message : error);
    return;
  }
  const bySymbol = new Map<string, { provider: string; symbol: string; market: string; stale: string[]; missing: string[]; latest: Record<string, string | null> }>();
  for (const row of rows) {
    const key = `${row.provider}:${row.symbol}`;
    const entry = bySymbol.get(key) ?? { provider: row.provider, symbol: row.symbol, market: row.market, stale: [], missing: [], latest: {} };
    entry.latest[row.timeframe] = row.latest ? new Date(row.latest).toISOString() : null;
    if (!row.latest) {
      entry.missing.push(row.timeframe);
    } else if (isCandleStale(new Date(row.latest), row.timeframe as CandleInterval, row.market as "crypto_perpetual" | "forex", now, STALE_TOLERANCE[row.timeframe as CandleInterval])) {
      entry.stale.push(row.timeframe);
    }
    bySymbol.set(key, entry);
  }
  let staleSymbols = 0;
  for (const [key, entry] of bySymbol) {
    const component = `candles:${key}`;
    const problem = entry.stale.length > 0 || entry.missing.length > 0;
    if (!problem) {
      await recordHealth(component, "ok", { latest: entry.latest, timeframes: TIMEFRAMES });
      await resolveComponentAlerts(component, []);
      continue;
    }
    staleSymbols += 1;
    const status = entry.stale.length > 0 ? "error" : "degraded";
    await recordHealth(component, status, { latest: entry.latest, stale: entry.stale, missing: entry.missing, timeframes: TIMEFRAMES });
    const activeKeys: string[] = [];
    if (entry.stale.length) {
      const dedupeKey = `candles:${key}:stale`;
      activeKeys.push(dedupeKey);
      await emitAlert({ component, severity: "warning", dedupeKey, message: `${entry.symbol} stale candles on ${entry.stale.join(", ")}` });
    }
    if (entry.missing.length) {
      const dedupeKey = `candles:${key}:missing`;
      activeKeys.push(dedupeKey);
      await emitAlert({ component, severity: "warning", dedupeKey, message: `${entry.symbol} has no stored candles for ${entry.missing.join(", ")}` });
    }
    await resolveComponentAlerts(component, activeKeys);
  }
  await recordHealth("candles", staleSymbols ? "degraded" : "ok", { symbols: bySymbol.size, staleSymbols });
}

async function checkHost() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = ((total - free) / total) * 100;
  const cpus = os.cpus().length || 1;
  const load = os.loadavg()[0] ?? 0;
  const loadPct = (load / cpus) * 100;
  let diskUsedPct: number | null = null;
  let diskFreeGb: number | null = null;
  try {
    const stats = await statfs("/");
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    diskUsedPct = totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : null;
    diskFreeGb = freeBytes / 1024 ** 3;
  } catch (error) {
    console.error("Unable to read disk usage", error instanceof Error ? error.message : error);
  }
  await recordHealth("host:memory", usedPct > 90 ? "error" : usedPct > 80 ? "degraded" : "ok", {
    totalMb: Math.round(total / 1024 ** 2),
    freeMb: Math.round(free / 1024 ** 2),
    usedPct: Number(usedPct.toFixed(2))
  });
  await recordHealth("host:cpu", loadPct > 95 ? "error" : loadPct > 80 ? "degraded" : "ok", {
    cores: cpus,
    load1: Number(load.toFixed(2)),
    loadPct: Number(loadPct.toFixed(2))
  });
  if (diskUsedPct !== null) {
    await recordHealth("host:disk", diskUsedPct > 92 ? "error" : diskUsedPct > 85 ? "degraded" : "ok", {
      usedPct: Number(diskUsedPct.toFixed(2)),
      freeGb: Number((diskFreeGb ?? 0).toFixed(2))
    });
  }
  if (usedPct > 90) {
    await emitAlert({ component: "host:memory", severity: "critical", dedupeKey: "host:memory:high", message: `Memory usage is ${usedPct.toFixed(1)}%` });
  } else {
    await resolveComponentAlerts("host:memory", []);
  }
  if (loadPct > 95) {
    await emitAlert({ component: "host:cpu", severity: "warning", dedupeKey: "host:cpu:high", message: `CPU load is ${loadPct.toFixed(1)}%` });
  } else {
    await resolveComponentAlerts("host:cpu", []);
  }
  if (diskUsedPct !== null && diskUsedPct > 90) {
    await emitAlert({ component: "host:disk", severity: "critical", dedupeKey: "host:disk:high", message: `Disk usage is ${diskUsedPct.toFixed(1)}%` });
  } else {
    await resolveComponentAlerts("host:disk", []);
  }
}

async function checkWorkerHeartbeats() {
  const rows = await listHealth();
  const now = Date.now();
  const heartbeatRows = rows.filter((row) => row.component.startsWith("worker:"));
  const stale: string[] = [];
  for (const row of heartbeatRows) {
    const age = now - row.checkedAt.getTime();
    if (age > 10 * 60_000) stale.push(row.component);
  }
  await recordHealth("worker-heartbeats", stale.length ? "degraded" : "ok", {
    workers: heartbeatRows.map((row) => ({ component: row.component, status: row.status, ageSeconds: Math.round((now - row.checkedAt.getTime()) / 1000) })),
    stale
  });
  for (const component of stale) {
    await emitAlert({ component: "worker-heartbeats", severity: "warning", dedupeKey: `${component}:stale`, message: `${component} heartbeat is stale` });
  }
  await resolveComponentAlerts("worker-heartbeats", stale.map((component) => `${component}:stale`));
}

async function checkScanner() {
  const rows = await listHealth();
  const scanner = rows.find((row) => row.component === "worker:scanner");
  if (!scanner) {
    await recordHealth("scanner", "degraded", { reason: "scanner has not reported health yet" });
    return;
  }
  const details = scanner.details as { lastCompletedAt?: string; completedAt?: string };
  const completedAt = details.lastCompletedAt ?? details.completedAt;
  const last = completedAt ? Date.parse(completedAt) : NaN;
  const ageMs = Number.isFinite(last) ? Date.now() - last : Number.POSITIVE_INFINITY;
  const status = ageMs > 10 * 60_000 ? "degraded" : "ok";
  await recordHealth("scanner", status, { lastCompletedAt: completedAt ?? null, ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null });
  if (status !== "ok") {
    await emitAlert({ component: "scanner", severity: "warning", dedupeKey: "scanner:stale", message: "Scanner has not completed a run recently" });
  } else {
    await resolveComponentAlerts("scanner", []);
  }
}

async function checkNotifications() {
  const backlog = await notificationBacklog();
  const failed = Number(backlog.failed ?? 0);
  const pending = Number(backlog.pending ?? 0) + Number(backlog.sending ?? 0);
  await recordHealth("notifications", failed > 0 ? "degraded" : "ok", { ...backlog, pending, failed });
  if (failed > 0) {
    await emitAlert({ component: "notifications", severity: "warning", dedupeKey: "notifications:failed", message: `${failed} Telegram notifications failed permanently` });
  } else {
    await resolveComponentAlerts("notifications", []);
  }
}

async function checkBackfill() {
  const summary = await backfillSummary(10);
  const failed = Number(summary.counts.failed ?? 0);
  const running = Number(summary.counts.running ?? 0) + Number(summary.counts.requested ?? 0) + Number(summary.counts.pending ?? 0);
  await recordHealth("backfill", failed > 0 ? "degraded" : "ok", { counts: summary.counts, running, failed, recent: summary.data.slice(0, 10) });
  if (failed > 0) {
    await emitAlert({ component: "backfill", severity: "warning", dedupeKey: "backfill:failed", message: `${failed} backfill jobs are failed` });
  } else {
    await resolveComponentAlerts("backfill", []);
  }
}

let lastRetention = 0;
async function maybeRetention() {
  if (Date.now() - lastRetention < 60 * 60_000) return;
  lastRetention = Date.now();
  try {
    const result = await applyRetention({
      deliveredNotificationDays: Number(process.env.RETENTION_NOTIFICATION_DAYS ?? "14"),
      resolvedAlertDays: Number(process.env.RETENTION_ALERT_DAYS ?? "30")
    });
    await recordHealth("retention", "ok", { ...result, runAt: new Date().toISOString() });
  } catch (error) {
    console.error("Retention failed", error instanceof Error ? error.message : error);
  }
}

export async function runMonitoring() {
  const started = Date.now();
  const now = new Date();
  await recordHealth("worker:monitor", "ok", { heartbeatAt: now.toISOString(), pid: process.pid });
  await checkDatabase();
  await checkRedis();
  await checkBinance();
  await checkOanda();
  await checkCandleFreshness(now);
  await checkHost();
  await checkWorkerHeartbeats();
  await checkScanner();
  await checkNotifications();
  await checkBackfill();
  await maybeRetention();
  const durationMs = Date.now() - started;
  await recordHealth("monitor", "ok", { durationMs, completedAt: new Date().toISOString() });
  return { durationMs };
}
