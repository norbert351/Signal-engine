import { describe, it, expect } from "vitest";
import {
  DEFAULT_STRATEGY_CONFIG,
  STRATEGY_DEFINITIONS,
  evaluateBreakoutRetest,
  evaluateEmaPullback,
  evaluateMarketStructureContinuation,
  evaluateStrategy,
  evaluateSupportResistanceRejection,
  evaluateTrendReversalMomentum,
  evaluateVolatilityExpansionBreakout,
  type StrategyContext
} from "./strategies.js";
import type { Candle } from "./index.js";

const STEP = 300000;
function candlesFromCloses(closes: number[], volume: number[] = []): Candle[] {
  return closes.map((close, i) => {
    const open = close;
    return {
      openTime: i * STEP,
      closeTime: (i + 1) * STEP - 1,
      open,
      high: close + 0.4,
      low: close - 0.4,
      close,
      volume: volume[i] ?? 10,
      complete: true
    };
  });
}
function uptrend(count = 120): Candle[] {
  return candlesFromCloses(Array.from({ length: count }, (_, i) => 100 + i * 0.6));
}
function series(n: number, step: number, offset = 0): Candle[] {
  return candlesFromCloses(Array.from({ length: n }, (_, i) => 100 + offset + i * step));
}
function context(entry: Candle[], trend: Candle[] = uptrend()): StrategyContext {
  return { symbol: "BTCUSDT", timeframe: "5m", entryCandles: entry, trendCandles: trend };
}

