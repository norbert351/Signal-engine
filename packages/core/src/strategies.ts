import {
  ema,
  onlyClosedCandles,
  rewardRisk,
  type Candle,
  type Direction,
  type ScoreFactors,
  type SignalCandidate
} from "./index.js";
import {
  adx,
  analyzeMarketStructure,
  atr,
  bollinger,
  macd,
  relativeVolume,
  rsi,
  supportResistance,
  trendFromEma
} from "./indicators.js";

export type StrategyContext = { symbol: string; timeframe: string; trendCandles: Candle[]; entryCandles: Candle[] };
export type StrategyConfig = {
  emaFast: number;
  emaSlow: number;
  atrPeriod: number;
  stopAtrMultiple: number;
  minRewardRisk: number;
  target2Multiple: number;
  rangeLookback: number;
  retestToleranceAtr: number;
  rsiPeriod: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  volumeLookback: number;
  minRelativeVolume: number;
  swingLeft: number;
  swingRight: number;
  srLookback: number;
  srTolerancePct: number;
  srToleranceAtr: number;
  structureLookback: number;
  volatilityExpansion: number;
  bollingerPeriod: number;
  bollingerMultiplier: number;
  adxPeriod: number;
  adxMin: number;
};
export type StrategyResult = {
  strategyKey: string;
  strategyName: string;
  strategyVersion: number;
  direction: Direction;
  candidate: SignalCandidate;
  triggerCloseTime: number;
  scoreFactors: Partial<ScoreFactors>;
};

const defaults: StrategyConfig = {
  emaFast: 20,
  emaSlow: 50,
  atrPeriod: 14,
  stopAtrMultiple: 1.5,
  minRewardRisk: 2,
  target2Multiple: 3,
  rangeLookback: 20,
  retestToleranceAtr: 0.25,
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  volumeLookback: 20,
  minRelativeVolume: 1.2,
  swingLeft: 2,
  swingRight: 2,
  srLookback: 120,
  srTolerancePct: 0.005,
  srToleranceAtr: 0.5,
  structureLookback: 40,
  volatilityExpansion: 1.5,
  bollingerPeriod: 20,
  bollingerMultiplier: 2,
  adxPeriod: 14,
  adxMin: 20
};

export const STRATEGY_DEFINITIONS = {
  "ema-trend-pullback": { name: "EMA Trend Pullback", version: 1 },
  "range-breakout-retest": { name: "Range Breakout Retest", version: 1 },
  "support-resistance-rejection": { name: "Support Resistance Rejection", version: 1 },
  "market-structure-continuation": { name: "Market Structure Continuation", version: 1 },
  "trend-reversal-momentum": { name: "Trend Reversal Momentum", version: 1 },
  "volatility-expansion-breakout": { name: "Volatility Expansion Breakout", version: 1 }
} as const;
export type StrategyKey = keyof typeof STRATEGY_DEFINITIONS;

export function resolveStrategyConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  const config = { ...defaults, ...overrides };
  if (!Number.isInteger(config.emaFast) || !Number.isInteger(config.emaSlow) || config.emaFast < 1 || config.emaSlow <= config.emaFast) {
    throw new Error("Invalid EMA periods");
  }
  if (!Number.isInteger(config.atrPeriod) || config.atrPeriod < 1) throw new Error("Invalid ATR period");
  if (!Number.isFinite(config.minRewardRisk) || config.minRewardRisk <= 0) throw new Error("Invalid minimum reward/risk");
  if (!Number.isFinite(config.stopAtrMultiple) || config.stopAtrMultiple <= 0) throw new Error("Invalid stop ATR multiple");
  if (!Number.isFinite(config.target2Multiple) || config.target2Multiple <= config.minRewardRisk) throw new Error("Invalid second target multiple");
  return config;
}

type Prepared = {
  entry: Candle[];
  trend: Candle[];
  last: Candle;
  atrValue: number;
  htfTrend: "up" | "down" | "range";
};

