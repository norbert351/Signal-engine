import type { CandleInterval, NormalizedCandle } from "./index.js";

export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000
};

export function validateNormalizedCandle(candle: NormalizedCandle): void {
  if (!candle.symbol || !candle.provider) throw new Error("Candle is missing provider or symbol");
  if (!(candle.interval in INTERVAL_MS)) throw new Error("Unsupported candle interval");
  const values = [candle.open, candle.high, candle.low, candle.close].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("Candle prices must be finite and positive");
  const [open, high, low, close] = values as [number, number, number, number];
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) throw new Error("Candle OHLC bounds are invalid");
  if (!(candle.openTime instanceof Date) || Number.isNaN(candle.openTime.getTime())) throw new Error("Invalid candle open time");
  if (!(candle.closeTime instanceof Date) || Number.isNaN(candle.closeTime.getTime())) throw new Error("Invalid candle close time");
  if (candle.closeTime.getTime() <= candle.openTime.getTime()) throw new Error("Candle close time must follow open time");
  if (candle.volume !== null && (!Number.isFinite(Number(candle.volume)) || Number(candle.volume) < 0)) throw new Error("Candle volume is invalid");
}

export function normalizeCandles(candles: NormalizedCandle[]): NormalizedCandle[] {
  const byOpen = new Map<number, NormalizedCandle>();
  for (const candle of candles) {
    validateNormalizedCandle(candle);
    byOpen.set(candle.openTime.getTime(), candle);
  }
  return [...byOpen.values()].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
}

export function isForexMarketClosed(time: Date): boolean {
  const day = time.getUTCDay();
  const hour = time.getUTCHours();
  if (day === 6) return true;
  if (day === 5 && hour >= 21) return true;
  if (day === 0 && hour < 22) return true;
  return false;
}

export type CandleGap = { from: Date; to: Date; missing: number };

export function findMissingCandles(
  candles: NormalizedCandle[],
  interval: CandleInterval,
  market: "crypto_perpetual" | "forex" = "crypto_perpetual",
  maxGaps = 500
): CandleGap[] {
  const ordered = [...candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const step = INTERVAL_MS[interval];
  const gaps: CandleGap[] = [];
  for (let i = 1; i < ordered.length && gaps.length < maxGaps; i++) {
    const previous = ordered[i - 1]!.openTime.getTime();
    const current = ordered[i]!.openTime.getTime();
    if (current - previous <= step) continue;
    let missing = 0;
    for (let time = previous + step; time < current; time += step) {
      if (market === "forex" && isForexMarketClosed(new Date(time))) continue;
      missing += 1;
    }
    if (missing > 0) gaps.push({ from: new Date(previous + step), to: new Date(current - step), missing });
  }
  return gaps;
}

export function isCandleStale(
  latestCloseTime: Date,
  interval: CandleInterval,
  market: "crypto_perpetual" | "forex",
  now = new Date(),
  toleranceIntervals = 2
): boolean {
  if (market === "forex" && isForexMarketClosed(now)) return false;
  const age = now.getTime() - latestCloseTime.getTime();
  return age > INTERVAL_MS[interval] * toleranceIntervals;
}
