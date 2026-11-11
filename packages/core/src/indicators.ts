import type { Candle } from "./index.js";

export type Series = Array<number | null>;
export type Swing = { index: number; type: "high" | "low"; price: number; time: number };
export type Level = { price: number; touches: number; type: "support" | "resistance" };
export type StructureEventType = "HH" | "HL" | "LH" | "LL" | "BOS_UP" | "BOS_DOWN" | "CHOCH_UP" | "CHOCH_DOWN";
export type StructureEvent = { type: StructureEventType; index: number; price: number; time: number };
export type MarketStructure = {
  trend: "up" | "down" | "range";
  events: StructureEvent[];
  lastSwingHigh?: Swing;
  lastSwingLow?: Swing;
};

function requirePeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new Error("period must be a positive integer");
}

function finiteValues(values: number[]): void {
  if (values.some((value) => !Number.isFinite(value))) throw new Error("indicator input must be finite");
}

export function sma(values: number[], period: number): Series {
  requirePeriod(period);
  finiteValues(values);
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values: number[], period: number): Series {
  requirePeriod(period);
  finiteValues(values);
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = current;
  for (let i = period; i < values.length; i++) {
    current = values[i]! * alpha + current * (1 - alpha);
    out[i] = current;
  }
  return out;
}

export function rsi(values: number[], period = 14): Series {
  requirePeriod(period);
  finiteValues(values);
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const currentGain = change > 0 ? change : 0;
    const currentLoss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
    out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): { macd: Series; signal: Series; histogram: Series } {
  requirePeriod(fast);
  requirePeriod(slow);
  requirePeriod(signalPeriod);
  if (fast >= slow) throw new Error("MACD fast period must be smaller than slow period");
  const fastEma = emaSeries(values, fast);
  const slowEma = emaSeries(values, slow);
  const macdLine: Series = values.map((_, i) => (fastEma[i] === null || slowEma[i] === null ? null : fastEma[i]! - slowEma[i]!));
  const firstIndex = macdLine.findIndex((value) => value !== null);
  const compact = firstIndex < 0 ? [] : macdLine.slice(firstIndex).map((value) => value!);
  const signalCompact = emaSeries(compact, signalPeriod);
  const signal: Series = new Array(values.length).fill(null);
  if (firstIndex >= 0) {
    for (let i = 0; i < signalCompact.length; i++) signal[firstIndex + i] = signalCompact[i] ?? null;
  }
  const histogram: Series = values.map((_, i) => (macdLine[i] === null || signal[i] === null ? null : macdLine[i]! - signal[i]!));
  return { macd: macdLine, signal, histogram };
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((candle, i) => {
    if (i === 0) return candle.high - candle.low;
    const previousClose = candles[i - 1]!.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
}

export function atr(candles: Candle[], period = 14): Series {
  requirePeriod(period);
  const ranges = trueRange(candles);
  const out: Series = new Array(candles.length).fill(null);
  if (ranges.length < period) return out;
  let current = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = current;
  for (let i = period; i < ranges.length; i++) {
    current = (current * (period - 1) + ranges[i]!) / period;
    out[i] = current;
  }
  return out;
}

export function adx(candles: Candle[], period = 14): { adx: Series; plusDi: Series; minusDi: Series } {
  requirePeriod(period);
  const n = candles.length;
  const plusDi: Series = new Array(n).fill(null);
  const minusDi: Series = new Array(n).fill(null);
  const adxLine: Series = new Array(n).fill(null);
  if (n < period + 1) return { adx: adxLine, plusDi, minusDi };
  const tr = trueRange(candles);
  const plusDm: number[] = new Array(n).fill(0);
  const minusDm: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  let trSum = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let plusSum = plusDm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let minusSum = minusDm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dxValues: number[] = [];
  const diAt = (index: number): void => {
    plusDi[index] = trSum === 0 ? 0 : (100 * plusSum) / trSum;
    minusDi[index] = trSum === 0 ? 0 : (100 * minusSum) / trSum;
    const sum = plusDi[index]! + minusDi[index]!;
    dxValues.push(sum === 0 ? 0 : (100 * Math.abs(plusDi[index]! - minusDi[index]!)) / sum);
  };
  diAt(period);
  for (let i = period + 1; i < n; i++) {
    trSum = trSum - trSum / period + tr[i]!;
    plusSum = plusSum - plusSum / period + plusDm[i]!;
    minusSum = minusSum - minusSum / period + minusDm[i]!;
    diAt(i);
  }
  if (dxValues.length >= period) {
    let current = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    adxLine[period * 2 - 1] = current;
    for (let i = period; i < dxValues.length; i++) {
      current = (current * (period - 1) + dxValues[i]!) / period;
      adxLine[period + i] = current;
    }
  }
  return { adx: adxLine, plusDi, minusDi };
}

export function bollinger(values: number[], period = 20, multiplier = 2): { middle: Series; upper: Series; lower: Series } {
  requirePeriod(period);
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error("multiplier must be positive");
  const middle = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const mean = middle[i]!;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j]! - mean) ** 2;
    const deviation = Math.sqrt(variance / period);
    upper[i] = mean + multiplier * deviation;
    lower[i] = mean - multiplier * deviation;
  }
  return { middle, upper, lower };
}

