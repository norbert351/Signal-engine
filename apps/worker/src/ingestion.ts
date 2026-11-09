import { BinanceUsdMProvider } from "@signal-engine/market-data";
import { OandaV20Provider } from "@signal-engine/market-data/oanda";
import { ensureInstrument, persistNormalizedCandles } from "@signal-engine/database/ingestion-repository";

const cryptoSymbols = (process.env.CRYPTO_SYMBOLS ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,DOTUSDT,TRXUSDT,TONUSDT,SUIUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT,UNIUSDT,BCHUSDT").split(",").map(s => s.trim()).filter(Boolean);
const forexSymbols = (process.env.FOREX_SYMBOLS ?? "EUR_USD,GBP_USD,USD_JPY,EUR_JPY,XAU_USD").split(",").map(s => s.trim()).filter(Boolean);
const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const binance = new BinanceUsdMProvider();
const oanda = new OandaV20Provider();

export async function ingestAll() {
  const report: { symbol: string; interval: string; inserted: number; error?: string }[] = [];
  for (const [provider, market, symbols] of [[binance, "crypto_perpetual", cryptoSymbols], [oanda, "forex", forexSymbols]] as const) {
    for (const symbol of symbols) {
      for (const interval of timeframes) {
        try {
          const rows = await provider.fetchCandles(symbol, interval, 300);
          const instrument = await ensureInstrument(provider.name, market, symbol);
          const inserted = await persistNormalizedCandles(instrument.id, provider.name, rows);
          report.push({ symbol, interval, inserted });
        } catch (error) {
          report.push({ symbol, interval, inserted: 0, error: error instanceof Error ? error.message : "unknown error" });
        }
      }
    }
  }
  return report;
}
