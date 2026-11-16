import { type Candle, type Direction, onlyClosedCandles, rewardRisk, validateSignalLevels } from "./index.js";
import { atr, emaSeries, relativeVolume } from "./indicators.js";
import type { NormalizedGlobalEvent } from "./event-intelligence.js";

export type EventStrategyKey = "pre-event-positioning" | "post-event-momentum" | "post-event-reversal";
export type EventActionClassification = "LONG" | "SHORT" | "NO_TRADE" | "WATCH" | "HIGH_RISK";
export type EventSignalLifecycleStatus =
  | "detected"
  | "pending_validation"
  | "rejected"
  | "approved"
  | "published"
  | "active"
  | "expired"
  | "target_hit"
  | "stop_hit"
  | "cancelled"
  | "invalidated";

export type EventRiskPolicy = {
  maxSpreadBps: number;
  maxVolatilityRatio: number;
  minLiquidityRatio: number;
  maxGapPct: number;
  maxDataDelayMs: number;
  preEventBlackoutMinutes: number;
  postEventObservationMinutes: number;
  maxConcurrentEventSignals: number;
  minimumRewardRisk: number;
  maximumStopDistancePct: number;
};

export const DEFAULT_EVENT_RISK_POLICY: EventRiskPolicy = {
  maxSpreadBps: 18,
  maxVolatilityRatio: 2.5,
  minLiquidityRatio: 0.9,
  maxGapPct: 1.5,
  maxDataDelayMs: 15 * 60_000,
  preEventBlackoutMinutes: 15,
  postEventObservationMinutes: 5,
  maxConcurrentEventSignals: 3,
  minimumRewardRisk: 2.0,
  maximumStopDistancePct: 4.0
};

export type EventRiskEvaluationInput = {
  strategyType: "pre_event" | "post_event_momentum" | "post_event_reversal";
  symbol: string;
  market: "crypto_perpetual" | "forex";
  instrumentAvailable: boolean;
  evaluationTimeMs: number;
  latestCandleCloseMs: number;
  scheduledEventMs?: number | null;
  actualEventMs?: number | null;
  observedSpreadBps: number;
  volatilityRatio: number;
  volumeRatio: number | null;
  observedGapPct: number;
  conflictingSources: boolean;
  activeEventSignalsCount: number;
  policy?: Partial<EventRiskPolicy>;
};

export type EventRiskDecision = {
  allowed: boolean;
  riskClassification: "LOW_RISK" | "MODERATE_RISK" | "HIGH_RISK" | "BLOCKED";
  actionOverride?: "NO_TRADE" | "WATCH" | "HIGH_RISK";
  rejectionReasons: string[];
  estimatedSlippageBps: number;
  metrics: {
    observedSpreadBps: number;
    volatilityRatio: number;
    volumeRatio: number | null;
    observedGapPct: number;
    dataAgeMs: number;
  };
};

function isForexWeekendClosed(timeMs: number): boolean {
  const d = new Date(timeMs);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return true;
  if (day === 5 && hour >= 21) return true;
  if (day === 0 && hour < 22) return true;
  return false;
}

