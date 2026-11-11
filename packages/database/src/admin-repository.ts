import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./index.js";
import { backfillProgress, backtestRuns, instruments, strategyConfigs } from "./schema.js";

const MIN_TOTAL_TRADES = Number(process.env.MIN_BACKTEST_TRADES ?? "30");
const MIN_OOS_TRADES = Number(process.env.MIN_OOS_TRADES ?? "10");

function hashParameters(parameters: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parameters)).digest("hex");
}

function metricNumber(metrics: Record<string, unknown>, path: string[]): number {
  let value: unknown = metrics;
  for (const key of path) {
    if (!value || typeof value !== "object") return 0;
    value = (value as Record<string, unknown>)[key];
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function listStrategies() {
  return db.select().from(strategyConfigs).orderBy(strategyConfigs.key, strategyConfigs.version);
}

export async function getStrategy(id: string) {
  const [row] = await db.select().from(strategyConfigs).where(eq(strategyConfigs.id, id)).limit(1);
  return row ?? null;
}

export async function createStrategyVersion(input: {
  key: string;
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  riskConfig: Record<string, unknown>;
}) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(input.key)) throw new Error("Strategy key must be a lowercase slug");
  if (!input.name.trim()) throw new Error("Strategy name is required");
  if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters)) {
    throw new Error("Strategy parameters must be an object");
  }
  const parameterHash = hashParameters(input.parameters);
  const [latest] = await db
    .select()
    .from(strategyConfigs)
    .where(eq(strategyConfigs.key, input.key))
    .orderBy(desc(strategyConfigs.version))
    .limit(1);
  if (latest?.parameterHash === parameterHash) {
    throw new Error(`Identical parameters already exist as version ${latest.version}`);
  }
  const version = (latest?.version ?? 0) + 1;
  const [row] = await db
    .insert(strategyConfigs)
    .values({
      key: input.key,
      version,
      name: input.name,
      description: input.description,
      enabled: false,
      approved: false,
      parameters: input.parameters,
      riskConfig: input.riskConfig,
      parameterHash
    })
    .returning();
  return row;
}

export async function setStrategyEnabled(id: string, enabled: boolean) {
  const [strategy] = await db.select().from(strategyConfigs).where(eq(strategyConfigs.id, id)).limit(1);
  if (!strategy) return null;
  if (enabled && !strategy.approved) throw new Error("Strategy must be approved after backtest review before activation");
  const [row] = await db
    .update(strategyConfigs)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(strategyConfigs.id, id))
    .returning();
  return row ?? null;
}

export async function setStrategyApproval(id: string, approved: boolean, note: string) {
  const [strategy] = await db.select().from(strategyConfigs).where(eq(strategyConfigs.id, id)).limit(1);
  if (!strategy) return null;
  if (approved) {
    if (note.trim().length < 20) throw new Error("Approval note must explain the validation review");
    const [completed] = await db
      .select()
      .from(backtestRuns)
      .where(
        and(
          eq(backtestRuns.strategyKey, strategy.key),
          eq(backtestRuns.strategyVersion, strategy.version),
          eq(backtestRuns.status, "completed")
        )
      )
      .orderBy(desc(backtestRuns.completedAt))
      .limit(1);
    if (!completed) throw new Error("A completed backtest for this strategy version is required before approval");
    const metrics = (completed.metrics ?? {}) as Record<string, unknown>;
    if (!metrics.outOfSample || typeof metrics.outOfSample !== "object") {
      throw new Error("Backtest must include an out-of-sample segment before approval");
    }
    if (metricNumber(metrics, ["outOfSampleBars"]) < 1) {
      throw new Error("Backtest out-of-sample segment is empty");
    }
    const totalTrades = metricNumber(metrics, ["overall", "trades"]);
    const oosTrades = metricNumber(metrics, ["outOfSample", "trades"]);
    if (totalTrades < MIN_TOTAL_TRADES) {
      throw new Error(`Backtest has ${totalTrades} trades; at least ${MIN_TOTAL_TRADES} are required before approval`);
    }
    if (oosTrades < MIN_OOS_TRADES) {
      throw new Error(`Out-of-sample segment has ${oosTrades} trades; at least ${MIN_OOS_TRADES} are required before approval`);
    }
  }
  const [row] = await db
    .update(strategyConfigs)
    .set({ approved, approvalNote: approved ? note : null, enabled: approved ? strategy.enabled : false, updatedAt: new Date() })
    .where(eq(strategyConfigs.id, id))
    .returning();
  return row ?? null;
}