function prepare(context: StrategyContext, cfg: StrategyConfig): Prepared | undefined {
  const entry = onlyClosedCandles(context.entryCandles);
  if (entry.length < cfg.emaSlow + 2) return undefined;
  const last = entry.at(-1)!;
  const trend = onlyClosedCandles(context.trendCandles).filter((candle) => candle.closeTime <= last.closeTime);
  if (trend.length < cfg.emaSlow + 2) return undefined;
  const atrValue = atr(entry, cfg.atrPeriod).at(-1);
  if (atrValue === null || atrValue === undefined || !Number.isFinite(atrValue) || atrValue <= 0) return undefined;
  return { entry, trend, last, atrValue, htfTrend: trendFromEma(trend, cfg.emaFast, cfg.emaSlow) };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function buildCandidate(
  direction: Direction,
  entry: number,
  stop: number,
  cfg: StrategyConfig,
  timeframe: string,
  rationale: string[],
  invalidation: string[],
  evidence: Record<string, number | string | boolean>
): SignalCandidate | undefined {
  const risk = direction === "LONG" ? entry - stop : stop - entry;
  if (!Number.isFinite(risk) || risk <= 0) return undefined;
  const targets = [
    direction === "LONG" ? entry + risk * cfg.minRewardRisk : entry - risk * cfg.minRewardRisk,
    direction === "LONG" ? entry + risk * cfg.target2Multiple : entry - risk * cfg.target2Multiple
  ];
  if (targets.some((target) => target <= 0)) return undefined;
  return {
    direction,
    entry,
    stopLoss: stop,
    targets,
    timeframe,
    rationale,
    invalidation,
    evidence
  };
}

function factorScores(
  direction: Direction,
  prepared: Prepared,
  cfg: StrategyConfig,
  minRewardRisk: number,
  entryQuality: number,
  structureAlignment: number
): Partial<ScoreFactors> {
  const closes = prepared.entry.map((candle) => candle.close);
  const rsiValue = rsi(closes, cfg.rsiPeriod).at(-1);
  const macdResult = macd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const histogram = macdResult.histogram.at(-1);
  const previousHistogram = macdResult.histogram.at(-2);
  const relative = relativeVolume(prepared.entry, cfg.volumeLookback).at(-1);
  const atrPercent = (prepared.atrValue / prepared.last.close) * 100;
  const levels = supportResistance(prepared.entry, cfg.srLookback, cfg.srTolerancePct);
  const relevantLevel = direction === "LONG" ? levels.supports[0] : levels.resistances[0];
  const distanceToLevel = relevantLevel ? Math.abs(prepared.last.close - relevantLevel.price) / prepared.atrValue : 3;
  const momentumAligned = direction === "LONG" ? (rsiValue ?? 50) >= 50 : (rsiValue ?? 50) <= 50;
  const histogramAligned = histogram !== null && histogram !== undefined && (direction === "LONG" ? histogram > 0 : histogram < 0);
  const histogramImproving =
    histogram !== null && histogram !== undefined && previousHistogram !== null && previousHistogram !== undefined
      ? direction === "LONG"
        ? histogram > previousHistogram
        : histogram < previousHistogram
      : false;
  return {
    trendAlignment: prepared.htfTrend === (direction === "LONG" ? "up" : "down") ? 1 : prepared.htfTrend === "range" ? 0.5 : 0,
    marketStructure: clamp01(structureAlignment),
    momentum: clamp01(((momentumAligned ? 0.6 : 0) + (histogramAligned ? 0.25 : 0) + (histogramImproving ? 0.15 : 0))),
    volumeConfirmation: clamp01((relative ?? 1) / 2),
    supportResistance: clamp01(1 - distanceToLevel / 3),
    volatilitySuitability: clamp01(atrPercent <= 0 ? 0 : atrPercent > 8 ? 0.2 : 0.4 + Math.min(atrPercent, 4) * 0.15),
    riskReward: clamp01(minRewardRisk / 4),
    entryQuality: clamp01(entryQuality)
  };
}

export function evaluateEmaPullback(context: StrategyContext, overrides: Partial<StrategyConfig> = {}): StrategyResult | undefined {
  const cfg = resolveStrategyConfig(overrides);
  const prepared = prepare(context, cfg);
  if (!prepared) return undefined;
  const { entry, last, atrValue, htfTrend } = prepared;
  if (htfTrend === "range") return undefined;
  const direction: Direction = htfTrend === "up" ? "LONG" : "SHORT";
  const closes = entry.map((candle) => candle.close);
  const fast = ema(closes, cfg.emaFast);
  if (fast.length < 2) return undefined;
  const prior = entry.at(-2)!;
  const fastNow = fast.at(-1)!;
  const fastPrior = fast.at(-2)!;
  const pulled =
    direction === "LONG"
      ? prior.low <= fastPrior * 1.002 && last.close > fastNow && last.close > last.open
      : prior.high >= fastPrior * 0.998 && last.close < fastNow && last.close < last.open;
  if (!pulled) return undefined;
  const structural =
    direction === "LONG"
      ? Math.min(...entry.slice(-cfg.atrPeriod).map((candle) => candle.low))
      : Math.max(...entry.slice(-cfg.atrPeriod).map((candle) => candle.high));
  const stop =
    direction === "LONG"
      ? Math.min(structural, last.close - atrValue * cfg.stopAtrMultiple)
      : Math.max(structural, last.close + atrValue * cfg.stopAtrMultiple);
  const candidate = buildCandidate(
    direction,
    last.close,
    stop,
    cfg,
    context.timeframe,
    ["Higher timeframe EMA trend aligned", "Pullback reclaimed the fast EMA on a completed candle"],
    [`Invalidated on a completed close ${direction === "LONG" ? "below" : "above"} ${stop.toFixed(8)}`, "Invalidated if higher timeframe EMA trend flips"],
    { emaFast: fastNow, atr: atrValue, htfTrend }
  );
  if (!candidate) return undefined;
  const rr = rewardRisk(direction, candidate.entry, candidate.stopLoss, candidate.targets[0]!);
  if (rr < cfg.minRewardRisk) return undefined;
  const structure = analyzeMarketStructure(entry.slice(-Math.max(60, cfg.structureLookback + 10)), cfg.swingLeft, cfg.swingRight);
  const structureAlignment = structure.trend === (direction === "LONG" ? "up" : "down") ? 1 : structure.trend === "range" ? 0.5 : 0.2;
  return {
    strategyKey: "ema-trend-pullback",
    strategyName: STRATEGY_DEFINITIONS["ema-trend-pullback"].name,
    strategyVersion: STRATEGY_DEFINITIONS["ema-trend-pullback"].version,
    direction,
    candidate,
    triggerCloseTime: last.closeTime,
    scoreFactors: factorScores(direction, prepared, cfg, rr, 0.8, structureAlignment)
  };
}

export function evaluateBreakoutRetest(context: StrategyContext, overrides: Partial<StrategyConfig> = {}): StrategyResult | undefined {
  const cfg = resolveStrategyConfig(overrides);
  const prepared = prepare(context, cfg);
  if (!prepared) return undefined;
  const { entry, last, atrValue, htfTrend } = prepared;
  if (entry.length < cfg.rangeLookback + 3 || htfTrend === "range") return undefined;
  const direction: Direction = htfTrend === "up" ? "LONG" : "SHORT";
  const prior = entry.slice(-(cfg.rangeLookback + 2), -2);
  const breakout = entry.at(-2)!;
  const ceiling = Math.max(...prior.map((candle) => candle.high));
  const floor = Math.min(...prior.map((candle) => candle.low));
  const tolerance = atrValue * cfg.retestToleranceAtr;
  let stop: number | undefined;
  if (direction === "LONG" && breakout.close > ceiling && last.low <= ceiling + tolerance && last.close > ceiling && last.close > last.open) {
    stop = Math.min(last.low, ceiling - tolerance);
  }
  if (direction === "SHORT" && breakout.close < floor && last.high >= floor - tolerance && last.close < floor && last.close < last.open) {
    stop = Math.max(last.high, floor + tolerance);
  }
  if (stop === undefined) return undefined;
  const candidate = buildCandidate(
    direction,
    last.close,
    stop,
    cfg,
    context.timeframe,
    ["Higher timeframe trend aligned", "Range breakout followed by a completed-candle retest"],
    [`Invalidated on a completed close back ${direction === "LONG" ? "below" : "above"} the broken range`, `Invalidated on a close ${direction === "LONG" ? "below" : "above"} ${stop.toFixed(8)}`],
    { rangeHigh: ceiling, rangeLow: floor, atr: atrValue, htfTrend }
  );
  if (!candidate) return undefined;
  const rr = rewardRisk(direction, candidate.entry, candidate.stopLoss, candidate.targets[0]!);
  if (rr < cfg.minRewardRisk) return undefined;
  const structure = analyzeMarketStructure(entry.slice(-Math.max(60, cfg.structureLookback + 10)), cfg.swingLeft, cfg.swingRight);
  const structureAlignment = structure.trend === (direction === "LONG" ? "up" : "down") ? 1 : structure.trend === "range" ? 0.5 : 0.2;
  return {
    strategyKey: "range-breakout-retest",
    strategyName: STRATEGY_DEFINITIONS["range-breakout-retest"].name,
    strategyVersion: STRATEGY_DEFINITIONS["range-breakout-retest"].version,
    direction,
    candidate,
    triggerCloseTime: last.closeTime,
    scoreFactors: factorScores(direction, prepared, cfg, rr, 0.75, structureAlignment)
  };
}

export function evaluateSupportResistanceRejection(context: StrategyContext, overrides: Partial<StrategyConfig> = {}): StrategyResult | undefined {
  const cfg = resolveStrategyConfig(overrides);
  const prepared = prepare(context, cfg);
  if (!prepared) return undefined;
  const { entry, last, atrValue, htfTrend } = prepared;
  if (htfTrend === "range") return undefined;
  const direction: Direction = htfTrend === "up" ? "LONG" : "SHORT";
  const levels = supportResistance(entry, cfg.srLookback, cfg.srTolerancePct);
  const tolerance = atrValue * cfg.srToleranceAtr;
  let stop: number | undefined;
  let levelPrice: number | undefined;
  if (direction === "LONG") {
    const support = levels.supports.find((level) => last.low <= level.price + tolerance && last.close > level.price);
    if (support && last.close > last.open && last.low < last.close) {
      stop = Math.min(last.low, support.price - atrValue * 0.25);
      levelPrice = support.price;
    }
  } else {
    const resistance = levels.resistances.find((level) => last.high >= level.price - tolerance && last.close < level.price);
    if (resistance && last.close < last.open && last.high > last.close) {
      stop = Math.max(last.high, resistance.price + atrValue * 0.25);
      levelPrice = resistance.price;
    }
  }
  if (stop === undefined || levelPrice === undefined) return undefined;
  const candidate = buildCandidate(
    direction,
    last.close,
    stop,
    cfg,
    context.timeframe,
    ["Higher timeframe trend aligned", "Price rejected a confirmed support/resistance level on a completed candle"],
    [`Invalidated on a completed close ${direction === "LONG" ? "below" : "above"} the rejected level`, `Invalidated on a close ${direction === "LONG" ? "below" : "above"} ${stop.toFixed(8)}`],
    { level: levelPrice, atr: atrValue, htfTrend }
  );
  if (!candidate) return undefined;
  const rr = rewardRisk(direction, candidate.entry, candidate.stopLoss, candidate.targets[0]!);
  if (rr < cfg.minRewardRisk) return undefined;
  const structure = analyzeMarketStructure(entry.slice(-Math.max(60, cfg.structureLookback + 10)), cfg.swingLeft, cfg.swingRight);
  const structureAlignment = structure.trend === (direction === "LONG" ? "up" : "down") ? 1 : structure.trend === "range" ? 0.5 : 0.2;
  return {
    strategyKey: "support-resistance-rejection",
    strategyName: STRATEGY_DEFINITIONS["support-resistance-rejection"].name,
    strategyVersion: STRATEGY_DEFINITIONS["support-resistance-rejection"].version,
    direction,
    candidate,
    triggerCloseTime: last.closeTime,
    scoreFactors: factorScores(direction, prepared, cfg, rr, 0.7, structureAlignment)
  };
}

export function evaluateMarketStructureContinuation(context: StrategyContext, overrides: Partial<StrategyConfig> = {}): StrategyResult | undefined {
  const cfg = resolveStrategyConfig(overrides);
  const prepared = prepare(context, cfg);
  if (!prepared) return undefined;
  const { entry, last, atrValue, htfTrend } = prepared;
  if (htfTrend === "range") return undefined;
  const direction: Direction = htfTrend === "up" ? "LONG" : "SHORT";
  const structure = analyzeMarketStructure(entry.slice(-Math.max(80, cfg.structureLookback + 20)), cfg.swingLeft, cfg.swingRight);
  if (structure.trend !== htfTrend) return undefined;
  const recent = structure.events.filter((event) => event.index >= entry.length - Math.max(80, cfg.structureLookback + 20) - 8);
  const breakEvent = recent
    .filter((event) => event.type === (direction === "LONG" ? "BOS_UP" : "BOS_DOWN"))
    .at(-1);
  if (!breakEvent) return undefined;
  const barsSinceBreak = entry.length - 1 - breakEvent.index;
  if (barsSinceBreak < 0 || barsSinceBreak > 6) return undefined;
  const structural =
    direction === "LONG"
      ? structure.lastSwingLow?.price ?? Math.min(...entry.slice(-cfg.atrPeriod).map((candle) => candle.low))
      : structure.lastSwingHigh?.price ?? Math.max(...entry.slice(-cfg.atrPeriod).map((candle) => candle.high));
  const stop =
    direction === "LONG"
      ? Math.min(structural, last.close - atrValue * cfg.stopAtrMultiple)
      : Math.max(structural, last.close + atrValue * cfg.stopAtrMultiple);
  const candidate = buildCandidate(
    direction,
    last.close,
    stop,
    cfg,
    context.timeframe,
    ["Higher timeframe trend and entry market structure aligned", "Break of structure followed by continuation"],
    [`Invalidated on a completed close ${direction === "LONG" ? "below" : "above"} the last structural swing`, `Invalidated on a close ${direction === "LONG" ? "below" : "above"} ${stop.toFixed(8)}`],
    { structureTrend: structure.trend, breakPrice: breakEvent.price, atr: atrValue, htfTrend }
  );
  if (!candidate) return undefined;
  const rr = rewardRisk(direction, candidate.entry, candidate.stopLoss, candidate.targets[0]!);
  if (rr < cfg.minRewardRisk) return undefined;
  return {
    strategyKey: "market-structure-continuation",
    strategyName: STRATEGY_DEFINITIONS["market-structure-continuation"].name,
    strategyVersion: STRATEGY_DEFINITIONS["market-structure-continuation"].version,
    direction,
    candidate,
    triggerCloseTime: last.closeTime,
    scoreFactors: factorScores(direction, prepared, cfg, rr, 0.85, 1)
  };
}

export function evaluateTrendReversalMomentum(context: StrategyContext, overrides: Partial<StrategyConfig> = {}): StrategyResult | undefined {
  const cfg = resolveStrategyConfig(overrides);
  const prepared = prepare(context, cfg);
  if (!prepared) return undefined;
  const { entry, last, atrValue, htfTrend } = prepared;
  const structure = analyzeMarketStructure(entry.slice(-Math.max(80, cfg.structureLookback + 20)), cfg.swingLeft, cfg.swingRight);
  const recent = structure.events.filter((event) => event.index >= entry.length - Math.max(80, cfg.structureLookback + 20) - 6);
  const reversal = recent.filter((event) => event.type === "CHOCH_UP" || event.type === "CHOCH_DOWN").at(-1);
  if (!reversal) return undefined;
  const direction: Direction = reversal.type === "CHOCH_UP" ? "LONG" : "SHORT";
  const closes = entry.map((candle) => candle.close);
  const rsiSeries = rsi(closes, cfg.rsiPeriod);
  const rsiNow = rsiSeries.at(-1);
  const rsiPrior = rsiSeries.at(-2);
  if (rsiNow === null || rsiNow === undefined || rsiPrior === null || rsiPrior === undefined) return undefined;
  const macdResult = macd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const histogram = macdResult.histogram.at(-1);
  const momentumConfirmed =
    direction === "LONG"
      ? (rsiPrior <= 50 && rsiNow > 50) || (histogram !== null && histogram !== undefined && histogram > 0)
      : (rsiPrior >= 50 && rsiNow < 50) || (histogram !== null && histogram !== undefined && histogram < 0);
  if (!momentumConfirmed) return undefined;
  const htfCloses = prepared.trend.map((candle) => candle.close);
  const htfRsi = rsi(htfCloses, cfg.rsiPeriod).at(-1);
  const exhaustion =
    direction === "LONG"
      ? htfTrend !== "up" && (htfRsi === null || htfRsi === undefined || htfRsi <= 48)
      : htfTrend !== "down" && (htfRsi === null || htfRsi === undefined || htfRsi >= 52);
  if (!exhaustion) return undefined;
  const structural =
    direction === "LONG"
      ? structure.lastSwingLow?.price ?? Math.min(...entry.slice(-cfg.atrPeriod).map((candle) => candle.low))
      : structure.lastSwingHigh?.price ?? Math.max(...entry.slice(-cfg.atrPeriod).map((candle) => candle.high));
  const stop =
    direction === "LONG"
      ? Math.min(structural, last.close - atrValue * cfg.stopAtrMultiple)
      : Math.max(structural, last.close + atrValue * cfg.stopAtrMultiple);
  const candidate = buildCandidate(
    direction,
    last.close,
    stop,
    cfg,
    context.timeframe,
    ["Change of character confirmed on a completed candle", "Momentum confirmation with higher timeframe exhaustion"],
    [`Invalidated if the change of character fails on a completed close`, `Invalidated on a close ${direction === "LONG" ? "below" : "above"} ${stop.toFixed(8)}`],
    { reversal: reversal.type, rsi: rsiNow, htfTrend, htfRsi: htfRsi ?? 0, atr: atrValue }
  );
  if (!candidate) return undefined;
  const rr = rewardRisk(direction, candidate.entry, candidate.stopLoss, candidate.targets[0]!);
  if (rr < cfg.minRewardRisk) return undefined;
  return {
    strategyKey: "trend-reversal-momentum",
    strategyName: STRATEGY_DEFINITIONS["trend-reversal-momentum"].name,
    strategyVersion: STRATEGY_DEFINITIONS["trend-reversal-momentum"].version,
    direction,
    candidate,
    triggerCloseTime: last.closeTime,
    scoreFactors: factorScores(direction, prepared, cfg, rr, 0.6, 0.7)
  };
}

export function evaluateVolatilityExpansionBreakout(context: StrategyContext, overrides: Partial<StrategyConfig> = {}): StrategyResult | undefined {
  const cfg = resolveStrategyConfig(overrides);
  const prepared = prepare(context, cfg);
  if (!prepared) return undefined;
  const { entry, last, atrValue, htfTrend } = prepared;
  if (htfTrend === "range" || entry.length < cfg.bollingerPeriod + 5) return undefined;
  const direction: Direction = htfTrend === "up" ? "LONG" : "SHORT";
  const atrSeries = atr(entry, cfg.atrPeriod);
  const atrHistory = atrSeries.slice(-21, -1).filter((value): value is number => value !== null);
  if (atrHistory.length < 10) return undefined;
  const averageAtr = atrHistory.reduce((a, b) => a + b, 0) / atrHistory.length;
  if (averageAtr <= 0 || atrValue / averageAtr < cfg.volatilityExpansion) return undefined;
  const closes = entry.map((candle) => candle.close);
  const bands = bollinger(closes, cfg.bollingerPeriod, cfg.bollingerMultiplier);
  const upper = bands.upper.at(-1);
  const lower = bands.lower.at(-1);
  const priorUpper = bands.upper.at(-2);
  const priorLower = bands.lower.at(-2);
  if (upper === null || upper === undefined || lower === null || lower === undefined) return undefined;
  const width = upper - lower;
  const priorWidth = priorUpper !== null && priorUpper !== undefined && priorLower !== null && priorLower !== undefined ? priorUpper - priorLower : 0;
  if (priorWidth <= 0 || width / priorWidth < 1.05) return undefined;
  const relative = relativeVolume(entry, cfg.volumeLookback).at(-1);
  if (relative === null || relative === undefined || relative < cfg.minRelativeVolume) return undefined;
  const rangeBars = entry.slice(-(cfg.rangeLookback + 1), -1);
  if (rangeBars.length < cfg.rangeLookback) return undefined;
  const rangeHigh = Math.max(...rangeBars.map((candle) => candle.high));
  const rangeLow = Math.min(...rangeBars.map((candle) => candle.low));
  const expanded =
    direction === "LONG" ? last.close > upper && last.close > rangeHigh : last.close < lower && last.close < rangeLow;
  if (!expanded) return undefined;
  const stop =
    direction === "LONG"
      ? Math.min(last.low, last.close - atrValue * cfg.stopAtrMultiple)
      : Math.max(last.high, last.close + atrValue * cfg.stopAtrMultiple);
  const candidate = buildCandidate(
    direction,
    last.close,
    stop,
    cfg,
    context.timeframe,
    ["Higher timeframe trend aligned", "Volatility expansion confirmed by ATR, Bollinger width and relative volume"],
    [`Invalidated on a completed close back inside the prior range`, `Invalidated on a close ${direction === "LONG" ? "below" : "above"} ${stop.toFixed(8)}`],
    { atrExpansion: atrValue / averageAtr, relativeVolume: relative, rangeHigh, rangeLow, htfTrend }
  );
  if (!candidate) return undefined;
  const rr = rewardRisk(direction, candidate.entry, candidate.stopLoss, candidate.targets[0]!);
  if (rr < cfg.minRewardRisk) return undefined;
  const structure = analyzeMarketStructure(entry.slice(-Math.max(60, cfg.structureLookback + 10)), cfg.swingLeft, cfg.swingRight);
  const structureAlignment = structure.trend === (direction === "LONG" ? "up" : "down") ? 1 : structure.trend === "range" ? 0.5 : 0.2;
  return {
    strategyKey: "volatility-expansion-breakout",
    strategyName: STRATEGY_DEFINITIONS["volatility-expansion-breakout"].name,
    strategyVersion: STRATEGY_DEFINITIONS["volatility-expansion-breakout"].version,
    direction,
    candidate,
    triggerCloseTime: last.closeTime,
    scoreFactors: factorScores(direction, prepared, cfg, rr, 0.9, structureAlignment)
  };
}

export type StrategyEvaluator = (context: StrategyContext, overrides?: Partial<StrategyConfig>) => StrategyResult | undefined;
export const STRATEGY_EVALUATORS: Record<StrategyKey, StrategyEvaluator> = {
  "ema-trend-pullback": evaluateEmaPullback,
  "range-breakout-retest": evaluateBreakoutRetest,
  "support-resistance-rejection": evaluateSupportResistanceRejection,
  "market-structure-continuation": evaluateMarketStructureContinuation,
  "trend-reversal-momentum": evaluateTrendReversalMomentum,
  "volatility-expansion-breakout": evaluateVolatilityExpansionBreakout
};

export function evaluateStrategy(key: string, context: StrategyContext, overrides: Partial<StrategyConfig> = {}): StrategyResult | undefined {
  const evaluator = STRATEGY_EVALUATORS[key as StrategyKey];
  if (!evaluator) return undefined;
  return evaluator(context, overrides);
}

export { defaults as DEFAULT_STRATEGY_CONFIG };