export class EventRiskManager {
  static evaluate(input: EventRiskEvaluationInput): EventRiskDecision {
    const policy: EventRiskPolicy = { ...DEFAULT_EVENT_RISK_POLICY, ...(input.policy ?? {}) };
    const reasons: string[] = [];

    if (!input.instrumentAvailable || input.symbol === "TONUSDT") {
      reasons.push("instrument_unavailable");
    }
    if (input.market === "forex" && isForexWeekendClosed(input.evaluationTimeMs)) {
      reasons.push("market_closed");
    }

    const dataAgeMs = Math.max(0, input.evaluationTimeMs - input.latestCandleCloseMs);
    if (dataAgeMs > policy.maxDataDelayMs) {
      reasons.push("stale_market_data");
    }
    if (input.conflictingSources) {
      reasons.push("conflicting_source_reports");
    }
    if (input.activeEventSignalsCount >= policy.maxConcurrentEventSignals) {
      reasons.push("max_concurrent_event_signals_exceeded");
    }
    if (input.observedSpreadBps > policy.maxSpreadBps) {
      reasons.push("spread_expansion_exceeded");
    }
    if (input.volatilityRatio > policy.maxVolatilityRatio) {
      reasons.push("volatility_limit_exceeded");
    }
    if (input.market === "crypto_perpetual" && input.volumeRatio !== null && input.volumeRatio < policy.minLiquidityRatio) {
      reasons.push("insufficient_liquidity");
    }
    if (input.observedGapPct > policy.maxGapPct) {
      reasons.push("excessive_market_gap");
    }

    if (input.strategyType === "pre_event") {
      if (!input.scheduledEventMs) {
        reasons.push("missing_scheduled_event_timestamp");
      } else {
        const minutesToEvent = (input.scheduledEventMs - input.evaluationTimeMs) / 60_000;
        if (minutesToEvent <= policy.preEventBlackoutMinutes && minutesToEvent >= -5) {
          reasons.push("pre_event_blackout_window");
        } else if (minutesToEvent < 0) {
          reasons.push("scheduled_event_already_passed");
        }
      }
    } else {
      if (!input.actualEventMs) {
        reasons.push("awaiting_actual_event_release");
      } else {
        const minutesSinceRelease = (input.evaluationTimeMs - input.actualEventMs) / 60_000;
        if (minutesSinceRelease < policy.postEventObservationMinutes) {
          reasons.push("post_event_observation_period_active");
        }
      }
    }

    const gapSlippageBps = Math.round(input.observedGapPct * 25);
    const volSlippageBps = Math.max(0, Math.round((input.volatilityRatio - 1) * 4));
    const estimatedSlippageBps = Math.max(2, Math.round(input.observedSpreadBps * 0.5) + gapSlippageBps + volSlippageBps);

    if (reasons.length > 0) {
      const watchOnly = reasons.every(
        (r) => r === "post_event_observation_period_active" || r === "pre_event_blackout_window"
      );
      return {
        allowed: false,
        riskClassification: "BLOCKED",
        actionOverride: watchOnly ? "WATCH" : "NO_TRADE",
        rejectionReasons: reasons,
        estimatedSlippageBps,
        metrics: {
          observedSpreadBps: input.observedSpreadBps,
          volatilityRatio: input.volatilityRatio,
          volumeRatio: input.volumeRatio,
          observedGapPct: input.observedGapPct,
          dataAgeMs
        }
      };
    }

    const highRisk =
      input.volatilityRatio >= policy.maxVolatilityRatio * 0.75 ||
      input.observedSpreadBps >= policy.maxSpreadBps * 0.75 ||
      input.strategyType === "pre_event";

    return {
      allowed: true,
      riskClassification: highRisk ? "HIGH_RISK" : "MODERATE_RISK",
      rejectionReasons: [],
      estimatedSlippageBps,
      metrics: {
        observedSpreadBps: input.observedSpreadBps,
        volatilityRatio: input.volatilityRatio,
        volumeRatio: input.volumeRatio,
        observedGapPct: input.observedGapPct,
        dataAgeMs
      }
    };
  }
}

export type EventStrategyEvaluationInput = {
  event: NormalizedGlobalEvent;
  symbol: string;
  market: "crypto_perpetual" | "forex";
  timeframe: string;
  confirmationTimeframe: string;
  entryCandles: Candle[];
  confirmationCandles: Candle[];
  instrumentAvailable?: boolean;
  observedSpreadBps?: number;
  conflictingSources?: boolean;
  activeEventSignalsCount?: number;
  riskPolicy?: Partial<EventRiskPolicy>;
};

export type EventSignalEvaluationOutput = {
  strategyKey: EventStrategyKey;
  strategyType: "pre_event" | "post_event_momentum" | "post_event_reversal";
  symbol: string;
  market: "crypto_perpetual" | "forex";
  timeframe: string;
  confirmationTimeframe: string;
  actionClassification: EventActionClassification;
  direction: Direction | "NONE";
  entryPrice: number | null;
  stopLoss: number | null;
  targets: number[];
  rewardRisk: number | null;
  riskClassification: EventRiskDecision["riskClassification"];
  validationStatus: "approved" | "rejected";
  outcomeStatus: EventSignalLifecycleStatus;
  rejectionReason?: string;
  triggerCloseTime: number;
  expiresAtMs: number;
  estimatedSlippageBps: number;
  quantitativeEvidence: Record<string, number | string | boolean | null>;
  rationale: string[];
};

function computeCandleMetrics(entryCandles: Candle[], confirmationCandles: Candle[]) {
  const closedEntry = onlyClosedCandles(entryCandles);
  const lastEntry = closedEntry.at(-1);
  if (!lastEntry || closedEntry.length < 30) return null;

  // Enforce zero lookahead on confirmation timeframe
  const closedConfirm = onlyClosedCandles(confirmationCandles).filter((c) => c.closeTime <= lastEntry.closeTime);
  if (closedConfirm.length < 25) return null;

  const entryAtrs = atr(closedEntry, 14);
  const currentAtr = entryAtrs.at(-1) ?? 0;
  if (currentAtr <= 0) return null;

  const priorAtrs = entryAtrs.slice(-15, -1);
  const avgAtr = priorAtrs.length > 0 ? priorAtrs.reduce((a, b) => a + b, 0) / priorAtrs.length : currentAtr;
  const volatilityRatio = avgAtr > 0 ? currentAtr / avgAtr : 1;

  const volRatio = relativeVolume(closedEntry, 20);
  const prevClose = closedEntry.at(-2)!.close;
  const observedGapPct = prevClose > 0 ? (Math.abs(lastEntry.open - prevClose) / prevClose) * 100 : 0;

  const confirmCloses = closedConfirm.map((c) => c.close);
  const confirmFast = emaSeries(confirmCloses, 10).at(-1)!;
  const confirmSlow = emaSeries(confirmCloses, 20).at(-1)!;
  const confirmLast = closedConfirm.at(-1)!.close;
  const htfTrend: "LONG" | "SHORT" | "RANGE" =
    confirmFast > confirmSlow && confirmLast > confirmFast
      ? "LONG"
      : confirmFast < confirmSlow && confirmLast < confirmFast
        ? "SHORT"
        : "RANGE";

  return {
    closedEntry,
    closedConfirm,
    lastEntry,
    currentAtr,
    volatilityRatio,
    volRatio,
    observedGapPct,
    htfTrend
  };
}

