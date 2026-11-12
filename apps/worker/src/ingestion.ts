import { BinanceUsdMProvider, TwelveDataProvider, TwelveDataError } from "@signal-engine/market-data";
import type { CandleInterval, MarketDataProvider } from "@signal-engine/market-data";
import { ensureInstrument, latestCandleTime, persistNormalizedCandles, updateInstrumentMetadata } from "@signal-engine/database/ingestion-repository";
import { errorText } from "./format.js";

const cryptoSymbols = (process.env.CRYPTO_SYMBOLS ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,DOTUSDT,TRXUSDT,TONUSDT,SUIUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,UNIUSDT,BCHUSDT").split(",").map((value) => value.trim()).filter(Boolean);
const forexSymbols = (process.env.FOREX_SYMBOLS ?? "EUR_USD,GBP_USD,USD_JPY,EUR_JPY,XAU_USD").split(",").map((value) => value.trim()).filter(Boolean);
const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const binance = new BinanceUsdMProvider();
const twelve = new TwelveDataProvider();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type IngestionResult = { symbol: string; interval: string; inserted: number; mode: "initial" | "incremental"; error?: string; info?: string; usage?: Record<string, unknown>; due?: number; spent?: number; cap?: number; quotaExhausted?: boolean };

const FOREX_POLL_MINUTES: Record<CandleInterval, number> = {
  "1d": Number(process.env.FOREX_POLL_1D_MINUTES ?? "1440"),
  "4h": Number(process.env.FOREX_POLL_4H_MINUTES ?? "240"),
  "1h": Number(process.env.FOREX_POLL_1H_MINUTES ?? "60"),
  "15m": Number(process.env.FOREX_POLL_15M_MINUTES ?? "30"),
  "5m": Number(process.env.FOREX_POLL_5M_MINUTES ?? "60"),
  "1m": Number(process.env.FOREX_POLL_1M_MINUTES ?? "120")
};
// Order slow, signal-critical series first so a constrained credit budget keeps
// higher-timeframe candles fresh before spending on low timeframes.
const FOREX_PRIORITY: CandleInterval[] = ["1d", "4h", "1h", "15m", "5m", "1m"];
const FOREX_MAX_REQUESTS_PER_RUN = Number(process.env.FOREX_MAX_REQUESTS_PER_RUN ?? "5");
const FOREX_DAILY_CREDIT_BUDGET = Number(process.env.FOREX_DAILY_CREDIT_BUDGET ?? "640");
const FOREX_CREDIT_SAFETY_MARGIN = Number(process.env.FOREX_CREDIT_SAFETY_MARGIN ?? "80");
const FOREX_REQUEST_DELAY_MS = Number(process.env.FOREX_REQUEST_DELAY_MS ?? "8000");

async function ingestSymbol(provider: MarketDataProvider, market: string, symbol: string, report: IngestionResult[]) {
  const metadata = await provider.fetchInstrumentMetadata(symbol);
  const instrument = await ensureInstrument(provider.name, market, symbol, {
    pricePrecision: metadata.pricePrecision,
    quantityPrecision: metadata.quantityPrecision,
    available: metadata.available
  });
  await updateInstrumentMetadata(instrument.id, metadata);

  for (const interval of timeframes) {
    try {
      const latest = await latestCandleTime(instrument.id, interval);
      const rows = latest
        ? await provider.fetchCandlesRange(symbol, interval, latest.getTime() + 1, Date.now())
        : await provider.fetchCandles(symbol, interval, 300);
      const inserted = await persistNormalizedCandles(instrument.id, provider.name, rows);
      report.push({ symbol, interval, inserted, mode: latest ? "incremental" : "initial" });
    } catch (error) {
      report.push({ symbol, interval, inserted: 0, mode: "incremental", error: errorText(error) });
    }
    await delay(Number(process.env.INGESTION_REQUEST_DELAY_MS ?? "50"));
  }
}

/** Binance USD-M perpetual ingestion. Unchanged public market-data behaviour. */
export async function ingestCrypto() {
  const report: IngestionResult[] = [];
  for (const symbol of cryptoSymbols) {
    try { await ingestSymbol(binance, "crypto_perpetual", symbol, report); }
    catch (error) { report.push({ symbol, interval: "*", inserted: 0, mode: "initial", error: errorText(error) }); }
  }
  return report;
}

function isDue(latestCloseTime: Date | undefined, interval: CandleInterval, now: number): boolean {
  if (!latestCloseTime) return true;
  const pollMs = FOREX_POLL_MINUTES[interval] * 60_000;
  return now - latestCloseTime.getTime() > pollMs;
}

/**
 * Credit-aware Twelve Data ingestion.
 *
 * The configured subscription is checked through `/api_usage` and the worker
 * never spends past the self-imposed daily budget or the plan's daily limit.
 * Only series whose last stored completed candle is older than the configured
 * per-timeframe poll interval are refreshed, so unchanged history is never
 * re-downloaded. Requests are capped per run to respect the per-minute limit.
 */
export async function ingestForex() {
  const report: IngestionResult[] = [];
  if (!process.env.TWELVE_DATA_API_KEY) {
    report.push({ symbol: "*", interval: "*", inserted: 0, mode: "initial", error: "TWELVE_DATA_API_KEY missing; forex ingestion skipped" });
    return report;
  }

  let budget = FOREX_DAILY_CREDIT_BUDGET;
  let usageSummary: Record<string, unknown> | null = null;
  try {
    const usage = await twelve.getApiUsage();
    usageSummary = {
      planCategory: usage.planCategory,
      planLimitPerMinute: usage.planLimit,
      dailyUsage: usage.dailyUsage,
      planDailyLimit: usage.planDailyLimit
    };
    const planCap = (usage.planDailyLimit ?? Number.POSITIVE_INFINITY) - FOREX_CREDIT_SAFETY_MARGIN;
    const used = usage.dailyUsage ?? 0;
    budget = Math.min(FOREX_DAILY_CREDIT_BUDGET, planCap) - used;
  } catch (error) {
    report.push({ symbol: "*", interval: "*", inserted: 0, mode: "incremental", error: `usage check failed: ${errorText(error)}` });
  }
  if (budget <= 0) {
    report.push({ symbol: "*", interval: "*", inserted: 0, mode: "incremental", error: "Twelve Data daily credit budget/safety margin reached; forex ingestion paused", ...(usageSummary ? { usage: usageSummary } : {}) });
    return report;
  }

  const now = Date.now();
  const due: Array<{ symbol: string; interval: CandleInterval; instrumentId: string; latest?: Date }> = [];
  for (const symbol of forexSymbols) {
    try {
      const instrument = await ensureInstrument(twelve.name, "forex", symbol);
      for (const interval of FOREX_PRIORITY) {
        const latest = await latestCandleTime(instrument.id, interval);
        if (isDue(latest, interval, now)) due.push({ symbol, interval, instrumentId: instrument.id, ...(latest ? { latest } : {}) });
      }
    } catch (error) {
      report.push({ symbol, interval: "*", inserted: 0, mode: "initial", error: errorText(error) });
    }
  }

  const cap = Math.max(1, Math.min(FOREX_MAX_REQUESTS_PER_RUN, Math.floor(budget)));
  let spent = 0;
  for (const item of due) {
    if (spent >= cap) break;
    try {
      const rows = item.latest
        ? await twelve.fetchCandlesRange(item.symbol, item.interval, item.latest.getTime() + 1, now)
        : await twelve.fetchCandles(item.symbol, item.interval, 300);
      spent += 1; // one /time_series request per series refresh
      const inserted = await persistNormalizedCandles(item.instrumentId, twelve.name, rows);
      report.push({ symbol: item.symbol, interval: item.interval, inserted, mode: item.latest ? "incremental" : "initial" });
    } catch (error) {
      if (error instanceof TwelveDataError && (error.code === 429 || /quota|limit|credits/i.test(error.message))) {
        report.push({ symbol: item.symbol, interval: item.interval, inserted: 0, mode: "incremental", error: errorText(error), quotaExhausted: true });
        break;
      }
      report.push({ symbol: item.symbol, interval: item.interval, inserted: 0, mode: "incremental", error: errorText(error) });
    }
    await delay(FOREX_REQUEST_DELAY_MS);
  }
  if (usageSummary) report.unshift({ symbol: "*", interval: "*", inserted: 0, mode: "incremental", info: "usage", usage: usageSummary, due: due.length, spent, cap });
  return report;
}

/** Legacy aggregate entry point: crypto plus a single credit-aware forex pass. */
export async function ingestAll() {
  const cryptoReport = await ingestCrypto();
  const forexReport = await ingestForex();
  return [...cryptoReport, ...forexReport];
}

export { cryptoSymbols, forexSymbols, FOREX_POLL_MINUTES };
