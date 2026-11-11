import { and, asc, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { db } from "@signal-engine/database";
import { candles, paperTrades, signalEvents, signals } from "@signal-engine/database";
import { enqueueNotification } from "@signal-engine/database/scanner-repository";
import { formatLifecycleMessage } from "./format.js";
import { returnAfterCosts } from "./paper-math.js";

const OPEN_SIGNAL_STATUSES = ["PENDING", "ACTIVE", "PARTIALLY_FILLED", "TARGET_1_HIT"];
const COST_BPS = Number(process.env.PAPER_ROUND_TRIP_COST_BPS ?? "12");
const FUNDING_BPS = Number(process.env.PAPER_FUNDING_BPS_PER_8H ?? "0");

export async function processPaperTrades() {
  const candidates = await db.select().from(signals).where(inArray(signals.status, OPEN_SIGNAL_STATUSES)).limit(500);
  let opened = 0;
  let closed = 0;
  let partialExits = 0;
  let invalidated = 0;

  for (const candidate of candidates) {
    const result = await db.transaction(async (tx) => {
      const [signal] = await tx.select().from(signals).where(eq(signals.id, candidate.id)).limit(1).for("update");
      if (!signal || !OPEN_SIGNAL_STATUSES.includes(signal.status)) return { opened: 0, closed: 0, partial: 0, invalidated: 0 };
      const now = new Date();
      const [existing] = await tx.select().from(paperTrades).where(eq(paperTrades.signalId, signal.id)).limit(1).for("update");

      if (!existing) {
        if (signal.expiresAt <= now) {
          await tx.update(signals).set({ status: "EXPIRED", invalidatedAt: now }).where(eq(signals.id, signal.id));
          await tx.insert(signalEvents).values({ signalId: signal.id, eventType: "EXPIRED", eventKey: `signal:${signal.id}:EXPIRED`, payload: { reason: "expired_before_paper_entry" } }).onConflictDoNothing();
          await enqueueNotification({ signalId: signal.id, eventType: "EXPIRED", eventKey: `signal:${signal.id}:EXPIRED`, message: formatLifecycleMessage(signal, "EXPIRED", { reason: "Expired before a paper entry candle" }) });
          return { opened: 0, closed: 0, partial: 0, invalidated: 1 };
        }
        const [entryBar] = await tx
          .select()
          .from(candles)
          .where(and(eq(candles.instrumentId, signal.instrumentId), eq(candles.timeframe, signal.timeframe), eq(candles.isComplete, true), gt(candles.openTime, signal.publishedAt), lte(candles.openTime, signal.expiresAt)))
          .orderBy(asc(candles.openTime))
          .limit(1);
        if (!entryBar) return { opened: 0, closed: 0, partial: 0, invalidated: 0 };
        const [created] = await tx
          .insert(paperTrades)
          .values({
            signalId: signal.id,
            status: "OPEN",
            direction: signal.direction,
            entryPrice: entryBar.open,
            entryTime: entryBar.openTime,
            targetIndex: 0,
            remainingPct: "100",
            realizedReturn: "0",
            processedThrough: entryBar.openTime,
            costBps: String(COST_BPS),
            fundingBpsPer8h: String(FUNDING_BPS),
            initialStop: signal.stopLoss,
            initialTargets: (signal.targets as Array<{ price: string; allocationPct?: number }>).map((target) => target.allocationPct === undefined ? { price: target.price } : { price: target.price, allocationPct: target.allocationPct })
          })
          .onConflictDoNothing()
          .returning();
        if (!created) return { opened: 0, closed: 0, partial: 0, invalidated: 0 };
        await tx.update(signals).set({ status: "ACTIVE" }).where(eq(signals.id, signal.id));
        await tx.insert(signalEvents).values({ signalId: signal.id, eventType: "ACTIVE", eventKey: `signal:${signal.id}:ACTIVE`, payload: { entryPrice: entryBar.open, entryTime: entryBar.openTime.toISOString(), rule: "next completed candle open after publication" } }).onConflictDoNothing();
        await enqueueNotification({ signalId: signal.id, eventType: "ACTIVE", eventKey: `signal:${signal.id}:ACTIVE`, message: formatLifecycleMessage(signal, "ACTIVE", { price: Number(entryBar.open), reason: "Paper entry at next candle open" }) });
        return { opened: 1, closed: 0, partial: 0, invalidated: 0, signal, trade: created };
      }

      return { opened: 0, closed: 0, partial: 0, invalidated: 0, signal, trade: existing };
    });

    opened += result.opened;
    invalidated += result.invalidated;
    if (!result.signal || !result.trade) continue;
    const { signal, trade } = result;

    const processed = await db.transaction(async (tx) => {
      const [lockedTrade] = await tx.select().from(paperTrades).where(eq(paperTrades.id, trade.id)).limit(1).for("update");
      const [lockedSignal] = await tx.select().from(signals).where(eq(signals.id, signal.id)).limit(1).for("update");
      if (!lockedTrade || !lockedSignal || lockedTrade.status === "CLOSED") return { closed: 0, partial: 0 };
      const start = lockedTrade.processedThrough ?? lockedTrade.entryTime;
      const bars = await tx
        .select()
        .from(candles)
        .where(and(eq(candles.instrumentId, lockedSignal.instrumentId), eq(candles.timeframe, lockedSignal.timeframe), eq(candles.isComplete, true), gte(candles.openTime, start), lte(candles.closeTime, lockedSignal.expiresAt), lte(candles.closeTime, new Date())))
        .orderBy(asc(candles.openTime))
        .limit(500);
      if (!bars.length) return { closed: 0, partial: 0 };

      const targets = lockedSignal.targets as Array<{ price: string; allocationPct?: number }>;
      const entry = Number(lockedTrade.entryPrice);
      const stop = Number(lockedSignal.stopLoss);
      const long = lockedSignal.direction === "LONG";
      let targetIndex = lockedTrade.targetIndex;
      let remaining = Number(lockedTrade.remainingPct);
      let realized = Number(lockedTrade.realizedReturn);
      let status = lockedTrade.status;
      let exitPrice: number | undefined;
      let exitTime: Date | undefined;
      let closedReason: string | undefined;
      let partialCount = 0;

      for (const bar of bars) {
        const barOpen = Number(bar.open);
        const barHigh = Number(bar.high);
        const barLow = Number(bar.low);
        const stopHit = long ? barLow <= stop : barHigh >= stop;
        if (stopHit) {
          exitPrice = long ? Math.min(stop, barOpen) : Math.max(stop, barOpen);
          exitTime = bar.closeTime;
          realized += (remaining / 100) * returnAfterCosts(lockedSignal.direction, entry, exitPrice, Number(lockedTrade.costBps), lockedTrade.entryTime, exitTime, Number(lockedTrade.fundingBpsPer8h), lockedSignal.market);
          remaining = 0;
          closedReason = "stop";
          status = "CLOSED";
          await tx.update(signals).set({ status: "STOP_LOSS_HIT" }).where(eq(signals.id, lockedSignal.id));
          await tx.insert(signalEvents).values({ signalId: lockedSignal.id, eventType: "STOP_LOSS_HIT", eventKey: `signal:${lockedSignal.id}:STOP_LOSS_HIT`, payload: { exitPrice, exitTime: exitTime.toISOString(), netReturn: realized } }).onConflictDoNothing();
          await enqueueNotification({ signalId: lockedSignal.id, eventType: "STOP_LOSS_HIT", eventKey: `signal:${lockedSignal.id}:STOP_LOSS_HIT`, message: formatLifecycleMessage(lockedSignal, "STOP_LOSS_HIT", { price: exitPrice, netReturn: realized }) });
          break;
        }
        while (targetIndex < targets.length) {
          const target = Number(targets[targetIndex]!.price);
          const hit = long ? barHigh >= target : barLow <= target;
          if (!hit) break;
          const allocation = Math.min(remaining, targets[targetIndex]!.allocationPct ?? 100 / targets.length);
          const fill = target;
          realized += (allocation / 100) * returnAfterCosts(lockedSignal.direction, entry, fill, Number(lockedTrade.costBps), lockedTrade.entryTime, bar.closeTime, Number(lockedTrade.fundingBpsPer8h), lockedSignal.market);
          remaining -= allocation;
          targetIndex += 1;
          partialCount += 1;
          exitPrice = fill;
          exitTime = bar.closeTime;
          const eventType = targetIndex === 1 ? "TARGET_1_HIT" : "TARGET_2_HIT";
          status = remaining <= 0.0001 ? "CLOSED" : "PARTIALLY_FILLED";
          await tx.update(signals).set({ status: eventType }).where(eq(signals.id, lockedSignal.id));
          await tx.insert(signalEvents).values({ signalId: lockedSignal.id, eventType, eventKey: `signal:${lockedSignal.id}:${eventType}`, payload: { targetIndex, price: fill, allocationPct: allocation, remainingPct: remaining, netReturn: realized } }).onConflictDoNothing();
          await enqueueNotification({ signalId: lockedSignal.id, eventType, eventKey: `signal:${lockedSignal.id}:${eventType}`, message: formatLifecycleMessage(lockedSignal, eventType, { price: fill, targetIndex, remainingPct: remaining, netReturn: realized }) });
          if (remaining <= 0.0001) {
            remaining = 0;
            closedReason = "target";
            break;
          }
        }
        if (closedReason) break;
      }

      if (!closedReason && lockedSignal.expiresAt <= new Date() && bars.length) {
        const last = bars[bars.length - 1]!;
        exitPrice = Number(last.close);
        exitTime = last.closeTime;
        realized += (remaining / 100) * returnAfterCosts(lockedSignal.direction, entry, exitPrice, Number(lockedTrade.costBps), lockedTrade.entryTime, exitTime, Number(lockedTrade.fundingBpsPer8h), lockedSignal.market);
        remaining = 0;
        closedReason = "expired";
        status = "CLOSED";
        await tx.update(signals).set({ status: "EXPIRED" }).where(eq(signals.id, lockedSignal.id));
        await tx.insert(signalEvents).values({ signalId: lockedSignal.id, eventType: "EXPIRED", eventKey: `signal:${lockedSignal.id}:EXPIRED`, payload: { exitPrice, exitTime: exitTime.toISOString(), netReturn: realized } }).onConflictDoNothing();
        await enqueueNotification({ signalId: lockedSignal.id, eventType: "EXPIRED", eventKey: `signal:${lockedSignal.id}:EXPIRED`, message: formatLifecycleMessage(lockedSignal, "EXPIRED", { price: exitPrice, netReturn: realized, reason: "Signal expiry" }) });
      }

      const lastProcessed = bars[bars.length - 1]!.closeTime;
      await tx.update(paperTrades).set({
        status,
        targetIndex,
        remainingPct: String(remaining),
        realizedReturn: String(realized),
        processedThrough: lastProcessed,
        ...(status === "CLOSED" ? { exitPrice: String(exitPrice), exitTime, outcome: closedReason, netReturn: String(realized), closedReason } : {})
      }).where(eq(paperTrades.id, lockedTrade.id));

      if (status === "CLOSED") {
        await tx.insert(signalEvents).values({ signalId: lockedSignal.id, eventType: "CLOSED", eventKey: `signal:${lockedSignal.id}:CLOSED`, payload: { reason: closedReason, netReturn: realized } }).onConflictDoNothing();
      }
      return { closed: status === "CLOSED" ? 1 : 0, partial: partialCount };
    });
    closed += processed.closed;
    partialExits += processed.partial;
  }
  return { opened, closed, partialExits, invalidated, checked: candidates.length };
}