export class PreEventPositioningService {
  static evaluate(input: EventStrategyEvaluationInput): EventSignalEvaluationOutput {
    const metrics = computeCandleMetrics(input.entryCandles, input.confirmationCandles);
    const nowMs = metrics?.lastEntry.closeTime ?? Date.now();
    if (!metrics) {
      return {
        strategyKey: "pre-event-positioning",
        strategyType: "pre_event",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: "BLOCKED",
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: "insufficient_candle_history",
        triggerCloseTime: nowMs,
        expiresAtMs: nowMs + 30 * 60_000,
        estimatedSlippageBps: 0,
        quantitativeEvidence: {},
        rationale: ["Insufficient closed entry/confirmation candles for pre-event evaluation."]
      };
    }

    const scheduledMs = input.event.scheduledAt?.getTime() ?? null;
    const risk = EventRiskManager.evaluate({
      strategyType: "pre_event",
      symbol: input.symbol,
      market: input.market,
      instrumentAvailable: input.instrumentAvailable ?? true,
      evaluationTimeMs: metrics.lastEntry.closeTime,
      latestCandleCloseMs: metrics.lastEntry.closeTime,
      scheduledEventMs: scheduledMs,
      observedSpreadBps: input.observedSpreadBps ?? 6,
      volatilityRatio: metrics.volatilityRatio,
      volumeRatio: metrics.volRatio,
      observedGapPct: metrics.observedGapPct,
      conflictingSources: input.conflictingSources ?? false,
      activeEventSignalsCount: input.activeEventSignalsCount ?? 0,
      policy: { maxVolatilityRatio: 1.6, ...(input.riskPolicy ?? {}) }
    });

    if (!risk.allowed) {
      return {
        strategyKey: "pre-event-positioning",
        strategyType: "pre_event",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: risk.actionOverride ?? "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: risk.riskClassification,
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: risk.rejectionReasons.join(","),
        triggerCloseTime: metrics.lastEntry.closeTime,
        expiresAtMs: scheduledMs ?? metrics.lastEntry.closeTime + 30 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: {
          htfTrend: metrics.htfTrend,
          volatilityRatio: Number(metrics.volatilityRatio.toFixed(3))
        },
        rationale: [`Pre-event risk gate blocked setup: ${risk.rejectionReasons.join(", ")}`]
      };
    }

    const minutesToEvent = scheduledMs ? (scheduledMs - metrics.lastEntry.closeTime) / 60_000 : 999;
    if (minutesToEvent > 240 || metrics.htfTrend === "RANGE") {
      return {
        strategyKey: "pre-event-positioning",
        strategyType: "pre_event",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: minutesToEvent <= 240 ? "WATCH" : "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: "HIGH_RISK",
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: metrics.htfTrend === "RANGE" ? "no_clear_htf_trend" : "outside_pre_event_lead_window",
        triggerCloseTime: metrics.lastEntry.closeTime,
        expiresAtMs: scheduledMs ?? metrics.lastEntry.closeTime + 60 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: {
          minutesToEvent: Math.round(minutesToEvent),
          htfTrend: metrics.htfTrend
        },
        rationale: ["Pre-event positioning requires aligned HTF trend within 30–240 minutes before release."]
      };
    }

    const direction: Direction = metrics.htfTrend;
    const entry = metrics.lastEntry.close;
    const stopDistance = metrics.currentAtr * 1.5;
    const stopLoss = direction === "LONG" ? entry - stopDistance : entry + stopDistance;
    const t1 = direction === "LONG" ? entry + stopDistance * 2.0 : entry - stopDistance * 2.0;
    const t2 = direction === "LONG" ? entry + stopDistance * 3.0 : entry - stopDistance * 3.0;
    const rr = rewardRisk(direction, entry, stopLoss, t1);

    return {
      strategyKey: "pre-event-positioning",
      strategyType: "pre_event",
      symbol: input.symbol,
      market: input.market,
      timeframe: input.timeframe,
      confirmationTimeframe: input.confirmationTimeframe,
      actionClassification: direction,
      direction,
      entryPrice: entry,
      stopLoss,
      targets: [t1, t2],
      rewardRisk: Number(rr.toFixed(4)),
      riskClassification: "HIGH_RISK",
      validationStatus: "approved",
      outcomeStatus: "pending_validation",
      triggerCloseTime: metrics.lastEntry.closeTime,
      expiresAtMs: scheduledMs ? scheduledMs - 5 * 60_000 : metrics.lastEntry.closeTime + 60 * 60_000,
      estimatedSlippageBps: risk.estimatedSlippageBps,
      quantitativeEvidence: {
        minutesToEvent: Math.round(minutesToEvent),
        htfTrend: metrics.htfTrend,
        volatilityRatio: Number(metrics.volatilityRatio.toFixed(3)),
        consensusKnown: input.event.consensusValue !== null
      },
      rationale: [
        `Pre-event ${direction} positioning aligned with ${input.confirmationTimeframe} trend ${Math.round(minutesToEvent)}m prior to ${input.event.eventName}.`,
        "Outcome of upcoming announcement is unknown; strict pre-event stop and blackout expiry enforced."
      ]
    };
  }
}

