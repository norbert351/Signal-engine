import { BinanceUsdMProvider } from "@signal-engine/market-data";
import { OandaV20Provider } from "@signal-engine/market-data/oanda";
import { ensureInstrument, persistNormalizedCandles } from "@signal-engine/database/ingestion-repository";

const crypto = (process.env.CRYPTO_SYMBOLS ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,DOTUSDT,TRXUSDT,TONUSDT,SUIUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,UNIUSDT,BCHUSDT").split(",").map(x => x.trim()).filter(Boolean);
const forex = (process.env.FOREX_SYMBOLS ?? "EUR_USD,GBP_USD,USD_JPY,EUR_JPY,XAU_USD").split(",").map(x => x.trim()).filter(Boolean);
const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

export async function backfillHistory() {
  const start = Date.parse(process.env.BACKFILL_START ?? "");
  const end = Date.parse(process.env.BACKFILL_END ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("Set valid BACKFILL_START and BACKFILL_END ISO timestamps");
  const binance = new BinanceUsdMProvider();
  const oanda = new OandaV20Provider();
  const results: { symbol: string; interval: string; inserted: number; provider: string }[] = [];
  for (const [provider, market, symbols] of [[binance, "crypto_perpetual", crypto], [oanda, "forex", forex]] as const) {
    for (const symbol of symbols) {
      for (const interval of timeframes) {
        const rows = await provider.fetchCandlesRange(symbol, interval, start, end);
        const instrument = await ensureInstrument(provider.name, market, symbol);
        const inserted = await persistNormalizedCandles(instrument.id, provider.name, rows);
        results.push({ symbol, interval, inserted, provider: provider.name });
      }
    }
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), results };
}
