export type Market = "crypto_perpetual" | "forex";
export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type NormalizedCandle = { provider: string; market: Market; symbol: string; interval: CandleInterval; openTime: Date; closeTime: Date; open: string; high: string; low: string; close: string; volume: string | null; complete: boolean };
export interface MarketDataProvider { readonly name: string; fetchCandles(symbol: string, interval: CandleInterval, limit?: number): Promise<NormalizedCandle[]>; }

const intervalMs: Record<CandleInterval, number> = { "1m":60000, "5m":300000, "15m":900000, "1h":3600000, "4h":14400000, "1d":86400000 };
export class BinanceUsdMProvider implements MarketDataProvider {
 readonly name = "binance_usdm";
 constructor(private readonly baseUrl = process.env.BINANCE_BASE_URL ?? "https://fapi.binance.com") {}
 async fetchCandles(symbol: string, interval: CandleInterval, limit = 500): Promise<NormalizedCandle[]> {
  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) throw new Error("Invalid Binance symbol");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new Error("limit must be 1..1500");
  const url = new URL("/fapi/v1/klines", this.baseUrl);
  url.searchParams.set("symbol",symbol); url.searchParams.set("interval",interval); url.searchParams.set("limit",String(limit));
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Binance market data request failed: HTTP " + response.status);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("Unexpected Binance kline payload");
  const now = Date.now();
  return rows.map((row: unknown) => {
   if (!Array.isArray(row) || row.length < 6) throw new Error("Malformed Binance kline");
   const openMs = Number(row[0]); const closeMs = Number(row[6] ?? (openMs + intervalMs[interval] - 1));
   return { provider:this.name, market:"crypto_perpetual" as const, symbol, interval, openTime:new Date(openMs), closeTime:new Date(closeMs), open:String(row[1]), high:String(row[2]), low:String(row[3]), close:String(row[4]), volume:String(row[5]), complete:closeMs < now };
  });
 }
}