export class PostEventMomentumService {
  /**
   * Primary Event Strategy: Waits for actual release + observation window, verifies
   * post-event candle displacement + confirmation timeframe alignment + risk gates.
   * Never triggers from the announcement figure alone without price/volume confirmation.
   */
  static evaluate(input: EventStrategyEvaluationInput): EventSignalEvaluationOutput {
    const metrics = computeCandleMetrics(input.entryCandles, input.confirmationCandles);
    const nowMs = metrics?.lastEntry.closeTime ?? Date.now();
    if (!metrics) {
      return {
        strategyKey: "post-event-momentum",
        strategyType: "post_event_momentum",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: "BLOCKED",
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: "insufficient_candle_history",
        triggerCloseTime: nowMs,
        expiresAtMs: nowMs + 60 * 60_000,
        estimatedSlippageBps: 0,
        quantitativeEvidence: {},
        rationale: ["Insufficient closed candles for post-event momentum evaluation."]
      };
    }

    const actualEventMs = (input.event.publishedAt ?? input.event.scheduledAt)?.getTime() ?? null;
    const hasReleased =
      input.event.actualValue !== null ||
      !input.event.isScheduled ||
      input.event.status === "released" ||
      input.event.status === "monitoring_reaction";

    const risk = EventRiskManager.evaluate({
      strategyType: "post_event_momentum",
      symbol: input.symbol,
      market: input.market,
      instrumentAvailable: input.instrumentAvailable ?? true,
      evaluationTimeMs: metrics.lastEntry.closeTime,
      latestCandleCloseMs: metrics.lastEntry.closeTime,
      actualEventMs: hasReleased ? actualEventMs : null,
      observedSpreadBps: input.observedSpreadBps ?? 8,
      volatilityRatio: metrics.volatilityRatio,
      volumeRatio: metrics.volRatio,
      observedGapPct: metrics.observedGapPct,
      conflictingSources: input.conflictingSources ?? false,
      activeEventSignalsCount: input.activeEventSignalsCount ?? 0,
      ...(input.riskPolicy ? { policy: input.riskPolicy } : {})
    });

    if (!risk.allowed) {
      return {
        strategyKey: "post-event-momentum",
        strategyType: "post_event_momentum",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: risk.actionOverride ?? "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: risk.riskClassification,
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: risk.rejectionReasons.join(","),
        triggerCloseTime: metrics.lastEntry.closeTime,
        expiresAtMs: metrics.lastEntry.closeTime + 60 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: {
          volatilityRatio: Number(metrics.volatilityRatio.toFixed(3)),
          volumeRatio: metrics.volRatio
        },
        rationale: [`Post-event momentum blocked by risk manager: ${risk.rejectionReasons.join(", ")}`]
      };
    }

    const anchorCandle =
      metrics.closedEntry.filter((c) => actualEventMs !== null && c.closeTime <= actualEventMs).at(-1) ??
      metrics.closedEntry.at(-3)!;
    const displacement = metrics.lastEntry.close - anchorCandle.close;
    const displacementAtr = Math.abs(displacement) / metrics.currentAtr;
    const bodyBullish = metrics.lastEntry.close > metrics.lastEntry.open;
    const bodyBearish = metrics.lastEntry.close < metrics.lastEntry.open;

    if (displacementAtr < 0.8 || (!bodyBullish && !bodyBearish)) {
      return {
        strategyKey: "post-event-momentum",
        strategyType: "post_event_momentum",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: risk.riskClassification,
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: "insufficient_post_event_displacement_or_confirmation",
        triggerCloseTime: metrics.lastEntry.closeTime,
        expiresAtMs: metrics.lastEntry.closeTime + 60 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: {
          displacementAtr: Number(displacementAtr.toFixed(3)),
          surprisePct: input.event.surprise.surprisePct
        },
        rationale: ["Market displacement after release does not meet minimum 0.8x ATR continuation threshold."]
      };
    }

    const direction: Direction = displacement > 0 ? "LONG" : "SHORT";
    if ((direction === "LONG" && !bodyBullish) || (direction === "SHORT" && !bodyBearish)) {
      return {
        strategyKey: "post-event-momentum",
        strategyType: "post_event_momentum",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: risk.riskClassification,
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: "trigger_candle_body_conflicts_with_displacement",
        triggerCloseTime: metrics.lastEntry.closeTime,
        expiresAtMs: metrics.lastEntry.closeTime + 60 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: { displacementAtr: Number(displacementAtr.toFixed(3)) },
        rationale: ["Trigger candle body does not confirm post-event displacement direction."]
      };
    }

    if (
      (direction === "LONG" && metrics.htfTrend === "SHORT") ||
      (direction === "SHORT" && metrics.htfTrend === "LONG")
    ) {
      return {
        strategyKey: "post-event-momentum",
        strategyType: "post_event_momentum",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: risk.riskClassification,
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: "confirmation_timeframe_trend_conflict",
        triggerCloseTime: metrics.lastEntry.closeTime,
        expiresAtMs: metrics.lastEntry.closeTime + 60 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: {
          direction,
          htfTrend: metrics.htfTrend,
          displacementAtr: Number(displacementAtr.toFixed(3))
        },
        rationale: ["Confirmation timeframe trend opposes post-event displacement."]
      };
    }

    const entry = metrics.lastEntry.close;
    const structuralStop =
      direction === "LONG"
        ? Math.min(metrics.lastEntry.low, entry - metrics.currentAtr * 1.5)
        : Math.max(metrics.lastEntry.high, entry + metrics.currentAtr * 1.5);
    const riskDist = Math.abs(entry - structuralStop);
    const t1 = direction === "LONG" ? entry + riskDist * 2.0 : entry - riskDist * 2.0;
    const t2 = direction === "LONG" ? entry + riskDist * 3.0 : entry - riskDist * 3.0;
    const check = validateSignalLevels(direction, entry, structuralStop, [t1, t2], 2.0);

    if (!check.valid) {
      return {
        strategyKey: "post-event-momentum",
        strategyType: "post_event_momentum",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: risk.riskClassification,
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: check.reasons.join(","),
        triggerCloseTime: metrics.lastEntry.closeTime,
        expiresAtMs: metrics.lastEntry.closeTime + 60 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: {},
        rationale: check.reasons
      };
    }

    return {
      strategyKey: "post-event-momentum",
      strategyType: "post_event_momentum",
      symbol: input.symbol,
      market: input.market,
      timeframe: input.timeframe,
      confirmationTimeframe: input.confirmationTimeframe,
      actionClassification: direction,
      direction,
      entryPrice: entry,
      stopLoss: structuralStop,
      targets: [t1, t2],
      rewardRisk: Number(check.rewardRisk[0]!.toFixed(4)),
      riskClassification: risk.riskClassification,
      validationStatus: "approved",
      outcomeStatus: "pending_validation",
      triggerCloseTime: metrics.lastEntry.closeTime,
      expiresAtMs: metrics.lastEntry.closeTime + 3 * 3600_000,
      estimatedSlippageBps: risk.estimatedSlippageBps,
      quantitativeEvidence: {
        displacementAtr: Number(displacementAtr.toFixed(3)),
        volatilityRatio: Number(metrics.volatilityRatio.toFixed(3)),
        volumeRatio: metrics.volRatio !== null ? Number(metrics.volRatio.toFixed(3)) : null,
        surprisePct: input.event.surprise.surprisePct,
        htfTrend: metrics.htfTrend
      },
      rationale: [
        `Post-event momentum continuation (${direction}) after ${input.event.eventName} release.`,
        `Displacement=${displacementAtr.toFixed(2)}x ATR with ${input.confirmationTimeframe} confirmation and validated risk bounds.`
      ]
    };
  }
}

