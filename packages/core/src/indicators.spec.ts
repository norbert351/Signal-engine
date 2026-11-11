import { describe, expect, it } from "vitest";
import type { Candle } from "./index.js";
import {
  adx,
  analyzeMarketStructure,
  atr,
  bollinger,
  emaSeries,
  findSwings,
  isRangeBound,
  macd,
  relativeVolume,
  rsi,
  sma,
  supportResistance,
  trendFromEma,
  vwap
} from "./indicators.js";

function candle(close: number, high = close + 1, low = close - 1, volume = 10, index = 0): Candle {
  return { openTime: index * 60000, closeTime: index * 60000 + 59999, open: close, high, low, close, volume, complete: true };
}
function series(values: number[]): Candle[] {
  return values.map((value, index) => candle(value, value + 1, value - 1, 10, index));
}

describe("technical indicators", () => {
  it("computes SMA and aligned EMA with warmup nulls", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    const ema = emaSeries([1, 2, 3, 4], 2);
    expect(ema[0]).toBeNull();
    expect(ema[1]).toBeCloseTo(1.5);
    expect(ema[2]).toBeCloseTo(2.5);
    expect(ema[3]).toBeCloseTo(3.5);
  });

  it("computes RSI boundary values", () => {
    const rising = rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14);
    expect(rising.at(-1)).toBe(100);
    const flat = rsi(Array.from({ length: 20 }, () => 100), 14);
    expect(flat.at(-1)).toBe(50);
  });

  it("computes MACD alignment and histogram", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const result = macd(values);
    expect(result.macd[24]).toBeNull();
    expect(result.macd[25]).not.toBeNull();
    const last = result.histogram.at(-1);
    expect(last).not.toBeNull();
    expect(Number.isFinite(last!)).toBe(true);
  });

  it("computes ATR and ADX from candles", () => {
    const candles = series(Array.from({ length: 40 }, (_, i) => 100 + i));
    expect(atr(candles, 14)[12]).toBeNull();
    expect(atr(candles, 14)[13]).toBeCloseTo(2);
    const trend = adx(candles, 14);
    expect(trend.adx.at(-1)).not.toBeNull();
    expect(trend.plusDi.at(-1)).toBeGreaterThan(trend.minusDi.at(-1)!);
  });

  it("computes Bollinger Bands around a flat series", () => {
    const bands = bollinger(Array.from({ length: 30 }, () => 100), 20, 2);
    expect(bands.middle.at(-1)).toBe(100);
    expect(bands.upper.at(-1)).toBe(100);
    expect(bands.lower.at(-1)).toBe(100);
  });

  it("computes VWAP and relative volume", () => {
    const candles = series([100, 101, 102, 103, 104]);
    expect(vwap(candles).at(-1)).toBeCloseTo((100 + 101 + 102 + 103 + 104) / 5);
    const rel = relativeVolume(candles, 3);
    expect(rel[2]).toBeNull();
    expect(rel[3]).toBeCloseTo(1);
  });

  it("detects confirmed swing highs and lows without future bars", () => {
    const candles = series([1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 4, 5, 4, 3]);
    const swings = findSwings(candles, 2, 2);
    expect(swings.some((swing) => swing.type === "high" && swing.index === 4)).toBe(true);
    expect(swings.some((swing) => swing.type === "low" && swing.index === 8)).toBe(true);
    expect(swings.every((swing) => swing.index < candles.length - 2)).toBe(true);
  });

  it("clusters support and resistance levels", () => {
    const candles = series([100, 102, 104, 102, 100, 98, 100, 102, 104, 102, 100]);
    const levels = supportResistance(candles, 50, 0.02);
    expect(Array.isArray(levels.supports)).toBe(true);
    expect(Array.isArray(levels.resistances)).toBe(true);
  });

  it("detects market structure and range conditions", () => {
    const candles = series(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 2));
    const structure = analyzeMarketStructure(candles, 2, 2);
    expect(["up", "down", "range"]).toContain(structure.trend);
    const range = isRangeBound(candles, 30, 8);
    expect(range.high).toBeGreaterThan(range.low);
    expect(trendFromEma(candles, 5, 10)).toMatch(/up|down|range/);
  });
});
