import { fetchWithRetry } from "./http.js";
import type { CandleInterval, InstrumentMetadata, MarketDataProvider, NormalizedCandle } from "./index.js";
import { normalizeCandles, validateNormalizedCandle } from "./validation.js";

export const OANDA_GRANULARITY: Record<CandleInterval, string> = {
  "1m": "M1",
  "5m": "M5",
  "15m": "M15",
  "1h": "H1",
  "4h": "H4",
  "1d": "D"
};

type OandaCandle = { time: string; complete: boolean; volume: number; mid?: { o: string; h: string; l: string; c: string } };

function intervalMillis(interval: CandleInterval): number {
  return { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 }[interval];
}

export class OandaV20Provider implements MarketDataProvider {
  readonly name = "oanda_v20";
  constructor(
    private readonly token = process.env.OANDA_API_TOKEN,
    private readonly baseUrl = process.env.OANDA_BASE_URL ?? "https://api-fxpractice.oanda.com"
  ) {}

  private requireToken(): string {
    if (!this.token) throw new Error("OANDA_API_TOKEN is required for forex data");
    return this.token;
  }

  async fetchInstrumentMetadata(symbol: string): Promise<InstrumentMetadata> {
    const token = this.requireToken();
    if (!/^[A-Z]{3}_[A-Z]{3}$/.test(symbol)) throw new Error("Invalid OANDA instrument");
    const url = new URL(`/v3/instruments/${symbol}`, this.baseUrl);
    const response = await fetchWithRetry(url, { Authorization: `Bearer ${token}`, Accept: "application/json" }, 12_000);
    if (response.status === 404) {
      return { provider: this.name, symbol, market: "forex", available: false, status: "NOT_FOUND", pricePrecision: 5, quantityPrecision: 0 };
    }
    if (!response.ok) throw new Error(`OANDA instrument request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { instrument?: Record<string, unknown> };
    if (!body.instrument) throw new Error("Malformed OANDA instrument response");
    const instrument = body.instrument;
    const pipLocation = Number(instrument.pipLocation ?? -4);
    return {
      provider: this.name,
      symbol,
      market: "forex",
      available: instrument.type === "CURRENCY" || instrument.type === "METAL",
      status: String(instrument.type ?? "UNKNOWN"),
      pricePrecision: Math.abs(pipLocation) + 1,
      quantityPrecision: Number(instrument.tradeUnitsPrecision ?? 0)
    };
  }

  async fetchCandles(symbol: string, interval: CandleInterval, limit = 500): Promise<NormalizedCandle[]> {
    const token = this.requireToken();
    if (!/^[A-Z]{3}_[A-Z]{3}$/.test(symbol)) throw new Error("Invalid OANDA instrument");
    if (!(interval in OANDA_GRANULARITY)) throw new Error("Unsupported OANDA interval");
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error("limit must be 1..5000");
    const url = new URL(`/v3/instruments/${symbol}/candles`, this.baseUrl);
    url.searchParams.set("granularity", OANDA_GRANULARITY[interval]);
    url.searchParams.set("count", String(limit));
    url.searchParams.set("price", "M");
    const body = await this.request(url, token);
    return normalizeCandles(body.candles.filter((candle) => candle.mid).map((candle) => this.toNormalized(symbol, interval, candle)));
  }

  async fetchCandlesSince(symbol: string, interval: CandleInterval, since: number): Promise<NormalizedCandle[]> {
    return this.fetchCandlesRange(symbol, interval, since, Date.now());
  }

  async fetchCandlesRange(symbol: string, interval: CandleInterval, startTime: number, endTime: number): Promise<NormalizedCandle[]> {
    const token = this.requireToken();
    if (!/^[A-Z]{3}_[A-Z]{3}$/.test(symbol)) throw new Error("Invalid OANDA instrument");
    if (!(interval in OANDA_GRANULARITY)) throw new Error("Unsupported OANDA interval");
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) throw new Error("Invalid historical range");
    const output: NormalizedCandle[] = [];
    let cursor = startTime;
    let pages = 0;
    while (cursor < endTime && pages < 200) {
      const url = new URL(`/v3/instruments/${symbol}/candles`, this.baseUrl);
      url.searchParams.set("granularity", OANDA_GRANULARITY[interval]);
      url.searchParams.set("from", new Date(cursor).toISOString());
      url.searchParams.set("to", new Date(endTime).toISOString());
      url.searchParams.set("price", "M");
      const body = await this.request(url, token);
      if (body.candles.length === 0) break;
      for (const candle of body.candles) {
        if (!candle.mid) continue;
        output.push(this.toNormalized(symbol, interval, candle));
      }
      const last = body.candles[body.candles.length - 1]!;
      const next = new Date(last.time).getTime() + intervalMillis(interval);
      if (!Number.isFinite(next) || next <= cursor) throw new Error("OANDA pagination did not advance");
      cursor = next;
      pages += 1;
    }
    if (pages >= 200 && cursor < endTime) throw new Error("OANDA historical range exceeded the 200-page safety limit");
    return normalizeCandles(output);
  }

  private async request(url: URL, token: string): Promise<{ candles: OandaCandle[] }> {
    const response = await fetchWithRetry(url, { Authorization: `Bearer ${token}`, Accept: "application/json" }, 20_000);
    if (!response.ok) throw new Error(`OANDA candle request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { candles?: OandaCandle[] };
    if (!Array.isArray(body.candles)) throw new Error("Malformed OANDA candle response");
    return { candles: body.candles };
  }

  private toNormalized(symbol: string, interval: CandleInterval, candle: OandaCandle): NormalizedCandle {
    const open = new Date(candle.time);
    const normalized: NormalizedCandle = {
      provider: this.name,
      market: "forex",
      symbol,
      interval,
      openTime: open,
      closeTime: new Date(open.getTime() + intervalMillis(interval) - 1),
      open: candle.mid!.o,
      high: candle.mid!.h,
      low: candle.mid!.l,
      close: candle.mid!.c,
      volume: String(candle.volume),
      complete: candle.complete
    };
    validateNormalizedCandle(normalized);
    return normalized;
  }
}