export function vwap(candles: Candle[], period?: number): Series {
  if (period !== undefined) requirePeriod(period);
  const out: Series = new Array(candles.length).fill(null);
  let priceVolume = 0;
  let volumeTotal = 0;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const volume = candle.volume ?? 0;
    const typical = (candle.high + candle.low + candle.close) / 3;
    priceVolume += typical * volume;
    volumeTotal += volume;
    if (period !== undefined && i >= period) {
      const old = candles[i - period]!;
      const oldTypical = (old.high + old.low + old.close) / 3;
      priceVolume -= oldTypical * (old.volume ?? 0);
      volumeTotal -= old.volume ?? 0;
    }
    if (volumeTotal > 0 && (period === undefined || i >= period - 1)) out[i] = priceVolume / volumeTotal;
  }
  return out;
}

export function volumeSma(candles: Candle[], period = 20): Series {
  return sma(candles.map((candle) => candle.volume ?? 0), period);
}

export function relativeVolume(candles: Candle[], period = 20): Series {
  requirePeriod(period);
  const volumes = candles.map((candle) => candle.volume ?? 0);
  const out: Series = new Array(candles.length).fill(null);
  for (let i = period; i < volumes.length; i++) {
    const average = volumes.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
    out[i] = average > 0 ? volumes[i]! / average : null;
  }
  return out;
}

export function findSwings(candles: Candle[], left = 2, right = 2): Swing[] {
  requirePeriod(left);
  requirePeriod(right);
  const swings: Swing[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const candle = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= candle.high) isHigh = false;
      if (candles[j]!.low <= candle.low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, type: "high", price: candle.high, time: candle.closeTime });
    if (isLow) swings.push({ index: i, type: "low", price: candle.low, time: candle.closeTime });
  }
  return swings.sort((a, b) => a.index - b.index);
}

export function supportResistance(candles: Candle[], lookback = 120, tolerancePct = 0.005): { supports: Level[]; resistances: Level[] } {
  if (!Number.isFinite(tolerancePct) || tolerancePct <= 0) throw new Error("tolerancePct must be positive");
  const start = Math.max(0, candles.length - lookback);
  const swings = findSwings(candles.slice(start)).map((swing) => ({ ...swing, index: swing.index + start }));
  const current = candles.at(-1)?.close ?? 0;
  const clusters: Array<{ price: number; touches: number; type: "support" | "resistance" }> = [];
  for (const swing of swings) {
    const tolerance = swing.price * tolerancePct;
    const existing = clusters.find((cluster) => Math.abs(cluster.price - swing.price) <= tolerance);
    if (existing) {
      existing.price = (existing.price * existing.touches + swing.price) / (existing.touches + 1);
      existing.touches += 1;
    } else {
      clusters.push({ price: swing.price, touches: 1, type: swing.type === "high" ? "resistance" : "support" });
    }
  }
  const supports = clusters.filter((cluster) => cluster.price < current && cluster.type === "support").sort((a, b) => b.price - a.price);
  const resistances = clusters.filter((cluster) => cluster.price > current && cluster.type === "resistance").sort((a, b) => a.price - b.price);
  return { supports, resistances };
}

