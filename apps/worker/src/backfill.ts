import { errorText } from "./format.js";
import { BinanceUsdMProvider, TwelveDataProvider, normalizeCandles } from "@signal-engine/market-data";
import type { CandleInterval, MarketDataProvider } from "@signal-engine/market-data";
import {
  claimBackfillRequests,
  ensureInstrument,
  getOrCreateBackfill,
  persistNormalizedCandles,
  updateBackfill
} from "@signal-engine/database/ingestion-repository";
import type { backfillProgress } from "@signal-engine/database";

const crypto = (process.env.CRYPTO_SYMBOLS ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,DOTUSDT,TRXUSDT,TONUSDT,SUIUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,UNIUSDT,BCHUSDT").split(",").map((value) => value.trim()).filter(Boolean);
const forex = (process.env.FOREX_SYMBOLS ?? "EUR_USD,GBP_USD,USD_JPY,EUR_JPY,XAU_USD").split(",").map((value) => value.trim()).filter(Boolean);
const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const CHUNK_MS = Number(process.env.BACKFILL_CHUNK_DAYS ?? "30") * 86_400_000;

type BackfillRow = typeof backfillProgress.$inferSelect;

function providerFor(row: BackfillRow): { provider: MarketDataProvider; market: string } {
  if (row.provider === "twelve_data") {
    if (!process.env.TWELVE_DATA_API_KEY) throw new Error("TWELVE_DATA_API_KEY is not configured");
    return { provider: new TwelveDataProvider(), market: "forex" };
  }
  if (row.provider === "binance_usdm") return { provider: new BinanceUsdMProvider(), market: "crypto_perpetual" };
  throw new Error(`Unsupported provider ${row.provider}`);
}

async function runBackfillJob(row: BackfillRow) {
  const { provider, market } = providerFor(row);
  const instrument = await ensureInstrument(row.provider, market, row.symbol);
  let cursor = row.cursorTime.getTime();
  const end = row.endTime.getTime();
  let inserted = 0;
  try {
    while (cursor < end) {
      const chunkEnd = Math.min(end, cursor + CHUNK_MS);
      const rows = normalizeCandles(await provider.fetchCandlesRange(row.symbol, row.timeframe as CandleInterval, cursor, chunkEnd));
      const written = await persistNormalizedCandles(instrument.id, row.provider, rows);
      inserted += written;
      cursor = chunkEnd;
      await updateBackfill(row.id, { cursorTime: new Date(cursor), candlesSeen: rows.length, candlesWritten: written, status: "running" });
    }
    await updateBackfill(row.id, { status: "complete", cursorTime: new Date(end) });
    return { id: row.id, provider: row.provider, symbol: row.symbol, interval: row.timeframe, inserted, status: "complete" as const };
  } catch (error) {
    const message = errorText(error, "Backfill failed");
    await updateBackfill(row.id, { status: "failed", lastError: message });
    return { id: row.id, provider: row.provider, symbol: row.symbol, interval: row.timeframe, inserted, status: "failed" as const, error: message };
  }
}

export async function processBackfillRequests(limit = Number(process.env.BACKFILL_JOBS_PER_RUN ?? "2")) {
  const rows = await claimBackfillRequests(limit);
  const results = [];
  for (const row of rows) results.push(await runBackfillJob(row));
  return { claimed: rows.length, results };
}

export async function backfillHistory() {
  const start = Date.parse(process.env.BACKFILL_START ?? "");
  const end = Date.parse(process.env.BACKFILL_END ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("Set valid BACKFILL_START and BACKFILL_END ISO timestamps");
  const binance = new BinanceUsdMProvider();
  const twelve = new TwelveDataProvider();
  const results: Array<{ provider: string; symbol: string; interval: string; inserted: number; status: string; error?: string }> = [];
  const plans: Array<[MarketDataProvider, string, string[]]> = [[binance, "crypto_perpetual", crypto]];
  if (process.env.TWELVE_DATA_API_KEY) {
    let remaining: number | null = null;
    try {
      const usage = await twelve.getApiUsage();
      const planCap = usage.planDailyLimit ?? Number.POSITIVE_INFINITY;
      remaining = Math.min(Number(process.env.FOREX_DAILY_CREDIT_BUDGET ?? "640"), planCap) - (usage.dailyUsage ?? 0);
    } catch {
      remaining = null;
    }
    if (remaining !== null && remaining < 50) {
      results.push({ provider: "twelve_data", symbol: "*", interval: "*", inserted: 0, status: "skipped", error: `insufficient Twelve Data credits remaining (${remaining}); forex backfill not started` });
    } else {
      plans.push([twelve, "forex", forex]);
    }
  }

  for (const [provider, market, symbols] of plans) {
    for (const symbol of symbols) {
      const instrument = await ensureInstrument(provider.name, market, symbol);
      for (const interval of timeframes) {
        const progress = await getOrCreateBackfill({ provider: provider.name, symbol, timeframe: interval, startTime: new Date(start), endTime: new Date(end) });
        if (progress.status === "complete") {
          results.push({ provider: provider.name, symbol, interval, inserted: 0, status: "already_complete" });
          continue;
        }
        const outcome = await runBackfillJob(progress);
        results.push({ provider: provider.name, symbol, interval, inserted: outcome.inserted, status: outcome.status, ...(outcome.status === "failed" ? { error: outcome.error } : {}) });
      }
    }
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), results };
}
