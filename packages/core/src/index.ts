export type Direction = "LONG" | "SHORT";
export type Candle = { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; complete: boolean };
export type SignalCandidate = { direction: Direction; entry: number; stopLoss: number; targets: number[]; timeframe: string; rationale: string[] };
export function validateCandle(c: Candle): void {
 const v = [c.open,c.high,c.low,c.close];
 if (!v.every(Number.isFinite) || v.some(x => x <= 0)) throw new Error("OHLC values must be finite and positive");
 if (c.high < Math.max(c.open,c.close,c.low) || c.low > Math.min(c.open,c.close,c.high)) throw new Error("Invalid OHLC bounds");
 if (c.closeTime <= c.openTime) throw new Error("Invalid candle time range");
}
export function ema(values: number[], period: number): number[] {
 if (!Number.isInteger(period) || period < 1) throw new Error("period must be positive");
 if (values.length < period) return [];
 const alpha = 2 / (period + 1); let current = values.slice(0,period).reduce((a,b)=>a+b,0)/period;
 const out = [current]; for (const value of values.slice(period)) { current = value*alpha + current*(1-alpha); out.push(current); } return out;
}
export function rewardRisk(direction: Direction, entry: number, stop: number, target: number): number {
 const risk = direction === "LONG" ? entry-stop : stop-entry;
 const reward = direction === "LONG" ? target-entry : entry-target;
 if (risk <= 0 || reward <= 0) throw new Error("Invalid directional price levels");
 return reward/risk;
}
export function validateCandidate(c: SignalCandidate, minimum = 2): void {
 if (!c.timeframe || c.rationale.length === 0 || c.targets.length === 0) throw new Error("Incomplete signal candidate");
 if (c.targets.some(t => rewardRisk(c.direction,c.entry,c.stopLoss,t) < minimum)) throw new Error("Reward/risk threshold not met");
}
export function onlyClosedCandles(candles: Candle[]): Candle[] {
 const result = candles.filter(c => c.complete).sort((a,b)=>a.closeTime-b.closeTime);
 for (let i=1;i<result.length;i++) if (result[i]!.closeTime <= result[i-1]!.closeTime) throw new Error("Duplicate candle close time");
 return result;
}
