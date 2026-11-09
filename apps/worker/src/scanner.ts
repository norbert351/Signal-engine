import { evaluateEmaPullback, evaluateBreakoutRetest } from "@signal-engine/core/strategies";
import { validateRisk } from "@signal-engine/core/risk";
import { findEnabledStrategies, findInstrument, readRecentCandles, publishSignal } from "@signal-engine/database/scanner-repository";
import type { Candle } from "@signal-engine/core";

type CandleRow = { openTime: Date; closeTime: Date; open: string; high: string; low: string; close: string; isComplete: boolean };
const toCore = (rows: CandleRow[]): Candle[] => rows.map(r => ({
  openTime: r.openTime.getTime(), closeTime: r.closeTime.getTime(),
  open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), complete: r.isComplete
}));

const scanPlans = [
  { timeframe: "1m", trendTimeframe: "5m", style: "scalping", maxEntryAgeMs: 3 * 60_000, maxTrendAgeMs: 15 * 60_000, expiryMs: 15 * 60_000 },
  { timeframe: "5m", trendTimeframe: "15m", style: "scalping", maxEntryAgeMs: 15 * 60_000, maxTrendAgeMs: 45 * 60_000, expiryMs: 30 * 60_000 },
  { timeframe: "15m", trendTimeframe: "1h", style: "intraday", maxEntryAgeMs: 45 * 60_000, maxTrendAgeMs: 3 * 60 * 60_000, expiryMs: 3 * 60 * 60_000 },
  { timeframe: "1h", trendTimeframe: "4h", style: "intraday", maxEntryAgeMs: 3 * 60 * 60_000, maxTrendAgeMs: 12 * 60 * 60_000, expiryMs: 12 * 60 * 60_000 },
  { timeframe: "4h", trendTimeframe: "1d", style: "swing", maxEntryAgeMs: 12 * 60 * 60_000, maxTrendAgeMs: 36 * 60 * 60_000, expiryMs: 48 * 60 * 60_000 }
] as const;

export async function processScan() {
  const strategies = await findEnabledStrategies();
  if (!strategies.length) return { instruments: 25, evaluated: 0, published: 0, reason: "no_enabled_strategies" };

  const crypto = (process.env.CRYPTO_SYMBOLS ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,DOTUSDT,TRXUSDT,TONUSDT,SUIUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,UNIUSDT,BCHUSDT").split(",").map(x => x.trim()).filter(Boolean);
  const forex = (process.env.FOREX_SYMBOLS ?? "EUR_USD,GBP_USD,USD_JPY,EUR_JPY,XAU_USD").split(",").map(x => x.trim()).filter(Boolean);
  const symbols = [...crypto, ...forex];
  let evaluated = 0, published = 0, skippedStale = 0, missingInstruments = 0;

  for (const symbol of symbols) {
    const provider = symbol.includes("_") ? "oanda_v20" : "binance_usdm";
    const instrument = await findInstrument(provider, symbol);
    if (!instrument) { missingInstruments++; continue; }

    for (const plan of scanPlans) {
      const [entryRows, trendRows] = await Promise.all([
        readRecentCandles(instrument.id, plan.timeframe, 350),
        readRecentCandles(instrument.id, plan.trendTimeframe, 350)
      ]);
      const entry = toCore(entryRows), trend = toCore(trendRows);
      if (entry.length < 60 || trend.length < 60) { skippedStale++; continue; }
      const latestEntry = entry[entry.length - 1]!, latestTrend = trend[trend.length - 1]!;
      const now = Date.now();
      if (!latestEntry.complete || !latestTrend.complete || now - latestEntry.closeTime > plan.maxEntryAgeMs || now - latestTrend.closeTime > plan.maxTrendAgeMs) { skippedStale++; continue; }

      for (const strategy of strategies) {
        const params = (strategy.parameters ?? {}) as Parameters<typeof evaluateEmaPullback>[1];
        const context = { symbol, timeframe: plan.timeframe, entryCandles: entry, trendCandles: trend };
        const result = strategy.key === "ema-trend-pullback"
          ? evaluateEmaPullback(context, params)
          : strategy.key === "range-breakout-retest"
            ? evaluateBreakoutRetest(context, params)
            : undefined;
        if (!result) continue;
        evaluated++;

        const risk = (strategy.riskConfig ?? {}) as { minimumRewardRisk?: number; maximumStopDistancePct?: number; maxTargets?: number };
        const policy = validateRisk(result.direction, result.candidate.entry, result.candidate.stopLoss, result.candidate.targets, {
          minimumRewardRisk: risk.minimumRewardRisk ?? 2,
          maximumStopDistancePct: risk.maximumStopDistancePct ?? 5,
          maxTargets: risk.maxTargets ?? 3
        });
        if (!policy.valid || policy.rewardRisk.length === 0) continue;

        const trigger = new Date(result.triggerCloseTime);
        const signal = await publishSignal({
          dedupeKey: `${symbol}:${plan.timeframe}:${strategy.key}:v${strategy.version}:${result.triggerCloseTime}`,
          instrumentId: instrument.id, strategyConfigId: strategy.id, market: instrument.market,
          symbol, direction: result.direction, entry: result.candidate.entry,
          stop: result.candidate.stopLoss, targets: result.candidate.targets,
          rr: policy.rewardRisk[0]!, timeframe: plan.timeframe,
          rationale: [`Trading style: ${plan.style}`, `Strategy: ${strategy.name}`, ...result.candidate.rationale],
          publishedAt: new Date(), expiresAt: new Date(trigger.getTime() + plan.expiryMs)
        });
        if (signal) published++;
      }
    }
  }
  return { instruments: symbols.length, evaluated, published, skippedStale, missingInstruments };
}
