import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { sql } from "@signal-engine/database";
import { isCandleStale, isForexMarketClosed, TwelveDataProvider, type CandleInterval } from "@signal-engine/market-data";
import {
  applyRetention,
  backfillSummary,
  backtestOperationalSummary,
  candleFreshness,
  databaseVolumeSummary,
  listHealth,
  notificationBacklog,
  recordHealth,
  resolveStaleAlerts,
  upsertAlert
} from "@signal-engine/database/system-repository";
import { enqueueNotification } from "@signal-engine/database/scanner-repository";
import { backtestQueue, connection, ingestionQueue, monitorQueue, notificationQueue, paperQueue, scanQueue } from "./queues.js";
import { errorText } from "./format.js";

const TIMEFRAMES: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const STALE_TOLERANCE: Record<CandleInterval, number> = { "1m": 5, "5m": 4, "15m": 4, "1h": 3, "4h": 3, "1d": 3 };
const FOREX_BEST_EFFORT_TIMEFRAMES = new Set<CandleInterval>(["1m", "5m"]);
const SCAN_PAIRS = [
  { timeframe: "1m", confirmationTimeframe: "5m", maxEntryAgeMs: 3 * 60_000, maxTrendAgeMs: 15 * 60_000 },
  { timeframe: "5m", confirmationTimeframe: "15m", maxEntryAgeMs: 15 * 60_000, maxTrendAgeMs: 45 * 60_000 },
  { timeframe: "15m", confirmationTimeframe: "1h", maxEntryAgeMs: 45 * 60_000, maxTrendAgeMs: 3 * 60 * 60_000 },
  { timeframe: "1h", confirmationTimeframe: "4h", maxEntryAgeMs: 3 * 60 * 60_000, maxTrendAgeMs: 12 * 60 * 60_000 },
  { timeframe: "4h", confirmationTimeframe: "1d", maxEntryAgeMs: 12 * 60 * 60_000, maxTrendAgeMs: 36 * 60 * 60_000 }
] as const;

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
    const latencyMs = Date.now() - started;
    let volume: Awaited<ReturnType<typeof databaseVolumeSummary>> | undefined;
    try {
      volume = await databaseVolumeSummary();
    } catch {
      volume = undefined;
    }
    await recordHealth("database", "ok", { latencyMs, ...(volume ? { volume } : {}) });
    await resolveComponentAlerts("database", []);
    return true;
  } catch (error) {
    const message = errorText(error, "Database check failed");
    await recordHealth("database", "error", { error: message, state: "provider_outage" });
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
    const message = errorText(error, "Redis check failed");
    await recordHealth("redis", "error", { error: message });
    await emitAlert({ component: "redis", severity: "critical", dedupeKey: "redis:unavailable", message });
    return false;
  }
}

