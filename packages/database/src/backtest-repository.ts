import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "./index.js";
import { backtestRuns } from "./schema.js";

const STALE_RUN_MS = 15 * 60_000;

export async function claimQueuedBacktests(limit = 5) {
  return db.transaction(async (tx) => {
    const staleBefore = new Date(Date.now() - STALE_RUN_MS);
    const stale = await tx
      .update(backtestRuns)
      .set({ status: "queued", startedAt: null })
      .where(and(eq(backtestRuns.status, "running"), or(lte(backtestRuns.startedAt, staleBefore), isNull(backtestRuns.startedAt))))
      .returning({ id: backtestRuns.id });
    const reclaimed = new Set(stale.map((row) => row.id));
    const rows = await tx
      .select()
      .from(backtestRuns)
      .where(eq(backtestRuns.status, "queued"))
      .orderBy(asc(backtestRuns.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed: typeof rows = [];
    for (const row of rows) {
      const startedAt = new Date();
      const metrics = {
        progress: {
          stage: reclaimed.has(row.id) ? "reclaimed" : "running",
          attempts: 0,
          startedAt: startedAt.toISOString(),
          reclaimed: reclaimed.has(row.id)
        }
      };
      await tx
        .update(backtestRuns)
        .set({ status: "running", startedAt, completedAt: null, metrics })
        .where(eq(backtestRuns.id, row.id));
      claimed.push({ ...row, status: "running", startedAt, metrics });
    }
    return claimed;
  });
}

export async function updateBacktestProgress(
  id: string,
  progress: Record<string, unknown>,
  claimedStartedAt?: Date
) {
  const rows = await db
    .update(backtestRuns)
    .set({ metrics: { progress } })
    .where(
      and(
        eq(backtestRuns.id, id),
        eq(backtestRuns.status, "running"),
        ...(claimedStartedAt ? [eq(backtestRuns.startedAt, claimedStartedAt)] : [])
      )
    )
    .returning({ id: backtestRuns.id });
  return rows.length > 0;
}

export async function finishBacktest(
  id: string,
  metrics: Record<string, unknown>,
  status: "completed" | "failed" = "completed",
  assumptions?: Record<string, unknown>,
  claimedStartedAt?: Date
) {
  const rows = await db
    .update(backtestRuns)
    .set({ status, metrics, ...(assumptions ? { assumptions } : {}), completedAt: new Date() })
    .where(
      and(
        eq(backtestRuns.id, id),
        eq(backtestRuns.status, "running"),
        ...(claimedStartedAt ? [eq(backtestRuns.startedAt, claimedStartedAt)] : [])
      )
    )
    .returning({ id: backtestRuns.id });
  return rows.length > 0;
}

export async function loadBacktestCandles(instrumentId: string, timeframe: string, trendTimeframe: string, start: Date, end: Date) {
  const { and, eq, gte, lte, asc } = await import("drizzle-orm");
  const { candles } = await import("./schema.js");
  const warmupStart = new Date(start.getTime() - 100 * 24 * 60 * 60 * 1000);
  const [entry, trend] = await Promise.all([
    db
      .select()
      .from(candles)
      .where(and(eq(candles.instrumentId, instrumentId), eq(candles.timeframe, timeframe), eq(candles.isComplete, true), gte(candles.openTime, warmupStart), lte(candles.openTime, end)))
      .orderBy(asc(candles.openTime)),
    db
      .select()
      .from(candles)
      .where(and(eq(candles.instrumentId, instrumentId), eq(candles.timeframe, trendTimeframe), eq(candles.isComplete, true), gte(candles.openTime, warmupStart), lte(candles.openTime, end)))
      .orderBy(asc(candles.openTime))
  ]);
  return {
    bars: entry.map((c) => ({ timestamp: c.openTime.getTime(), close_timestamp: c.closeTime.getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? "0" })),
    trendBars: trend.map((c) => ({ timestamp: c.openTime.getTime(), close_timestamp: c.closeTime.getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? "0" }))
  };
}
