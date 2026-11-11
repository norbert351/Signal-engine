import { evaluateStrategy, resolveStrategyConfig, scoreOpportunity, validateRisk, type Candle, type StrategyConfig } from "@signal-engine/core";
import { findEnabledStrategies, findInstrument, publishSignal, readRecentCandles } from "@signal-engine/database/scanner-repository";
import { openSignalConflicts } from "@signal-engine/database/system-repository";
import { formatSignalMessage } from "./format.js";

type CandleRow = { openTime: Date; closeTime: Date; open: string; high: string; low: string; close: string; isComplete: boolean };
const toCore = (rows: CandleRow[]): Candle[] =>
  rows.map((row) => ({
    openTime: row.openTime.getTime(),
    closeTime: row.closeTime.getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    complete: row.isComplete
  }));

const scanPlans = [
  { timeframe: "1m", confirmationTimeframe: "5m", style: "scalping", maxEntryAgeMs: 3 * 60_000, maxTrendAgeMs: 15 * 60_000, expiryMs: 15 * 60_000 },
  { timeframe: "5m", confirmationTimeframe: "15m", style: "scalping", maxEntryAgeMs: 15 * 60_000, maxTrendAgeMs: 45 * 60_000, expiryMs: 30 * 60_000 },
  { timeframe: "15m", confirmationTimeframe: "1h", style: "intraday", maxEntryAgeMs: 45 * 60_000, maxTrendAgeMs: 3 * 60 * 60_000, expiryMs: 3 * 60 * 60_000 },
  { timeframe: "1h", confirmationTimeframe: "4h", style: "intraday", maxEntryAgeMs: 3 * 60 * 60_000, maxTrendAgeMs: 12 * 60 * 60_000, expiryMs: 12 * 60 * 60_000 },
  { timeframe: "4h", confirmationTimeframe: "1d", style: "swing", maxEntryAgeMs: 12 * 60 * 60_000, maxTrendAgeMs: 36 * 60 * 60_000, expiryMs: 48 * 60 * 60_000 }
] as const;

const crypto = (process.env.CRYPTO_SYMBOLS ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,DOTUSDT,TRXUSDT,TONUSDT,SUIUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,UNIUSDT,BCHUSDT")
  .split(",").map((value) => value.trim()).filter(Boolean);
const forex = (process.env.FOREX_SYMBOLS ?? "EUR_USD,GBP_USD,USD_JPY,EUR_JPY,XAU_USD")
  .split(",").map((value) => value.trim()).filter(Boolean);
const symbols = [...crypto, ...forex];

export async function processScan() {
  const strategies = await findEnabledStrategies();
  if (!strategies.length) return { instruments: symbols.length, evaluated: 0, published: 0, reason: "no_enabled_strategies" };

  let evaluated = 0;
  let published = 0;
  let skippedStale = 0;
  let missingInstruments = 0;
  let rejected = 0;
  let unavailable = 0;
  let conflicts = 0;

  for (const symbol of symbols) {
    const provider = symbol.includes("_") ? "oanda_v20" : "binance_usdm";
    const instrument = await findInstrument(provider, symbol);
    if (!instrument) { missingInstruments++; continue; }
    if (!instrument.enabled || !instrument.available) { unavailable++; continue; }

    for (const plan of scanPlans) {
      const [entryRows, trendRows] = await Promise.all([
        readRecentCandles(instrument.id, plan.timeframe, 350),
        readRecentCandles(instrument.id, plan.confirmationTimeframe, 350)
      ]);
      const entry = toCore(entryRows);
      const trend = toCore(trendRows);
      if (entry.length < 60 || trend.length < 60) { skippedStale++; continue; }
      const latestEntry = entry[entry.length - 1]!;
      const latestTrend = trend[trend.length - 1]!;
      const now = Date.now();
      if (!latestEntry.complete || !latestTrend.complete || now - latestEntry.closeTime > plan.maxEntryAgeMs || now - latestTrend.closeTime > plan.maxTrendAgeMs) {
        skippedStale++;
        continue;
      }

      for (const strategy of strategies) {
        const parameters = (strategy.parameters ?? {}) as Partial<StrategyConfig>;
        let config: StrategyConfig;
        try { config = resolveStrategyConfig(parameters); } catch { rejected++; continue; }
        const result = evaluateStrategy(strategy.key, { symbol, timeframe: plan.timeframe, entryCandles: entry, trendCandles: trend }, parameters);
        if (!result) continue;
        evaluated++;

        const risk = (strategy.riskConfig ?? {}) as { minimumRewardRisk?: number; maximumStopDistancePct?: number; maxTargets?: number };
        const policy = validateRisk(result.direction, result.candidate.entry, result.candidate.stopLoss, result.candidate.targets, {
          minimumRewardRisk: risk.minimumRewardRisk ?? config.minRewardRisk,
          maximumStopDistancePct: risk.maximumStopDistancePct ?? 5,
          maxTargets: risk.maxTargets ?? 2
        });
        if (!policy.valid || policy.rewardRisk.length === 0) { rejected++; continue; }
        const conflicting = await openSignalConflicts(symbol, plan.timeframe, result.direction, new Date(Date.now() - plan.expiryMs));
        if (conflicting.length) { conflicts++; continue; }

        const quality = scoreOpportunity(result.scoreFactors);
        const trigger = new Date(result.triggerCloseTime);
        const expiresAt = new Date(trigger.getTime() + plan.expiryMs);
        const publishedAt = new Date();
        const rationale = [`Trading style: ${plan.style}`, `Strategy: ${result.strategyName}`, ...result.candidate.rationale];
        const message = formatSignalMessage({
          symbol,
          market: instrument.market,
          direction: result.direction,
          timeframe: plan.timeframe,
          tradingStyle: plan.style,
          confirmationTimeframe: plan.confirmationTimeframe,
          strategyName: result.strategyName,
          entry: result.candidate.entry,
          stop: result.candidate.stopLoss,
          targets: result.candidate.targets.map((price, index) => ({ price: String(price), allocationPct: index === 0 ? 50 : 50 })),
          rewardRisk: String(policy.rewardRisk[0]),
          qualityScore: String(quality.score),
          rationale,
          invalidation: result.candidate.invalidation,
          expiresAt
        });

        const signal = await publishSignal({
          dedupeKey: `${symbol}:${plan.timeframe}:${strategy.key}:v${strategy.version}:${result.triggerCloseTime}`,
          instrumentId: instrument.id,
          strategyConfigId: strategy.id,
          market: instrument.market,
          symbol,
          direction: result.direction,
          entry: result.candidate.entry,
          stop: result.candidate.stopLoss,
          targets: result.candidate.targets,
          rr: policy.rewardRisk[0]!,
          timeframe: plan.timeframe,
          tradingStyle: plan.style,
          confirmationTimeframe: plan.confirmationTimeframe,
          strategyKey: strategy.key,
          strategyVersion: strategy.version,
          qualityScore: quality.score,
          qualityFactors: quality.breakdown,
          scoreFormulaVersion: quality.formulaVersion,
          invalidation: result.candidate.invalidation,
          rationale,
          publishedAt,
          expiresAt,
          message
        });
        if (signal) published++;
      }
    }
  }
  return { instruments: symbols.length, evaluated, published, skippedStale, missingInstruments, unavailable, rejected, conflicts };
}