export async function listBacktests() {
  return db
    .select({
      id: backtestRuns.id,
      strategyKey: backtestRuns.strategyKey,
      strategyVersion: backtestRuns.strategyVersion,
      instrumentId: backtestRuns.instrumentId,
      timeframe: backtestRuns.timeframe,
      parameters: backtestRuns.parameters,
      dataset: backtestRuns.dataset,
      assumptions: backtestRuns.assumptions,
      metrics: backtestRuns.metrics,
      status: backtestRuns.status,
      startedAt: backtestRuns.startedAt,
      completedAt: backtestRuns.completedAt,
      createdAt: backtestRuns.createdAt
    })
    .from(backtestRuns)
    .orderBy(desc(backtestRuns.createdAt))
    .limit(100);
}

export async function createBacktest(input: {
  strategyKey: string;
  strategyVersion: number;
  timeframe: string;
  dataset: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  instrumentId?: string;
}) {
  const [strategy] = await db
    .select()
    .from(strategyConfigs)
    .where(and(eq(strategyConfigs.key, input.strategyKey), eq(strategyConfigs.version, input.strategyVersion)))
    .limit(1);
  if (!strategy) throw new Error("Strategy key/version not found");
  const instrument = input.instrumentId
    ? (await db.select().from(instruments).where(eq(instruments.id, input.instrumentId)).limit(1))[0]
    : undefined;
  const dataset = {
    ...input.dataset,
    strategyParams: strategy.parameters,
    ...(instrument ? { symbol: instrument.symbol, market: instrument.market } : {})
  };
  const values = {
    strategyKey: input.strategyKey,
    strategyVersion: input.strategyVersion,
    timeframe: input.timeframe,
    dataset,
    assumptions: input.assumptions,
    parameters: strategy.parameters,
    status: "queued" as const,
    ...(input.instrumentId ? { instrumentId: input.instrumentId } : {})
  };
  const [row] = await db.insert(backtestRuns).values(values).returning();
  return row;
}

export async function requestBackfill(input: {
  provider: string;
  symbol: string;
  timeframe: string;
  startTime: Date;
  endTime: Date;
}) {
  if (!Number.isFinite(input.startTime.getTime()) || !Number.isFinite(input.endTime.getTime()) || input.startTime >= input.endTime) {
    throw new Error("Backfill start must be before end");
  }
  if (!["binance_usdm", "oanda_v20"].includes(input.provider)) throw new Error("Unsupported provider");
  if (!["1m", "5m", "15m", "1h", "4h", "1d"].includes(input.timeframe)) throw new Error("Unsupported timeframe");
  const [created] = await db
    .insert(backfillProgress)
    .values({ ...input, cursorTime: input.startTime, status: "requested" })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [existing] = await db
    .select()
    .from(backfillProgress)
    .where(
      and(
        eq(backfillProgress.provider, input.provider),
        eq(backfillProgress.symbol, input.symbol),
        eq(backfillProgress.timeframe, input.timeframe),
        eq(backfillProgress.startTime, input.startTime),
        eq(backfillProgress.endTime, input.endTime)
      )
    )
    .limit(1);
  return existing ?? null;
}

export async function resetBackfill(id: string) {
  const [row] = await db
    .update(backfillProgress)
    .set({ status: "requested", cursorTime: sql`${backfillProgress.startTime}`, lastError: null, updatedAt: new Date() })
    .where(eq(backfillProgress.id, id))
    .returning();
  return row ?? null;
}
