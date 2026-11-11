import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./index.js";
import { backfillProgress, candles, instruments } from "./schema.js";

export async function ensureInstrument(
  provider: string,
  market: string,
  symbol: string,
  metadata?: { pricePrecision?: number; quantityPrecision?: number; available?: boolean; baseAsset?: string; quoteAsset?: string }
) {
  const [row] = await db
    .insert(instruments)
    .values({
      provider,
      market,
      symbol,
      enabled: metadata?.available !== false,
      ...(metadata?.pricePrecision !== undefined ? { pricePrecision: metadata.pricePrecision } : {}),
      ...(metadata?.quantityPrecision !== undefined ? { quantityPrecision: metadata.quantityPrecision } : {}),
      ...(metadata?.available !== undefined ? { available: metadata.available } : {}),
      ...(metadata?.baseAsset !== undefined ? { baseAsset: metadata.baseAsset } : {}),
      ...(metadata?.quoteAsset !== undefined ? { quoteAsset: metadata.quoteAsset } : {})
    })
    .onConflictDoUpdate({
      target: [instruments.provider, instruments.symbol],
      set: {
        market,
        updatedAt: new Date(),
        ...(metadata?.available === false ? { enabled: false } : {}),
        ...(metadata?.pricePrecision !== undefined ? { pricePrecision: metadata.pricePrecision } : {}),
        ...(metadata?.quantityPrecision !== undefined ? { quantityPrecision: metadata.quantityPrecision } : {}),
        ...(metadata?.available !== undefined ? { available: metadata.available } : {}),
        ...(metadata?.baseAsset !== undefined ? { baseAsset: metadata.baseAsset } : {}),
        ...(metadata?.quoteAsset !== undefined ? { quoteAsset: metadata.quoteAsset } : {})
      }
    })
    .returning();
  if (!row) throw new Error("Unable to upsert instrument " + provider + ":" + symbol);
  return row;
}

export async function updateInstrumentMetadata(
  id: string,
  metadata: { pricePrecision: number; quantityPrecision: number; available: boolean; status: string; contractType?: string; market?: string }
) {
  await db
    .update(instruments)
    .set({
      pricePrecision: metadata.pricePrecision,
      quantityPrecision: metadata.quantityPrecision,
      available: metadata.available,
      verifiedAt: new Date(),
      metadata: { status: metadata.status, ...(metadata.contractType ? { contractType: metadata.contractType } : {}) },
      updatedAt: new Date()
    })
    .where(eq(instruments.id, id));
}

export async function latestCandleTime(instrumentId: string, timeframe: string): Promise<Date | undefined> {
  const [row] = await db
    .select({ closeTime: candles.closeTime })
    .from(candles)
    .where(and(eq(candles.instrumentId, instrumentId), eq(candles.timeframe, timeframe), eq(candles.isComplete, true)))
    .orderBy(desc(candles.closeTime))
    .limit(1);
  return row?.closeTime;
}

export async function persistNormalizedCandles(
  instrumentId: string,
  source: string,
  rows: Array<{ interval: string; openTime: Date; closeTime: Date; open: string; high: string; low: string; close: string; volume: string | null; complete: boolean }>
) {
  const completed = rows.filter((row) => row.complete);
  if (!completed.length) return 0;
  const result = await db
    .insert(candles)
    .values(
      completed.map((row) => ({
        instrumentId,
        source,
        timeframe: row.interval,
        openTime: row.openTime,
        closeTime: row.closeTime,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        isComplete: true
      }))
    )
    .onConflictDoNothing()
    .returning({ id: candles.id });
  return result.length;
}

export async function getOrCreateBackfill(input: { provider: string; symbol: string; timeframe: string; startTime: Date; endTime: Date }) {
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
  if (existing) return existing;
  const [created] = await db
    .insert(backfillProgress)
    .values({ ...input, cursorTime: input.startTime, status: "pending" })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [row] = await db
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
  if (!row) throw new Error("Unable to create backfill progress");
  return row;
}

export async function updateBackfill(id: string, patch: { cursorTime?: Date; status?: string; candlesSeen?: number; candlesWritten?: number; lastError?: string | null }) {
  await db
    .update(backfillProgress)
    .set({ ...patch, updatedAt: new Date(), ...(patch.candlesSeen !== undefined ? { candlesSeen: sql`${backfillProgress.candlesSeen} + ${patch.candlesSeen}` } : {}), ...(patch.candlesWritten !== undefined ? { candlesWritten: sql`${backfillProgress.candlesWritten} + ${patch.candlesWritten}` } : {}) })
    .where(eq(backfillProgress.id, id));
}

export async function claimBackfillRequests(limit = 2) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(backfillProgress)
      .where(inArray(backfillProgress.status, ["requested", "pending"]))
      .orderBy(asc(backfillProgress.updatedAt))
      .limit(Math.min(Math.max(limit, 1), 10))
      .for("update", { skipLocked: true });
    const claimed: Array<typeof backfillProgress.$inferSelect> = [];
    for (const row of rows) {
      const [updated] = await tx
        .update(backfillProgress)
        .set({ status: "running", lastError: null, updatedAt: new Date() })
        .where(eq(backfillProgress.id, row.id))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function getBackfillById(id: string) {
  const [row] = await db.select().from(backfillProgress).where(eq(backfillProgress.id, id)).limit(1);
  return row ?? null;
}
