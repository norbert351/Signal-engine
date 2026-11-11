import { and, asc, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { db } from "./index.js";
import { candles, instruments, paperTrades, signalEvents, signals } from "./schema.js";

export type SignalCursor = { publishedAt: string; id: string };

export function encodeCursor(cursor: SignalCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string): SignalCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SignalCursor>;
    if (typeof parsed.publishedAt !== "string" || typeof parsed.id !== "string" || !Number.isFinite(Date.parse(parsed.publishedAt))) throw new Error("bad cursor");
    return { publishedAt: parsed.publishedAt, id: parsed.id };
  } catch {
    throw new Error("Invalid cursor");
  }
}

export async function listInstruments(filters: { market?: string | undefined; enabled?: boolean | undefined } = {}) {
  const conditions = [];
  if (filters.market) conditions.push(eq(instruments.market, filters.market));
  if (filters.enabled !== undefined) conditions.push(eq(instruments.enabled, filters.enabled));
  return db.select().from(instruments).where(conditions.length ? and(...conditions) : undefined).orderBy(asc(instruments.market), asc(instruments.symbol));
}

export async function listSignalsPage(filters: {
  market?: string | undefined;
  symbol?: string | undefined;
  status?: string | undefined;
  direction?: string | undefined;
  strategyKey?: string | undefined;
  timeframe?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  cursor?: SignalCursor | undefined;
  limit: number;
}) {
  const conditions = [];
  if (filters.market) conditions.push(eq(signals.market, filters.market));
  if (filters.symbol) conditions.push(eq(signals.symbol, filters.symbol));
  if (filters.status) conditions.push(eq(signals.status, filters.status));
  if (filters.direction) conditions.push(eq(signals.direction, filters.direction));
  if (filters.strategyKey) conditions.push(eq(signals.strategyKey, filters.strategyKey));
  if (filters.timeframe) conditions.push(eq(signals.timeframe, filters.timeframe));
  if (filters.from) conditions.push(gte(signals.publishedAt, filters.from));
  if (filters.to) conditions.push(lte(signals.publishedAt, filters.to));
  if (filters.cursor) {
    const cursorDate = new Date(filters.cursor.publishedAt);
    conditions.push(or(lt(signals.publishedAt, cursorDate), and(eq(signals.publishedAt, cursorDate), lt(signals.id, filters.cursor.id))));
  }
  const rows = await db
    .select()
    .from(signals)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(signals.publishedAt), desc(signals.id))
    .limit(filters.limit + 1);
  const hasMore = rows.length > filters.limit;
  const data = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = data.at(-1);
  return {
    data,
    nextCursor: hasMore && last ? encodeCursor({ publishedAt: last.publishedAt.toISOString(), id: last.id }) : null
  };
}

export async function listSignals(filters: { market?: string | undefined; symbol?: string | undefined; status?: string | undefined; limit?: number | undefined }) {
  const page = await listSignalsPage({ ...filters, limit: Math.min(Math.max(filters.limit ?? 50, 1), 200) });
  return page.data;
}

export async function getSignalDetail(id: string) {
  const [signal] = await db.select().from(signals).where(eq(signals.id, id)).limit(1);
  if (!signal) return null;
  const [events, trades] = await Promise.all([
    db.select().from(signalEvents).where(eq(signalEvents.signalId, id)).orderBy(asc(signalEvents.occurredAt)),
    db.select().from(paperTrades).where(eq(paperTrades.signalId, id))
  ]);
  return { signal, events, paperTrades: trades };
}

export async function listCandles(input: { provider: string; symbol: string; timeframe: string; limit: number; before?: Date | undefined }) {
  const [instrument] = await db.select().from(instruments).where(and(eq(instruments.provider, input.provider), eq(instruments.symbol, input.symbol))).limit(1);
  if (!instrument) return null;
  const conditions = [eq(candles.instrumentId, instrument.id), eq(candles.timeframe, input.timeframe), eq(candles.isComplete, true)];
  if (input.before) conditions.push(lt(candles.openTime, input.before));
  const rows = await db.select().from(candles).where(and(...conditions)).orderBy(desc(candles.openTime)).limit(input.limit).then((items) => items.reverse());
  return { instrument, candles: rows };
}

export async function upsertInstrument(input: { provider: string; market: string; symbol: string; baseAsset?: string; quoteAsset?: string; enabled?: boolean }) {
  const values = { provider: input.provider, market: input.market, symbol: input.symbol, ...(input.baseAsset !== undefined ? { baseAsset: input.baseAsset } : {}), ...(input.quoteAsset !== undefined ? { quoteAsset: input.quoteAsset } : {}), enabled: input.enabled ?? false };
  const set = { market: input.market, enabled: input.enabled ?? false, updatedAt: new Date(), ...(input.baseAsset !== undefined ? { baseAsset: input.baseAsset } : {}), ...(input.quoteAsset !== undefined ? { quoteAsset: input.quoteAsset } : {}) };
  const [row] = await db.insert(instruments).values(values).onConflictDoUpdate({ target: [instruments.provider, instruments.symbol], set }).returning();
  return row;
}

export async function storeCandles(instrumentId: string, source: string, rows: Array<{ timeframe: string; openTime: Date; closeTime: Date; open: string; high: string; low: string; close: string; volume: string | null; complete: boolean }>) {
  if (!rows.length) return 0;
  const inserted = await db.insert(candles).values(rows.map((row) => ({ ...row, instrumentId, source }))).onConflictDoNothing().returning({ id: candles.id });
  return inserted.length;
}