export class PostEventReversalService {
  /**
   * Detects post-event exhaustion where an initial spike fails to hold and prints a
   * rejection wick (>= 45% of bar range) closing in the opposite direction.
   */
  static evaluate(input: EventStrategyEvaluationInput): EventSignalEvaluationOutput {
    const metrics = computeCandleMetrics(input.entryCandles, input.confirmationCandles);
    const nowMs = metrics?.lastEntry.closeTime ?? Date.now();
    if (!metrics) {
      return {
        strategyKey: "post-event-reversal",
        strategyType: "post_event_reversal",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: "BLOCKED",
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: "insufficient_candle_history",
        triggerCloseTime: nowMs,
        expiresAtMs: nowMs + 60 * 60_000,
        estimatedSlippageBps: 0,
        quantitativeEvidence: {},
        rationale: ["Insufficient closed candles for post-event reversal evaluation."]
      };
    }

    const actualEventMs = (input.event.publishedAt ?? input.event.scheduledAt)?.getTime() ?? null;
    const hasReleased =
      input.event.actualValue !== null ||
      !input.event.isScheduled ||
      input.event.status === "released" ||
      input.event.status === "monitoring_reaction";

    const risk = EventRiskManager.evaluate({
      strategyType: "post_event_reversal",
      symbol: input.symbol,
      market: input.market,
      instrumentAvailable: input.instrumentAvailable ?? true,
      evaluationTimeMs: metrics.lastEntry.closeTime,
      latestCandleCloseMs: metrics.lastEntry.closeTime,
      actualEventMs: hasReleased ? actualEventMs : null,
      observedSpreadBps: input.observedSpreadBps ?? 8,
      volatilityRatio: metrics.volatilityRatio,
      volumeRatio: metrics.volRatio,
      observedGapPct: metrics.observedGapPct,
      conflictingSources: input.conflictingSources ?? false,
      activeEventSignalsCount: input.activeEventSignalsCount ?? 0,
      policy: { postEventObservationMinutes: 15, ...(input.riskPolicy ?? {}) }
    });

    if (!risk.allowed) {
      return {
        strategyKey: "post-event-reversal",
        strategyType: "post_event_reversal",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: risk.actionOverride ?? "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: risk.riskClassification,
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: risk.rejectionReasons.join(","),
        triggerCloseTime: metrics.lastEntry.closeTime,
        expiresAtMs: metrics.lastEntry.closeTime + 60 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: {},
        rationale: [`Post-event reversal blocked by risk manager: ${risk.rejectionReasons.join(", ")}`]
      };
    }

    const bar = metrics.lastEntry;
    const range = bar.high - bar.low;
    const spikeAtr = range / metrics.currentAtr;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const upperWickRatio = range > 0 ? upperWick / range : 0;
    const lowerWickRatio = range > 0 ? lowerWick / range : 0;

    const bullishExhaustion = spikeAtr >= 1.2 && upperWickRatio >= 0.45 && bar.close < bar.open;
    const bearishExhaustion = spikeAtr >= 1.2 && lowerWickRatio >= 0.45 && bar.close > bar.open;

    if (!bullishExhaustion && !bearishExhaustion) {
      return {
        strategyKey: "post-event-reversal",
        strategyType: "post_event_reversal",
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        actionClassification: "NO_TRADE",
        direction: "NONE",
        entryPrice: null,
        stopLoss: null,
        targets: [],
        rewardRisk: null,
        riskClassification: risk.riskClassification,
        validationStatus: "rejected",
        outcomeStatus: "rejected",
        rejectionReason: "no_exhaustion_rejection_pattern",
        triggerCloseTime: bar.closeTime,
        expiresAtMs: bar.closeTime + 60 * 60_000,
        estimatedSlippageBps: risk.estimatedSlippageBps,
        quantitativeEvidence: {
          spikeAtr: Number(spikeAtr.toFixed(3)),
          upperWickRatio: Number(upperWickRatio.toFixed(3)),
          lowerWickRatio: Number(lowerWickRatio.toFixed(3))
        },
        rationale: ["No post-event spike exhaustion and rejection candle detected."]
      };
    }

    const direction: Direction = bearishExhaustion ? "LONG" : "SHORT";
    const entry = bar.close;
    const stopLoss =
      direction === "LONG"
        ? bar.low - metrics.currentAtr * 0.25
        : bar.high + metrics.currentAtr * 0.25;
    const riskDist = Math.abs(entry - stopLoss);
    const t1 = direction === "LONG" ? entry + riskDist * 2.0 : entry - riskDist * 2.0;
    const t2 = direction === "LONG" ? entry + riskDist * 3.0 : entry - riskDist * 3.0;
    const rr = rewardRisk(direction, entry, stopLoss, t1);

    return {
      strategyKey: "post-event-reversal",
      strategyType: "post_event_reversal",
      symbol: input.symbol,
      market: input.market,
      timeframe: input.timeframe,
      confirmationTimeframe: input.confirmationTimeframe,
      actionClassification: direction,
      direction,
      entryPrice: entry,
      stopLoss,
      targets: [t1, t2],
      rewardRisk: Number(rr.toFixed(4)),
      riskClassification: risk.riskClassification,
      validationStatus: "approved",
      outcomeStatus: "pending_validation",
      triggerCloseTime: bar.closeTime,
      expiresAtMs: bar.closeTime + 3 * 3600_000,
      estimatedSlippageBps: risk.estimatedSlippageBps,
      quantitativeEvidence: {
        spikeAtr: Number(spikeAtr.toFixed(3)),
        upperWickRatio: Number(upperWickRatio.toFixed(3)),
        lowerWickRatio: Number(lowerWickRatio.toFixed(3)),
        htfTrend: metrics.htfTrend
      },
      rationale: [
        `Post-event spike exhaustion reversal (${direction}) after ${input.event.eventName}.`,
        `Spike=${spikeAtr.toFixed(2)}x ATR with ${(Math.max(upperWickRatio, lowerWickRatio) * 100).toFixed(1)}% rejection wick.`
      ]
    };
  }
}