async function checkResearchService() {
  const baseUrl = process.env.RESEARCH_SERVICE_URL ?? "http://localhost:8000";
  try {
    const started = Date.now();
    const response = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Research health HTTP ${response.status}`);
    await recordHealth("research", "ok", { latencyMs: Date.now() - started });
    await resolveComponentAlerts("research", []);
  } catch (error) {
    const message = errorText(error, "Research service check failed");
    await recordHealth("research", "error", { error: message });
    await emitAlert({ component: "research", severity: "critical", dedupeKey: "research:unavailable", message });
  }
}

async function checkBinance() {
  const baseUrl = process.env.BINANCE_BASE_URL ?? "https://fapi.binance.com";
  try {
    const started = Date.now();
    const response = await fetch(new URL("/fapi/v1/ping", baseUrl), { signal: AbortSignal.timeout(8000) });
    if (response.status === 429 || response.status === 418) {
      const msg = `Binance rate limit HTTP ${response.status}`;
      await recordHealth("provider:binance_usdm", "degraded", { state: "rate_limit", error: msg });
      await emitAlert({ component: "provider:binance_usdm", severity: "warning", dedupeKey: "provider:binance:rate_limit", message: msg });
      await resolveComponentAlerts("provider:binance_usdm", ["provider:binance:rate_limit"]);
      return;
    }
    if (!response.ok) throw new Error(`Binance ping HTTP ${response.status}`);
    await recordHealth("provider:binance_usdm", "ok", { state: "healthy", latencyMs: Date.now() - started });
    await resolveComponentAlerts("provider:binance_usdm", []);
  } catch (error) {
    const message = errorText(error, "Binance provider check failed");
    await recordHealth("provider:binance_usdm", "error", { state: "provider_outage", error: message });
    await emitAlert({ component: "provider:binance_usdm", severity: "critical", dedupeKey: "provider:binance:unavailable", message });
    await resolveComponentAlerts("provider:binance_usdm", ["provider:binance:unavailable"]);
  }
}

export function twelveDataQuotaState(usage: { dailyUsage: number | null; planDailyLimit: number | null; planLimit: number | null; planCategory: string | null }) {
  const safety = Number(process.env.FOREX_CREDIT_SAFETY_MARGIN ?? "80");
  const selfBudget = Number(process.env.FOREX_DAILY_CREDIT_BUDGET ?? "640");
  const planCap = (usage.planDailyLimit ?? Number.POSITIVE_INFINITY) - safety;
  const effectiveDailyBudget = Math.min(selfBudget, planCap);
  const remaining = effectiveDailyBudget - (usage.dailyUsage ?? 0);
  return { safetyMargin: safety, selfBudget, effectiveDailyBudget, remaining };
}

async function checkTwelveData() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    await recordHealth("provider:twelve_data", "degraded", { configured: false, state: "unconfigured", reason: "TWELVE_DATA_API_KEY not set" });
    await resolveComponentAlerts("provider:twelve_data", []);
    return;
  }
  try {
    const started = Date.now();
    const usage = await new TwelveDataProvider({ apiKey }).getApiUsage();
    const quota = twelveDataQuotaState(usage);
    const exhausted = quota.remaining <= 0;
    const status = exhausted ? "degraded" : "ok";
    await recordHealth("provider:twelve_data", status, {
      state: exhausted ? "daily_credit_exhaustion" : "healthy",
      latencyMs: Date.now() - started,
      planCategory: usage.planCategory,
      planLimitPerMinute: usage.planLimit,
      dailyUsage: usage.dailyUsage,
      planDailyLimit: usage.planDailyLimit,
      ...quota,
      note: exhausted ? "daily credit budget/safety margin reached; ingestion paused until quota resets" : "provider reachable"
    });
    if (exhausted) {
      await emitAlert({
        component: "provider:twelve_data",
        severity: "warning",
        dedupeKey: "provider:twelve_data:daily_credit_exhaustion",
        message: `Twelve Data daily credit budget reached (remaining: ${quota.remaining})`
      });
      await resolveComponentAlerts("provider:twelve_data", ["provider:twelve_data:daily_credit_exhaustion"]);
    } else {
      await resolveComponentAlerts("provider:twelve_data", []);
    }
  } catch (error) {
    const message = errorText(error, "Twelve Data provider check failed");
    const rateLimited = /429|per-minute|rate limit/i.test(message);
    const quotaExhausted = !rateLimited && /quota|daily|credits/i.test(message);
    const state = rateLimited ? "rate_limit" : quotaExhausted ? "daily_credit_exhaustion" : "provider_outage";
    const status = rateLimited || quotaExhausted ? "degraded" : "error";
    await recordHealth("provider:twelve_data", status, { state, error: message, quotaRelated: rateLimited || quotaExhausted });
    const dedupeKey = `provider:twelve_data:${state}`;
    await emitAlert({
      component: "provider:twelve_data",
      severity: status === "error" ? "critical" : "warning",
      dedupeKey,
      message
    });
    await resolveComponentAlerts("provider:twelve_data", [dedupeKey]);
  }
}

const ACTIVE_PROVIDER_COMPONENTS = new Set(["provider:binance_usdm", "provider:twelve_data"]);

async function retireStaleProviders() {
  for (const row of await listHealth()) {
    if (row.component.startsWith("provider:") && !ACTIVE_PROVIDER_COMPONENTS.has(row.component)) {
      await recordHealth(row.component, "ok", { retired: true, reason: "provider removed" });
      await resolveComponentAlerts(row.component, []);
    }
  }
}

export function evaluateScannerEligibility(
  rows: Array<{ provider: string; symbol: string; market: string; timeframe: string; latest: Date | null; candles: number }>,
  now: Date
) {
  const bySymbolTf = new Map<string, { latest: Date | null; candles: number; market: string; provider: string; symbol: string }>();
  const symbols = new Set<string>();
  for (const row of rows) {
    const symKey = `${row.provider}:${row.symbol}`;
    symbols.add(symKey);
    bySymbolTf.set(`${symKey}:${row.timeframe}`, {
      latest: row.latest ? new Date(row.latest) : null,
      candles: Number(row.candles ?? 0),
      market: row.market,
      provider: row.provider,
      symbol: row.symbol
    });
  }
  const eligiblePairs: string[] = [];
  const blockedByReason = {
    market_closed: 0,
    insufficient_history: 0,
    stale_entry_candle: 0,
    stale_trend_candle: 0
  };
  const nowMs = now.getTime();
  const forexClosed = isForexMarketClosed(now);

  for (const symKey of symbols) {
    for (const plan of SCAN_PAIRS) {
      const entry = bySymbolTf.get(`${symKey}:${plan.timeframe}`);
      const trend = bySymbolTf.get(`${symKey}:${plan.confirmationTimeframe}`);
      const pairLabel = `${symKey}:${plan.timeframe}/${plan.confirmationTimeframe}`;
      if (!entry || !trend || entry.candles < 60 || trend.candles < 60 || !entry.latest || !trend.latest) {
        blockedByReason.insufficient_history += 1;
        continue;
      }
      if (entry.market === "forex" && forexClosed) {
        blockedByReason.market_closed += 1;
        continue;
      }
      if (nowMs - entry.latest.getTime() > plan.maxEntryAgeMs) {
        blockedByReason.stale_entry_candle += 1;
        continue;
      }
      if (nowMs - trend.latest.getTime() > plan.maxTrendAgeMs) {
        blockedByReason.stale_trend_candle += 1;
        continue;
      }
      eligiblePairs.push(pairLabel);
    }
  }

  return {
    totalPairs: symbols.size * SCAN_PAIRS.length,
    eligibleCount: eligiblePairs.length,
    eligiblePairs,
    blockedByReason,
    forexMarketClosed: forexClosed
  };
}

async function checkCandleFreshness(now: Date) {
  let rows: Awaited<ReturnType<typeof candleFreshness>>;
  try {
    rows = await candleFreshness();
  } catch (error) {
    console.error("Unable to read candle freshness", error instanceof Error ? error.message : error);
    return undefined;
  }
  const bySymbol = new Map<
    string,
    {
      provider: string;
      symbol: string;
      market: string;
      stale: string[];
      bestEffortStale: string[];
      missing: string[];
      latest: Record<string, string | null>;
    }
  >();
  const twelveConfigured = Boolean(process.env.TWELVE_DATA_API_KEY);
  const forexClosed = isForexMarketClosed(now);

  for (const row of rows) {
    if (row.provider === "twelve_data" && !twelveConfigured) {
      await resolveComponentAlerts(`candles:${row.provider}:${row.symbol}`, []);
      continue;
    }
    const key = `${row.provider}:${row.symbol}`;
    const entry = bySymbol.get(key) ?? {
      provider: row.provider,
      symbol: row.symbol,
      market: row.market,
      stale: [],
      bestEffortStale: [],
      missing: [],
      latest: {}
    };
    entry.latest[row.timeframe] = row.latest ? new Date(row.latest).toISOString() : null;
    const tf = row.timeframe as CandleInterval;
    if (!row.latest) {
      entry.missing.push(row.timeframe);
    } else if (isCandleStale(new Date(row.latest), tf, row.market as "crypto_perpetual" | "forex", now, STALE_TOLERANCE[tf])) {
      if (row.market === "forex" && FOREX_BEST_EFFORT_TIMEFRAMES.has(tf)) {
        entry.bestEffortStale.push(row.timeframe);
      } else {
        entry.stale.push(row.timeframe);
      }
    }
    bySymbol.set(key, entry);
  }
  let staleSymbols = 0;
  for (const [key, entry] of bySymbol) {
    const component = `candles:${key}`;
    const marketClosed = entry.market === "forex" && forexClosed;
    const problem = entry.stale.length > 0 || entry.missing.length > 0;
    if (!problem) {
      await recordHealth(component, "ok", {
        state: marketClosed ? "market_closed" : entry.bestEffortStale.length ? "best_effort_low_tf" : "fresh",
        marketClosed,
        bestEffortStale: entry.bestEffortStale,
        latest: entry.latest,
        timeframes: TIMEFRAMES
      });
      await resolveComponentAlerts(component, []);
      continue;
    }
    staleSymbols += 1;
    const status = entry.stale.length > 0 ? "error" : "degraded";
    await recordHealth(component, status, {
      state: entry.stale.length > 0 ? "stale_candles" : "missing_historical_data",
      marketClosed,
      latest: entry.latest,
      stale: entry.stale,
      bestEffortStale: entry.bestEffortStale,
      missing: entry.missing,
      timeframes: TIMEFRAMES
    });
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
  const current = new Set([...bySymbol.keys()].map((key) => `candles:${key}`));
  for (const row of await listHealth()) {
    if (row.component.startsWith("candles:") && !current.has(row.component)) {
      await recordHealth(row.component, "ok", { retired: true, reason: "instrument disabled or provider not configured" });
      await resolveComponentAlerts(row.component, []);
    }
  }
  await recordHealth("candles", staleSymbols ? "degraded" : "ok", {
    symbols: bySymbol.size,
    staleSymbols,
    forexMarketClosed: forexClosed
  });
  return evaluateScannerEligibility(rows, now);
}

async function readSwapUsage(): Promise<{ totalMb: number; usedMb: number; usedPct: number } | null> {
  try {
    const content = await readFile("/proc/meminfo", "utf8");
    const totalMatch = content.match(/^SwapTotal:\s+(\d+)\s+kB/m);
    const freeMatch = content.match(/^SwapFree:\s+(\d+)\s+kB/m);
    if (!totalMatch || !freeMatch) return null;
    const totalKb = Number(totalMatch[1]);
    const freeKb = Number(freeMatch[1]);
    if (!Number.isFinite(totalKb) || totalKb <= 0) return { totalMb: 0, usedMb: 0, usedPct: 0 };
    const usedKb = Math.max(0, totalKb - freeKb);
    return {
      totalMb: Math.round(totalKb / 1024),
      usedMb: Math.round(usedKb / 1024),
      usedPct: Number(((usedKb / totalKb) * 100).toFixed(2))
    };
  } catch {
    return null;
  }
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
  const swap = await readSwapUsage();

  await recordHealth("host:memory", usedPct > 90 ? "error" : usedPct > 80 ? "degraded" : "ok", {
    totalMb: Math.round(total / 1024 ** 2),
    freeMb: Math.round(free / 1024 ** 2),
    usedPct: Number(usedPct.toFixed(2)),
    ...(swap ? { swap } : {})
  });
  await recordHealth("host:cpu", loadPct > 95 ? "error" : loadPct > 80 ? "degraded" : "ok", {
    state: loadPct > 80 ? "host_cpu_pressure" : "normal",
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

const EXPECTED_WORKERS = [
  "worker:ingestion",
  "worker:scanner",
  "worker:paper",
  "worker:notifications",
  "worker:backtests",
  "worker:monitor"
];

async function checkWorkerHeartbeats() {
  const rows = await listHealth();
  const now = Date.now();
  const heartbeatRows = rows.filter((row) => row.component.startsWith("worker:"));
  const byName = new Map(heartbeatRows.map((row) => [row.component, row]));
  const stale: string[] = [];
  const failed: string[] = [];

  for (const expected of EXPECTED_WORKERS) {
    const row = byName.get(expected);
    if (!row) {
      stale.push(expected);
      continue;
    }
    const age = now - row.checkedAt.getTime();
    const details = (row.details ?? {}) as { stalled?: boolean };
    if (age > 5 * 60_000 || details.stalled === true) stale.push(expected);
    if (row.status === "error") failed.push(expected);
  }

  const status = failed.length > 0 ? "error" : stale.length > 0 ? "degraded" : "ok";
  await recordHealth("worker-heartbeats", status, {
    state: failed.length || stale.length ? "worker_failure" : "healthy",
    workers: heartbeatRows.map((row) => ({
      component: row.component,
      status: row.status,
      ageSeconds: Math.round((now - row.checkedAt.getTime()) / 1000)
    })),
    stale,
    failed
  });
  const activeKeys: string[] = [];
  for (const component of stale) {
    const key = `${component}:stale`;
    activeKeys.push(key);
    await emitAlert({ component: "worker-heartbeats", severity: "warning", dedupeKey: key, message: `${component} heartbeat or processing is stale` });
  }
  for (const component of failed) {
    const key = `${component}:error`;
    activeKeys.push(key);
    await emitAlert({ component: "worker-heartbeats", severity: "critical", dedupeKey: key, message: `${component} reported error state` });
  }
  await resolveComponentAlerts("worker-heartbeats", activeKeys);
}

async function checkScanner(eligibility?: ReturnType<typeof evaluateScannerEligibility>) {
  const rows = await listHealth();
  const scanner = rows.find((row) => row.component === "worker:scanner");
  if (!scanner) {
    await recordHealth("scanner", "degraded", {
      reason: "scanner has not reported health yet",
      ...(eligibility ? { eligibility } : {})
    });
    return;
  }
  const details = scanner.details as { lastCompletedAt?: string; completedAt?: string };
  const completedAt = details.lastCompletedAt ?? details.completedAt;
  const last = completedAt ? Date.parse(completedAt) : NaN;
  const ageMs = Number.isFinite(last) ? Date.now() - last : Number.POSITIVE_INFINITY;
  const status = ageMs > 10 * 60_000 ? "degraded" : "ok";
  await recordHealth("scanner", status, {
    lastCompletedAt: completedAt ?? null,
    ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
    ...(eligibility ? { eligibility } : {})
  });
  if (status !== "ok") {
    await emitAlert({ component: "scanner", severity: "warning", dedupeKey: "scanner:stale", message: "Scanner has not completed a run recently" });
  } else {
    await resolveComponentAlerts("scanner", []);
  }
}

async function checkQueuesAndBacktests() {
  try {
    const queueList = [
      ["ingestion", ingestionQueue],
      ["scanner", scanQueue],
      ["paper", paperQueue],
      ["notifications", notificationQueue],
      ["backtests", backtestQueue],
      ["monitor", monitorQueue]
    ] as const;
    const bullmqQueues: Record<string, { waiting: number; active: number; delayed: number; failed: number }> = {};
    let totalFailedJobs = 0;
    for (const [name, q] of queueList) {
      const counts = await q.getJobCounts("waiting", "active", "delayed", "failed");
      bullmqQueues[name] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0
      };
      totalFailedJobs += counts.failed ?? 0;
    }
    const backtests = await backtestOperationalSummary();
    const hasStaleLeases = backtests.staleRunning > 0;
    const status = hasStaleLeases ? "degraded" : "ok";
    await recordHealth("queues", status, {
      bullmq: bullmqQueues,
      totalFailedQueueJobs: totalFailedJobs,
      backtests
    });
    const activeKeys: string[] = [];
    if (hasStaleLeases) {
      activeKeys.push("queues:backtests:stale_lease");
      await emitAlert({
        component: "queues",
        severity: "warning",
        dedupeKey: "queues:backtests:stale_lease",
        message: `${backtests.staleRunning} backtest job(s) have exceeded their 15-minute execution lease`
      });
    }
    await resolveComponentAlerts("queues", activeKeys);
  } catch (error) {
    console.error("Unable to inspect queue and backtest metrics", errorText(error));
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
let lastRetentionDetails: Record<string, unknown> = {};
async function maybeRetention() {
  if (Date.now() - lastRetention >= 60 * 60_000) {
    lastRetention = Date.now();
    try {
      const result = await applyRetention({
        deliveredNotificationDays: Number(process.env.RETENTION_NOTIFICATION_DAYS ?? "14"),
        resolvedAlertDays: Number(process.env.RETENTION_ALERT_DAYS ?? "30")
      });
      lastRetentionDetails = { ...result, lastRunAt: new Date(lastRetention).toISOString() };
    } catch (error) {
      console.error("Retention failed", error instanceof Error ? error.message : error);
      lastRetentionDetails = { error: errorText(error, "Retention failed"), lastRunAt: new Date(lastRetention).toISOString() };
    }
  }
  await recordHealth("retention", lastRetentionDetails.error ? "degraded" : "ok", {
    ...lastRetentionDetails,
    nextRunAt: new Date(lastRetention + 60 * 60_000).toISOString()
  });
}

export async function runMonitoring() {
  const started = Date.now();
  const now = new Date();
  await recordHealth("worker:monitor", "ok", { heartbeatAt: now.toISOString(), pid: process.pid });
  await checkDatabase();
  await checkRedis();
  await checkResearchService();
  await checkBinance();
  await checkTwelveData();
  await retireStaleProviders();
  const eligibility = await checkCandleFreshness(now);
  await checkHost();
  await checkWorkerHeartbeats();
  await checkScanner(eligibility);
  await checkQueuesAndBacktests();
  await checkNotifications();
  await checkBackfill();
  await maybeRetention();
  const durationMs = Date.now() - started;
  await recordHealth("monitor", "ok", { durationMs, completedAt: new Date().toISOString() });
  return { durationMs };
}
