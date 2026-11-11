import { fetchWithRetry } from "./http.js";
import { normalizeCandles, validateNormalizedCandle } from "./validation.js";

export type Market = "crypto_perpetual" | "forex";
export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type NormalizedCandle = {
  provider: string;
  market: Market;
  symbol: string;
  interval: CandleInterval;
  openTime: Date;
  closeTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  complete: boolean;
};
export type InstrumentMetadata = {
  provider: string;
  symbol: string;
  market: Market;
  available: boolean;
  status: string;
  contractType?: string;
  pricePrecision: number;
  quantityPrecision: number;
  minQuantity?: string;
  tickSize?: string;
};
export interface MarketDataProvider {
  readonly name: string;
  fetchCandles(symbol: string, interval: CandleInterval, limit?: number): Promise<NormalizedCandle[]>;
  fetchCandlesRange(symbol: string, interval: CandleInterval, startTime: number, endTime: number): Promise<NormalizedCandle[]>;
  fetchInstrumentMetadata(symbol: string): Promise<InstrumentMetadata>;
}

export const SUPPORTED_INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const intervalMs: Record<CandleInterval, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

export class BinanceUsdMProvider implements MarketDataProvider {
  readonly name = "binance_usdm";
  constructor(private readonly baseUrl = process.env.BINANCE_BASE_URL ?? "https://fapi.binance.com") {}

  async fetchInstrumentMetadata(symbol: string): Promise<InstrumentMetadata> {
    if (!/^[A-Z0-9]{4,20}$/.test(symbol)) throw new Error("Invalid Binance symbol");
    const url = new URL("/fapi/v1/exchangeInfo", this.baseUrl);
    const response = await fetchWithRetry(url, { accept: "application/json" }, 15_000);
    if (!response.ok) throw new Error(`Binance exchange info request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { symbols?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.symbols)) throw new Error("Unexpected Binance exchange info payload");
    const entry = body.symbols.find((item) => item.symbol === symbol);
    if (!entry) return { provider: this.name, symbol, market: "crypto_perpetual", available: false, status: "NOT_LISTED", pricePrecision: 2, quantityPrecision: 0 };
    const filters = Array.isArray(entry.filters) ? (entry.filters as Array<Record<string, unknown>>) : [];
    const priceFilter = filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const lotFilter = filters.find((filter) => filter.filterType === "LOT_SIZE");
    return {
      provider: this.name,
      symbol,
      market: "crypto_perpetual",
      available: entry.status === "TRADING" && entry.contractType === "PERPETUAL",
      status: String(entry.status ?? "UNKNOWN"),
      contractType: String(entry.contractType ?? "UNKNOWN"),
      pricePrecision: Number(entry.pricePrecision ?? 2),
      quantityPrecision: Number(entry.quantityPrecision ?? 0),
      ...(priceFilter && typeof priceFilter.tickSize === "string" ? { tickSize: priceFilter.tickSize } : {}),
      ...(lotFilter && typeof lotFilter.minQty === "string" ? { minQuantity: lotFilter.minQty } : {})
    };
  }

  async fetchCandles(symbol: string, interval: CandleInterval, limit = 500): Promise<NormalizedCandle[]> {
    if (!/^[A-Z0-9]{4,20}$/.test(symbol)) throw new Error("Invalid Binance symbol");
    if (!(interval in intervalMs)) throw new Error("Unsupported Binance interval");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new Error("limit must be 1..1500");
    const url = new URL("/fapi/v1/klines", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));
    return this.requestCandles(url, symbol, interval);
  }

  async fetchCandlesSince(symbol: string, interval: CandleInterval, since: number, limit = 1500): Promise<NormalizedCandle[]> {
    if (!Number.isFinite(since) || since < 0) throw new Error("Invalid since timestamp");
    if (!(interval in intervalMs)) throw new Error("Unsupported Binance interval");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new Error("limit must be 1..1500");
    const url = new URL("/fapi/v1/klines", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(since));
    url.searchParams.set("limit", String(limit));
    return this.requestCandles(url, symbol, interval);
  }

  private async requestCandles(url: URL, symbol: string, interval: CandleInterval): Promise<NormalizedCandle[]> {
    const response = await fetchWithRetry(url, { accept: "application/json" }, 10_000);
    if (!response.ok) throw new Error(`Binance market data request failed: HTTP ${response.status}`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("Unexpected Binance kline payload");
    const now = Date.now();
    const candles = rows.map((row: unknown) => {
      if (!Array.isArray(row) || row.length < 7) throw new Error("Malformed Binance kline");
      const openMs = Number(row[0]);
      const closeMs = Number(row[6]);
      if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || closeMs <= openMs) throw new Error("Malformed Binance kline timestamps");
      const candle: NormalizedCandle = {
        provider: this.name,
        market: "crypto_perpetual",
        symbol,
        interval,
        openTime: new Date(openMs),
        closeTime: new Date(closeMs),
        open: String(row[1]),
        high: String(row[2]),
        low: String(row[3]),
        close: String(row[4]),
        volume: String(row[5]),
        complete: closeMs < now
      };
      validateNormalizedCandle(candle);
      return candle;
    });
    return normalizeCandles(candles);
  }

  async fetchCandlesRange(symbol: string, interval: CandleInterval, startTime: number, endTime: number): Promise<NormalizedCandle[]> {
    if (!/^[A-Z0-9]{4,20}$/.test(symbol)) throw new Error("Invalid Binance symbol");
    if (!(interval in intervalMs)) throw new Error("Unsupported Binance interval");
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) throw new Error("Invalid historical range");
    const output: NormalizedCandle[] = [];
    let cursor = startTime;
    let pages = 0;
    while (cursor < endTime && pages < 1000) {
      const url = new URL("/fapi/v1/klines", this.baseUrl);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("startTime", String(cursor));
      url.searchParams.set("endTime", String(endTime));
      url.searchParams.set("limit", "1500");
      const response = await fetchWithRetry(url, { accept: "application/json" }, 15_000);
      if (!response.ok) throw new Error(`Binance historical request failed: HTTP ${response.status}`);
      const rows: unknown = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      const now = Date.now();
      for (const row of rows as unknown[][]) {
        if (row.length < 7) continue;
        const openMs = Number(row[0]);
        const closeMs = Number(row[6]);
        if (openMs < startTime || openMs >= endTime) continue;
        const candle: NormalizedCandle = {
          provider: this.name,
          market: "crypto_perpetual",
          symbol,
          interval,
          openTime: new Date(openMs),
          closeTime: new Date(closeMs),
          open: String(row[1]),
          high: String(row[2]),
          low: String(row[3]),
          close: String(row[4]),
          volume: String(row[5]),
          complete: closeMs < now
        };
        validateNormalizedCandle(candle);
        output.push(candle);
      }
      const last = rows[rows.length - 1] as unknown[];
      const next = Number(last[6]) + 1;
      if (!Number.isFinite(next) || next <= cursor) throw new Error("Binance pagination did not advance");
      cursor = next;
      pages += 1;
    }
    if (pages >= 1000 && cursor < endTime) throw new Error("Historical range exceeded the 1000-page safety limit");
    return normalizeCandles(output);
  }
}

export { fetchWithRetry } from "./http.js";
export * from "./validation.js";