export type HistoricalEventBacktestInput = {
  strategyKey: EventStrategyKey;
  symbol: string;
  market: "crypto_perpetual" | "forex";
  timeframe: string;
  confirmationTimeframe: string;
  events: NormalizedGlobalEvent[];
  entryCandles: Candle[];
  confirmationCandles: Candle[];
  costs: {
    feeBpsPerSide: number;
    spreadBps: number;
    slippageBps: number;
  };
  expiryBars?: number;
};

export type SimulatedEventTrade = {
  eventDedupeKey: string;
  eventCategory: string;
  symbol: string;
  strategyKey: EventStrategyKey;
  direction: Direction;
  intendedEntry: number;
  observedEntry: number;
  stopLoss: number;
  target1: number;
  exitPrice: number;
  entryTimeMs: number;
  exitTimeMs: number;
  holdingSeconds: number;
  grossReturn: number;
  netReturn: number;
  slippageBps: number;
  outcome: "target_hit" | "stop_hit" | "expired";
  volatilityRegime: "high_vol" | "normal_vol";
};

export class EventBacktestService {
  /**
   * Chronological event-strategy backtester with strict no-lookahead guarantees,
   * next-bar-open entry, gap-aware stop-first resolution (never assuming exact stop fill
   * across a price gap), and 60/20/20 train/validation/out-of-sample split.
   */
  static runBacktest(input: HistoricalEventBacktestInput) {
    const closedEntry = onlyClosedCandles(input.entryCandles);
    const closedConfirm = onlyClosedCandles(input.confirmationCandles);
    const expiryBars = input.expiryBars ?? 12;

    const sortedEvents = [...input.events].sort((a, b) => {
      const ta = (a.publishedAt ?? a.scheduledAt ?? a.collectedAt).getTime();
      const tb = (b.publishedAt ?? b.scheduledAt ?? b.collectedAt).getTime();
      return ta - tb;
    });

    const trades: SimulatedEventTrade[] = [];
    let eligibleEvents = 0;
    let signalsGenerated = 0;
    let rejectedSetups = 0;
    let lastTradeExitMs = 0;

    for (const ev of sortedEvents) {
      const eventTriggerMs =
        input.strategyKey === "pre-event-positioning"
          ? (ev.scheduledAt?.getTime() ?? 0) - 60 * 60_000
          : (ev.publishedAt ?? ev.scheduledAt ?? ev.collectedAt).getTime() + 15 * 60_000;

      // Find the first completed bar whose closeTime >= eventTriggerMs
      const evalIdx = closedEntry.findIndex((c) => c.closeTime >= eventTriggerMs);
      if (evalIdx < 30 || evalIdx >= closedEntry.length - 1) continue;
      eligibleEvents += 1;

      const evalBar = closedEntry[evalIdx]!;
      // Prevent lookahead: pass only candles closed on or before evalBar.closeTime
      const entryPrefix = closedEntry.slice(0, evalIdx + 1);
      const confirmPrefix = closedConfirm.filter((c) => c.closeTime <= evalBar.closeTime);

      const evalInput: EventStrategyEvaluationInput = {
        event: ev,
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        confirmationTimeframe: input.confirmationTimeframe,
        entryCandles: entryPrefix,
        confirmationCandles: confirmPrefix,
        observedSpreadBps: input.costs.spreadBps
      };

      const signal =
        input.strategyKey === "pre-event-positioning"
          ? PreEventPositioningService.evaluate(evalInput)
          : input.strategyKey === "post-event-momentum"
            ? PostEventMomentumService.evaluate(evalInput)
            : PostEventReversalService.evaluate(evalInput);

      if (
        signal.validationStatus !== "approved" ||
        signal.direction === "NONE" ||
        signal.entryPrice === null ||
        signal.stopLoss === null ||
        signal.targets.length === 0
      ) {
        rejectedSetups += 1;
        continue;
      }

      signalsGenerated += 1;
      const nextBar = closedEntry[evalIdx + 1]!;
      if (nextBar.openTime < lastTradeExitMs) continue; // Non-overlapping positions

      const intendedEntry = nextBar.open;
      const totalSlippageBps = Math.max(input.costs.slippageBps, signal.estimatedSlippageBps);
      const halfSpreadAndSlipFrac = (input.costs.spreadBps * 0.5 + totalSlippageBps) / 10_000;
      const observedEntry =
        signal.direction === "LONG"
          ? intendedEntry * (1 + halfSpreadAndSlipFrac)
          : intendedEntry * (1 - halfSpreadAndSlipFrac);

      const riskDist = Math.abs(signal.entryPrice - signal.stopLoss);
      const stopLoss = signal.direction === "LONG" ? observedEntry - riskDist : observedEntry + riskDist;
      const target1 = signal.direction === "LONG" ? observedEntry + riskDist * 2.0 : observedEntry - riskDist * 2.0;

      let exitPrice = nextBar.close;
      let exitTimeMs = nextBar.closeTime;
      let outcome: SimulatedEventTrade["outcome"] = "expired";

      const maxIdx = Math.min(closedEntry.length - 1, evalIdx + 1 + expiryBars);
      for (let j = evalIdx + 1; j <= maxIdx; j++) {
        const bar = closedEntry[j]!;
        const stopHit = signal.direction === "LONG" ? bar.low <= stopLoss : bar.high >= stopLoss;
        const targetHit = signal.direction === "LONG" ? bar.high >= target1 : bar.low <= target1;

        // Conservative stop-first handling + gap-aware stop execution
        if (stopHit) {
          exitPrice = signal.direction === "LONG" ? Math.min(stopLoss, bar.open) : Math.max(stopLoss, bar.open);
          exitTimeMs = bar.closeTime;
          outcome = "stop_hit";
          break;
        }
        if (targetHit) {
          exitPrice = target1;
          exitTimeMs = bar.closeTime;
          outcome = "target_hit";
          break;
        }
        exitPrice = bar.close;
        exitTimeMs = bar.closeTime;
      }

      lastTradeExitMs = exitTimeMs;
      const grossReturn =
        signal.direction === "LONG"
          ? (exitPrice - observedEntry) / observedEntry
          : (observedEntry - exitPrice) / observedEntry;
      const roundTripFeeAndExitCost = (input.costs.feeBpsPerSide * 2 + input.costs.spreadBps * 0.5 + totalSlippageBps * 0.5) / 10_000;
      const netReturn = grossReturn - roundTripFeeAndExitCost;

      const volRatio = Number(signal.quantitativeEvidence.volatilityRatio ?? 1);
      trades.push({
        eventDedupeKey: ev.dedupeKey,
        eventCategory: ev.category,
        symbol: input.symbol,
        strategyKey: input.strategyKey,
        direction: signal.direction,
        intendedEntry,
        observedEntry,
        stopLoss,
        target1,
        exitPrice,
        entryTimeMs: nextBar.openTime,
        exitTimeMs,
        holdingSeconds: Math.max(1, Math.round((exitTimeMs - nextBar.openTime) / 1000)),
        grossReturn: Number(grossReturn.toFixed(6)),
        netReturn: Number(netReturn.toFixed(6)),
        slippageBps: totalSlippageBps,
        outcome,
        volatilityRegime: volRatio >= 1.4 ? "high_vol" : "normal_vol"
      });
    }

    const summarizeSegment = (segTrades: SimulatedEventTrade[]) => {
      const count = segTrades.length;
      if (count === 0) {
        return {
          trades: 0,
          winRate: 0,
          profitFactor: 0,
          expectancyAfterCosts: 0,
          netReturn: 0,
          maxDrawdown: 0,
          avgHoldingSeconds: 0
        };
      }
      const wins = segTrades.filter((t) => t.netReturn > 0);
      const losses = segTrades.filter((t) => t.netReturn <= 0);
      const grossWin = wins.reduce((s, t) => s + t.netReturn, 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netReturn, 0));
      let equity = 1;
      let peak = 1;
      let maxDd = 0;
      for (const t of segTrades) {
        equity *= 1 + t.netReturn;
        peak = Math.max(peak, equity);
        maxDd = Math.max(maxDd, (peak - equity) / peak);
      }
      const totalNet = segTrades.reduce((s, t) => s + t.netReturn, 0);
      const avgHold = Math.round(segTrades.reduce((s, t) => s + t.holdingSeconds, 0) / count);
      return {
        trades: count,
        winRate: Number((wins.length / count).toFixed(4)),
        profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(4)) : grossWin > 0 ? 99 : 0,
        expectancyAfterCosts: Number((totalNet / count).toFixed(6)),
        netReturn: Number((equity - 1).toFixed(6)),
        maxDrawdown: Number(maxDd.toFixed(4)),
        avgHoldingSeconds: avgHold
      };
    };

    const n = trades.length;
    const trainEnd = Math.floor(n * 0.6);
    const valEnd = Math.floor(n * 0.8);
    const overall = summarizeSegment(trades);
    const train = summarizeSegment(trades.slice(0, trainEnd));
    const validation = summarizeSegment(trades.slice(trainEnd, valEnd));
    const outOfSample = summarizeSegment(trades.slice(valEnd));

    const byCategory: Record<string, ReturnType<typeof summarizeSegment>> = {};
    for (const cat of new Set(trades.map((t) => t.eventCategory))) {
      byCategory[cat] = summarizeSegment(trades.filter((t) => t.eventCategory === cat));
    }
    const byVolatilityRegime = {
      high_vol: summarizeSegment(trades.filter((t) => t.volatilityRegime === "high_vol")),
      normal_vol: summarizeSegment(trades.filter((t) => t.volatilityRegime === "normal_vol"))
    };

    const promotionClassification =
      overall.trades < 100 || outOfSample.trades < 30
        ? ("insufficient_evidence" as const)
        : outOfSample.expectancyAfterCosts > 0 && outOfSample.profitFactor >= 1.15 && overall.maxDrawdown <= 0.2
          ? ("passed_research_validation" as const)
          : ("failed_validation" as const);

    return {
      strategyKey: input.strategyKey,
      symbol: input.symbol,
      timeframe: input.timeframe,
      totalEvents: sortedEvents.length,
      eligibleEvents,
      signalsGenerated,
      rejectedSetups,
      overall,
      train,
      validation,
      outOfSample,
      byCategory,
      byVolatilityRegime,
      promotionClassification,
      trades
    };
  }
}