describe("strategy evaluators", () => {
  it("does not evaluate an incomplete candle", () => {
    const bars = series(80, 0.2);
    bars[bars.length - 1]!.complete = false;
    expect(evaluateEmaPullback(context(bars))).toBeUndefined();
  });

  it("returns no breakout when there is no confirmed retest", () => {
    expect(evaluateBreakoutRetest(context(series(80, 0.2)))).toBeUndefined();
  });

  it("registers all six independent strategy families", () => {
    expect(Object.keys(STRATEGY_DEFINITIONS)).toHaveLength(6);
    for (const key of Object.keys(STRATEGY_DEFINITIONS)) {
      expect(evaluateStrategy(key, context(series(80, 0.2)))).toBeUndefined();
      expect(key.length).toBeGreaterThan(3);
    }
  });

  it("produces a valid EMA pullback candidate with stop and two targets", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.6);
    closes[118] = closes[117]! - 8;
    closes[119] = closes[118]! + 3;
    const bars = candlesFromCloses(closes);
    bars[bars.length - 1]!.open = bars[bars.length - 1]!.close - 0.5;
    const result = evaluateEmaPullback(context(bars));
    expect(result).toBeDefined();
    expect(result!.strategyKey).toBe("ema-trend-pullback");
    expect(result!.candidate.targets).toHaveLength(2);
    expect(result!.candidate.stopLoss).toBeLessThan(result!.candidate.entry);
    expect(result!.candidate.rationale.length).toBeGreaterThan(0);
  });

  it("produces a valid range breakout retest candidate", () => {
    const closes = [...Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 0.5), 105, 103.5];
    const bars = candlesFromCloses(closes);
    bars[bars.length - 2]!.high = 106;
    bars[bars.length - 1]!.low = 100.8;
    bars[bars.length - 1]!.open = 102.5;
    const result = evaluateBreakoutRetest(context(bars));
    expect(result).toBeDefined();
    expect(result!.direction).toBe("LONG");
    expect(result!.candidate.stopLoss).toBeLessThan(result!.candidate.entry);
  });

  it("produces support rejection and resistance rejection candidates", () => {
    const closes: number[] = [];
    for (let i = 0; i < 80; i++) closes.push(101 + Math.sin(i / 2) * 2);
    closes.push(101.4);
    const bars = candlesFromCloses(closes);
    bars[bars.length - 1]!.low = 98.9;
    bars[bars.length - 1]!.open = 100.5;
    bars[bars.length - 1]!.close = 101.4;
    bars[bars.length - 1]!.high = 101.8;
    const long = evaluateSupportResistanceRejection(context(bars));
    expect(long).toBeDefined();
    expect(long!.direction).toBe("LONG");

    const downTrend = candlesFromCloses(Array.from({ length: 120 }, (_, i) => 200 - i * 0.6));
    const shortBars = candlesFromCloses(closes.map((value) => value + 100));
    shortBars[shortBars.length - 1]!.high = 203.4;
    shortBars[shortBars.length - 1]!.open = 202;
    shortBars[shortBars.length - 1]!.close = 201;
    shortBars[shortBars.length - 1]!.low = 200.6;
    const short = evaluateSupportResistanceRejection(context(shortBars, downTrend));
    expect(short).toBeDefined();
    expect(short!.direction).toBe("SHORT");
  });

  it("produces a market structure continuation candidate", () => {
    const closes: number[] = [];
    for (let k = 0; k < 16; k++) {
      const base = 100 + k * 2;
      closes.push(base, base + 3, base + 4, base + 1);
    }
    closes.push(closes.at(-1)! + 4);
    const trend = candlesFromCloses(Array.from({ length: 120 }, (_, i) => 100 + i));
    const result = evaluateMarketStructureContinuation(context(candlesFromCloses(closes), trend));
    expect(result).toBeDefined();
    expect(result!.direction).toBe("LONG");
    expect(result!.candidate.stopLoss).toBeLessThan(result!.candidate.entry);
  });

  it("produces a trend reversal candidate only with momentum confirmation", () => {
    const closes = [
      ...Array.from({ length: 45 }, (_, i) => 220 - i * 1.2),
      160, 159, 157, 158, 159, 156, 155, 153, 154, 155, 152, 151, 149, 150, 151, 148, 147, 145, 146, 149, 160
    ];
    const bars = candlesFromCloses(closes);
    const trend = candlesFromCloses(Array.from({ length: 120 }, (_, i) => 160 - i * 0.4));
    const result = evaluateTrendReversalMomentum(context(bars, trend));
    expect(result).toBeDefined();
    expect(result!.direction).toBe("LONG");
    expect(result!.candidate.invalidation?.length).toBeGreaterThan(0);
  });

  it("produces a volatility expansion breakout candidate", () => {
    const closes = [...Array.from({ length: 80 }, (_, i) => 100 + (i % 2 === 0 ? 0.3 : -0.3)), 130];
    const volumes = [...Array.from({ length: 80 }, () => 10), 200];
    const bars = candlesFromCloses(closes, volumes);
    bars[bars.length - 1]!.high = 131;
    bars[bars.length - 1]!.low = 109;
    bars[bars.length - 1]!.open = 110;
    const result = evaluateVolatilityExpansionBreakout(context(bars));
    expect(result).toBeDefined();
    expect(result!.direction).toBe("LONG");
    expect(result!.candidate.stopLoss).toBeLessThan(result!.candidate.entry);
  });

  it("never uses a trend candle that closes after the trigger candle", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.6);
    closes[118] = closes[117]! - 8;
    closes[119] = closes[118]! + 3;
    const entry = candlesFromCloses(closes);
    entry[entry.length - 1]!.open = entry[entry.length - 1]!.close - 0.5;
    const trend = uptrend();
    const future = { ...trend[trend.length - 1]!, closeTime: entry.at(-1)!.closeTime + STEP, close: 1, low: 0.5, high: 1.5, open: 1 };
    const withFuture = [...trend, future];
    const a = evaluateEmaPullback(context(entry, trend));
    const b = evaluateEmaPullback(context(entry, withFuture));
    expect(a?.triggerCloseTime).toBe(entry.at(-1)!.closeTime);
    expect(b?.triggerCloseTime).toBe(a?.triggerCloseTime);
  });

  it("exposes versioned default configuration", () => {
    expect(DEFAULT_STRATEGY_CONFIG.minRewardRisk).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.target2Multiple).toBeGreaterThan(DEFAULT_STRATEGY_CONFIG.minRewardRisk);
  });
});
