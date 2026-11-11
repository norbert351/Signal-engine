export type Direction = "LONG" | "SHORT";
export type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  complete: boolean;
};
export type SignalCandidate = {
  direction: Direction;
  entry: number;
  stopLoss: number;
  targets: number[];
  timeframe: string;
  rationale: string[];
  invalidation?: string[];
  evidence?: Record<string, number | string | boolean>;
};

export function validateCandle(c: Candle): void {
  const v = [c.open, c.high, c.low, c.close];
  if (!v.every(Number.isFinite) || v.some((x) => x <= 0)) throw new Error("OHLC values must be finite and positive");
  if (c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)) throw new Error("Invalid OHLC bounds");
  if (c.closeTime <= c.openTime) throw new Error("Invalid candle time range");
  if (c.volume !== undefined && (!Number.isFinite(c.volume) || c.volume < 0)) throw new Error("Invalid candle volume");
}

export function validateCandles(candles: Candle[]): void {
  for (const candle of candles) validateCandle(candle);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.openTime <= candles[i - 1]!.openTime) throw new Error("Candle timestamps must be strictly increasing");
  }
}

export function ema(values: number[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("period must be positive");
  if (values.length < period) return [];
  const alpha = 2 / (period + 1);
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [current];
  for (const value of values.slice(period)) {
    current = value * alpha + current * (1 - alpha);
    out.push(current);
  }
  return out;
}

export function rewardRisk(direction: Direction, entry: number, stop: number, target: number): number {
  const risk = direction === "LONG" ? entry - stop : stop - entry;
  const reward = direction === "LONG" ? target - entry : entry - target;
  if (risk <= 0 || reward <= 0) throw new Error("Invalid directional price levels");
  return reward / risk;
}

export function validateCandidate(c: SignalCandidate, minimum = 2): void {
  if (!c.timeframe || c.rationale.length === 0 || c.targets.length === 0) throw new Error("Incomplete signal candidate");
  if (c.targets.some((t) => rewardRisk(c.direction, c.entry, c.stopLoss, t) < minimum)) throw new Error("Reward/risk threshold not met");
}

export function onlyClosedCandles(candles: Candle[]): Candle[] {
  const result = candles.filter((c) => c.complete).sort((a, b) => a.closeTime - b.closeTime);
  for (let i = 1; i < result.length; i++) if (result[i]!.closeTime <= result[i - 1]!.closeTime) throw new Error("Duplicate candle close time");
  return result;
}

export function validateSignalLevels(
  direction: Direction,
  entry: number,
  stopLoss: number,
  targets: number[],
  minimumRewardRisk = 2
): { valid: boolean; reasons: string[]; rewardRisk: number[] } {
  const reasons: string[] = [];
  if (!Number.isFinite(entry) || entry <= 0) reasons.push("Entry must be positive and finite");
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) reasons.push("Stop must be positive and finite");
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss)) return { valid: false, reasons, rewardRisk: [] };
  if (direction === "LONG" && stopLoss >= entry) reasons.push("Long stop must be below entry");
  if (direction === "SHORT" && stopLoss <= entry) reasons.push("Short stop must be above entry");
  if (targets.length < 1 || targets.length > 2) reasons.push("Signal requires one or two targets");
  const ratios: number[] = [];
  for (const target of targets) {
    if (!Number.isFinite(target) || target <= 0) {
      reasons.push("Target must be positive and finite");
      continue;
    }
    try {
      const ratio = rewardRisk(direction, entry, stopLoss, target);
      ratios.push(ratio);
      if (ratio < minimumRewardRisk) reasons.push("Target below minimum reward/risk");
    } catch {
      reasons.push("Target is on the invalid side of entry");
    }
  }
  if (ratios.length > 1 && ratios[1]! < ratios[0]!) reasons.push("Targets must be ordered by distance");
  return { valid: reasons.length === 0, reasons, rewardRisk: ratios };
}

export function pricePrecisionFor(symbol: string): number {
  if (symbol.includes("_")) {
    if (symbol.endsWith("_JPY")) return 3;
    if (symbol.startsWith("XAU")) return 2;
    return 5;
  }
  if (/^(BTC|ETH|BNB|LTC|BCH)/.test(symbol)) return 2;
  if (/^(SOL|AVAX|LINK|DOT|UNI|NEAR|APT|ARB|OP|TON|SUI)/.test(symbol)) return 4;
  return 5;
}

export function formatPrice(symbol: string, price: number): string {
  if (!Number.isFinite(price)) throw new Error("Cannot format a non-finite price");
  return price.toFixed(pricePrecisionFor(symbol));
}

export type ScoreFactors = {
  trendAlignment: number;
  marketStructure: number;
  momentum: number;
  volumeConfirmation: number;
  supportResistance: number;
  volatilitySuitability: number;
  riskReward: number;
  entryQuality: number;
};
export type ScoreWeights = ScoreFactors;
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  trendAlignment: 0.2,
  marketStructure: 0.15,
  momentum: 0.12,
  volumeConfirmation: 0.1,
  supportResistance: 0.1,
  volatilitySuitability: 0.08,
  riskReward: 0.15,
  entryQuality: 0.1
};
export const SCORE_FORMULA_VERSION = "quality-v1";

export function scoreOpportunity(
  factors: Partial<ScoreFactors>,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS
): { score: number; breakdown: ScoreFactors; formulaVersion: string } {
  const keys = Object.keys(DEFAULT_SCORE_WEIGHTS) as Array<keyof ScoreFactors>;
  const breakdown = {} as ScoreFactors;
  let total = 0;
  let weightTotal = 0;
  for (const key of keys) {
    const weight = weights[key];
    if (!Number.isFinite(weight) || weight < 0) throw new Error("Score weights must be non-negative finite numbers");
    const raw = factors[key] ?? 0;
    if (!Number.isFinite(raw)) throw new Error("Score factors must be finite numbers");
    const clamped = Math.min(1, Math.max(0, raw));
    breakdown[key] = clamped;
    total += clamped * weight;
    weightTotal += weight;
  }
  const score = weightTotal > 0 ? (total / weightTotal) * 100 : 0;
  return { score: Math.round(score * 100) / 100, breakdown, formulaVersion: SCORE_FORMULA_VERSION };
}

export * from "./indicators.js";
export * from "./risk.js";
export * from "./strategies.js";
