import { BinanceUsdMProvider } from "@signal-engine/market-data";
import { OandaV20Provider } from "@signal-engine/market-data/oanda";
import { ensureInstrument, latestCandleTime, persistNormalizedCandles, updateInstrumentMetadata } from "@signal-engine/database/ingestion-repository";
import type { MarketDataProvider } from "@signal-engine/market-data";

const cryptoSymbols = (process.env.CRYPTO_SYMBOLS ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,DOTUSDT,TRXUSDT,TONUSDT,SUIUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,UNIUSDT,BCHUSDT").split(",").map((value) => value.trim()).filter(Boolean);
const forexSymbols = (process.env.FOREX_SYMBOLS ?? "EUR_USD,GBP_USD,USD_JPY,EUR_JPY,XAU_USD").split(",").map((value) => value.trim()).filter(Boolean);
const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const binance = new BinanceUsdMProvider();
const oanda = new OandaV20Provider();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type IngestionResult = { symbol: string; interval: string; inserted: number; mode: "initial" | "incremental"; error?: string };

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
      report.push({ symbol, interval, inserted: 0, mode: "incremental", error: error instanceof Error ? error.message : "unknown error" });
    }
    await delay(Number(process.env.INGESTION_REQUEST_DELAY_MS ?? "50"));
  }
}

export async function ingestAll() {
  const report: IngestionResult[] = [];
  for (const symbol of cryptoSymbols) {
    try { await ingestSymbol(binance, "crypto_perpetual", symbol, report); }
    catch (error) { report.push({ symbol, interval: "*", inserted: 0, mode: "initial", error: error instanceof Error ? error.message : "unknown error" }); }
  }
  if (!process.env.OANDA_API_TOKEN) {
    report.push({ symbol: "*", interval: "*", inserted: 0, mode: "initial", error: "OANDA_API_TOKEN missing; forex ingestion skipped" });
  } else {
    for (const symbol of forexSymbols) {
      try { await ingestSymbol(oanda, "forex", symbol, report); }
      catch (error) { report.push({ symbol, interval: "*", inserted: 0, mode: "initial", error: error instanceof Error ? error.message : "unknown error" }); }
    }
  }
  return report;
}