export function analyzeMarketStructure(candles: Candle[], left = 2, right = 2): MarketStructure {
  const swings = findSwings(candles, left, right);
  const highs = swings.filter((swing) => swing.type === "high");
  const lows = swings.filter((swing) => swing.type === "low");
  const events: StructureEvent[] = [];
  for (let i = 1; i < highs.length; i++) {
    const previous = highs[i - 1]!;
    const current = highs[i]!;
    events.push({ type: current.price > previous.price ? "HH" : "LH", index: current.index, price: current.price, time: current.time });
  }
  for (let i = 1; i < lows.length; i++) {
    const previous = lows[i - 1]!;
    const current = lows[i]!;
    events.push({ type: current.price > previous.price ? "HL" : "LL", index: current.index, price: current.price, time: current.time });
  }
  events.sort((a, b) => a.index - b.index);
  let trend: "up" | "down" | "range" = "range";
  if (highs.length >= 2 && lows.length >= 2) {
    const higherHigh = highs.at(-1)!.price > highs.at(-2)!.price;
    const higherLow = lows.at(-1)!.price > lows.at(-2)!.price;
    const lowerHigh = highs.at(-1)!.price < highs.at(-2)!.price;
    const lowerLow = lows.at(-1)!.price < lows.at(-2)!.price;
    if (higherHigh && higherLow) trend = "up";
    else if (lowerHigh && lowerLow) trend = "down";
  }
  let lastConfirmedHigh: Swing | undefined;
  let lastConfirmedLow: Swing | undefined;
  let currentTrend: "up" | "down" | "range" = trend;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const confirmedHigh = highs.filter((swing) => swing.index + right < i).at(-1);
    const confirmedLow = lows.filter((swing) => swing.index + right < i).at(-1);
    if (confirmedHigh) lastConfirmedHigh = confirmedHigh;
    if (confirmedLow) lastConfirmedLow = confirmedLow;
    if (lastConfirmedHigh && candle.close > lastConfirmedHigh.price) {
      const isChoch = currentTrend === "down";
      events.push({ type: isChoch ? "CHOCH_UP" : "BOS_UP", index: i, price: candle.close, time: candle.closeTime });
      currentTrend = "up";
      lastConfirmedHigh = undefined;
    } else if (lastConfirmedLow && candle.close < lastConfirmedLow.price) {
      const isChoch = currentTrend === "up";
      events.push({ type: isChoch ? "CHOCH_DOWN" : "BOS_DOWN", index: i, price: candle.close, time: candle.closeTime });
      currentTrend = "down";
      lastConfirmedLow = undefined;
    }
  }
  events.sort((a, b) => a.index - b.index);
  return {
    trend,
    events,
    ...(highs.length ? { lastSwingHigh: highs.at(-1)! } : {}),
    ...(lows.length ? { lastSwingLow: lows.at(-1)! } : {})
  };
}

export function isRangeBound(candles: Candle[], lookback = 40, maxWidthAtr = 4): { isRange: boolean; high: number; low: number; widthPct: number } {
  requirePeriod(lookback);
  const window = candles.slice(-lookback);
  if (window.length < Math.max(5, Math.floor(lookback / 2))) return { isRange: false, high: 0, low: 0, widthPct: 0 };
  const high = Math.max(...window.map((candle) => candle.high));
  const low = Math.min(...window.map((candle) => candle.low));
  const close = window.at(-1)!.close;
  const atrValue = atr(candles, Math.min(14, Math.max(2, window.length - 1))).at(-1);
  const widthPct = ((high - low) / close) * 100;
  const isRange = atrValue !== null && atrValue !== undefined && atrValue > 0 ? (high - low) / atrValue <= maxWidthAtr : false;
  return { isRange, high, low, widthPct };
}

export function atrPercent(candles: Candle[], period = 14): number | null {
  const value = atr(candles, period).at(-1);
  const close = candles.at(-1)?.close;
  if (value === null || value === undefined || close === undefined || close <= 0) return null;
  return (value / close) * 100;
}

export function trendFromEma(candles: Candle[], fastPeriod = 20, slowPeriod = 50): "up" | "down" | "range" {
  const closes = candles.map((candle) => candle.close);
  const fast = emaSeries(closes, fastPeriod).at(-1);
  const slow = emaSeries(closes, slowPeriod).at(-1);
  const last = closes.at(-1);
  if (fast === null || fast === undefined || slow === null || slow === undefined || last === undefined) return "range";
  if (fast > slow && last > fast) return "up";
  if (fast < slow && last < fast) return "down";
  return "range";
}
