import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "./index.js";
import { candles, instruments, notificationOutbox, signalEvents, signals, strategyConfigs } from "./schema.js";

export type PublishSignalInput = {
  dedupeKey: string;
  instrumentId: string;
  strategyConfigId: string;
  market: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  targets: number[];
  rr: number;
  timeframe: string;
  tradingStyle?: string;
  confirmationTimeframe?: string;
  strategyKey?: string;
  strategyVersion?: number;
  qualityScore?: number;
  qualityFactors?: Record<string, unknown>;
  scoreFormulaVersion?: string;
  invalidation?: string[] | undefined;
  rationale: string[];
  publishedAt: Date;
  expiresAt: Date;
  message?: string;
};

export async function findInstrument(provider: string, symbol: string) {
  const [row] = await db.select().from(instruments).where(and(eq(instruments.provider, provider), eq(instruments.symbol, symbol))).limit(1);
  return row;
}

export async function findEnabledStrategies() {
  return db
    .select()
    .from(strategyConfigs)
    .where(and(eq(strategyConfigs.enabled, true), eq(strategyConfigs.approved, true)));
}

export async function readRecentCandles(instrumentId: string, timeframe: string, limit = 300) {
  return db
    .select()
    .from(candles)
    .where(and(eq(candles.instrumentId, instrumentId), eq(candles.timeframe, timeframe), eq(candles.isComplete, true)))
    .orderBy(desc(candles.closeTime))
    .limit(limit)
    .then((rows) => rows.reverse());
}

export function telegramDestinations(): string[] {
  return (process.env.TELEGRAM_CHAT_IDS ?? process.env.TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function enqueueNotification(input: {
  signalId?: string;
  eventType: string;
  eventKey: string;
  message?: string;
  destinations?: string[];
}) {
  const destinations = input.destinations ?? telegramDestinations();
  if (!destinations.length) return 0;
  const rows = await db
    .insert(notificationOutbox)
    .values(
      destinations.map((destination) => ({
        signalId: input.signalId,
        destination,
        channel: "telegram",
        eventType: input.eventType,
        eventKey: `${input.eventKey}:telegram:${destination}`,
        message: input.message,
        status: "pending",
        nextAttemptAt: new Date()
      }))
    )
    .onConflictDoNothing()
    .returning({ id: notificationOutbox.id });
  return rows.length;
}

export async function publishSignal(input: PublishSignalInput) {
  return db.transaction(async (tx) => {
    const [signal] = await tx
      .insert(signals)
      .values({
        dedupeKey: input.dedupeKey,
        instrumentId: input.instrumentId,
        strategyConfigId: input.strategyConfigId,
        market: input.market,
        symbol: input.symbol,
        direction: input.direction,
        entryType: "MARKET",
        entryMin: String(input.entry),
        entryMax: String(input.entry),
        stopLoss: String(input.stop),
        targets: input.targets.map((price, index) => ({
          price: String(price),
          rewardRisk: String(Math.abs(price - input.entry) / Math.abs(input.entry - input.stop)),
          allocationPct: index === 0 ? 50 : 50
        })),
        rewardRisk: String(input.rr),
        timeframe: input.timeframe,
        tradingStyle: input.tradingStyle,
        confirmationTimeframe: input.confirmationTimeframe,
        strategyKey: input.strategyKey,
        strategyVersion: input.strategyVersion,
        qualityScore: input.qualityScore === undefined ? undefined : String(input.qualityScore),
        qualityFactors: input.qualityFactors ?? {},
        scoreFormulaVersion: input.scoreFormulaVersion,
        invalidationConditions: input.invalidation ?? [],
        rationale: input.rationale,
        status: "PENDING",
        publishedAt: input.publishedAt,
        expiresAt: input.expiresAt
      })
      .onConflictDoNothing()
      .returning();
    if (!signal) return null;
    await tx
      .insert(signalEvents)
      .values({ signalId: signal.id, eventType: "PUBLISHED", eventKey: `signal:${signal.id}:PUBLISHED`, payload: { source: "scanner" } })
      .onConflictDoNothing();
    const destinations = telegramDestinations();
    if (destinations.length) {
      await tx
        .insert(notificationOutbox)
        .values(
          destinations.map((destination) => ({
            signalId: signal.id,
            destination,
            channel: "telegram",
            eventType: "PUBLISHED",
            eventKey: `signal:${signal.id}:PUBLISHED:telegram:${destination}`,
            message: input.message,
            status: "pending",
            nextAttemptAt: new Date()
          }))
        )
        .onConflictDoNothing();
    }
    return signal;
  });
}

export async function getDueNotifications(now = new Date(), limit = 50) {
  return db.transaction(async (tx) => {
    await tx
      .update(notificationOutbox)
      .set({ status: "pending" })
      .where(and(eq(notificationOutbox.status, "sending"), lte(notificationOutbox.nextAttemptAt, now)));
    const rows = await tx
      .select()
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.nextAttemptAt, now)))
      .limit(limit)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      await tx
        .update(notificationOutbox)
        .set({ status: "sending", nextAttemptAt: new Date(now.getTime() + 5 * 60_000) })
        .where(eq(notificationOutbox.id, row.id));
    }
    return rows;
  });
}

export async function updateNotification(
  id: string,
  patch: {
    status: "pending" | "sending" | "delivered" | "failed";
    attempts: number;
    nextAttemptAt?: Date;
    deliveredAt?: Date;
    providerMessageId?: string;
    lastError?: string;
    message?: string;
  }
) {
  await db
    .update(notificationOutbox)
    .set({ ...patch, lastAttemptAt: new Date() })
    .where(eq(notificationOutbox.id, id));
}
