import { fetchWithRetry } from "./http.js";
import type { CandleInterval, InstrumentMetadata, MarketDataProvider, NormalizedCandle } from "./index.js";
import { INTERVAL_MS, normalizeCandles, validateNormalizedCandle } from "./validation.js";

/**
 * Twelve Data is used exclusively as a read-only Forex and metals market data
 * provider. This adapter only calls public market-data endpoints
 * (`/time_series`, `/symbol_search`, `/api_usage`). It never authenticates a
 * brokerage account, never requests account identifiers, and never places,
 * modifies or cancels orders.
 */

export const TWELVE_DATA_INTERVAL: Record<CandleInterval, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "1h": "1h",
  "4h": "4h",
  "1d": "1day"
};

const SYMBOL_PATTERN = /^[A-Z]{3}_[A-Z]{3}$/;
const APREV = /apikey=[^&\s"']+/gi;

export function redactSecrets(value: string): string {
  return value.replace(APREV, "apikey=***");
}

/** Convert the internal `EUR_USD` instrument code to the Twelve Data `EUR/USD` wire symbol. */
export function toTwelveDataSymbol(symbol: string): string {
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("Invalid Twelve Data forex symbol");
  return symbol.replace("_", "/");
}

/** Convert a Twelve Data `EUR/USD` wire symbol back to the internal `EUR_USD` code. */
export function fromTwelveDataSymbol(symbol: string): string {
  return symbol.replace("/", "_").toUpperCase();
}

export class TwelveDataError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "TwelveDataError";
    if (code !== undefined) this.code = code;
  }
}

export type TwelveDataUsage = {
  currentUsage: number | null;
  planLimit: number | null;
  dailyUsage: number | null;
  planDailyLimit: number | null;
  planCategory: string | null;
};

type TwelveValue = { datetime: string; open: string; high: string; low: string; close: string; volume?: string };
type TwelveSeries = { status?: string; code?: number; message?: string; values?: TwelveValue[] };

/**
 * Twelve Data returns intraday timestamps in the requested timezone (UTC here)
 * as `YYYY-MM-DD HH:MM:SS`. Daily (`1day`) timestamps are returned in
 * exchange-local time and, for spot forex/metals, are date-only labels. We must
 * not append `Z` to an exchange-local datetime and treat it as an instant.
 */
export function parseTwelveDataTime(datetime: string, interval: CandleInterval): Date {
  const trimmed = datetime.trim();
  if (!trimmed) throw new Error("Missing Twelve Data timestamp");
  if (interval === "1d") {
    const dateOnly = trimmed.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) throw new Error("Invalid Twelve Data daily timestamp");
    // Date-only label: anchor at UTC midnight of the labelled date. This is a
    // stable bucket identifier, not a claim about the exchange-local instant.
    return new Date(`${dateOnly}T00:00:00.000Z`);
  }
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)) return new Date(trimmed);
  return new Date(`${trimmed.replace(" ", "T")}Z`);
}

function parseVolume(value: string | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  return trimmed;
}

export type TwelveDataProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
};

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = "twelve_data";
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(options: TwelveDataProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TWELVE_DATA_API_KEY;
    this.baseUrl = options.baseUrl ?? process.env.TWELVE_DATA_BASE_URL ?? "https://api.twelvedata.com";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
  }

  private requireKey(): string {
    if (!this.apiKey) throw new TwelveDataError("TWELVE_DATA_API_KEY is required for forex market data");
    return this.apiKey;
  }

  private buildUrl(path: string, params: Record<string, string>): URL {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("apikey", this.requireKey());
    return url;
  }

  private async request(url: URL, timeoutMs = this.requestTimeoutMs): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      // Never retry 429: on a credit-limited plan a retry storm consumes the
      // per-minute budget and delays recovery. Surface it so callers can back off.
      response = await fetchWithRetry(url, { accept: "application/json" }, timeoutMs, 3, false);
    } catch (error) {
      throw new TwelveDataError(`Twelve Data request failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
    if (!response.ok) {
      const detail = await this.readErrorDetail(response);
      const code = detail.code ?? response.status;
      if (response.status === 429 || code === 429 || /limit|quota|credits/i.test(detail.message)) {
        throw new TwelveDataError(`Twelve Data rate limit or quota exceeded: HTTP ${response.status} ${detail.message}`, 429);
      }
      throw new TwelveDataError(`Twelve Data request failed: HTTP ${response.status} ${detail.message}`, code);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TwelveDataError("Twelve Data returned a non-JSON response");
    }
    if (!body || typeof body !== "object") throw new TwelveDataError("Malformed Twelve Data response");
    return body as Record<string, unknown>;
  }

  private async readErrorDetail(response: Response): Promise<{ code?: number; message: string }> {
    try {
      const text = await response.text();
      if (!text) return { message: "" };
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const code = typeof parsed.code === "number" ? parsed.code : undefined;
      const message = typeof parsed.message === "string" ? redactSecrets(parsed.message) : redactSecrets(text).slice(0, 200);
      return { ...(code !== undefined ? { code } : {}), message };
    } catch {
      return { message: "" };
    }
  }

  private assertOk(body: TwelveSeries, context: string): TwelveValue[] {
    if (body.status === "error" || (body.code !== undefined && body.code !== 200)) {
      const code = typeof body.code === "number" ? body.code : undefined;
      const message = typeof body.message === "string" && body.message ? body.message : `${context} failed`;
      if (code === 429 || /limit|quota|credits/i.test(message)) {
        throw new TwelveDataError(`Twelve Data rate limit or quota exceeded: ${message}`, code);
      }
      throw new TwelveDataError(`Twelve Data error: ${message}`, code);
    }
    if (!Array.isArray(body.values)) throw new TwelveDataError(body.message ?? "Malformed Twelve Data response");
    return body.values;
  }

  private toNormalized(symbol: string, interval: CandleInterval, value: TwelveValue, now: number): NormalizedCandle {
    if (typeof value.open !== "string" || typeof value.high !== "string" || typeof value.low !== "string" || typeof value.close !== "string") {
      throw new TwelveDataError("Malformed Twelve Data candle values");
    }
    const openTime = parseTwelveDataTime(value.datetime, interval);
    const closeTime = new Date(openTime.getTime() + INTERVAL_MS[interval] - 1);
    const candle: NormalizedCandle = {
      provider: this.name,
      market: "forex",
      symbol,
      interval,
      openTime,
      closeTime,
      open: value.open,
      high: value.high,
      low: value.low,
      close: value.close,
      volume: parseVolume(value.volume),
      complete: closeTime.getTime() < now
    };
    validateNormalizedCandle(candle);
    return candle;
  }

  async fetchCandles(symbol: string, interval: CandleInterval, limit = 500): Promise<NormalizedCandle[]> {
    const wireSymbol = toTwelveDataSymbol(symbol);
    if (!(interval in TWELVE_DATA_INTERVAL)) throw new TwelveDataError("Unsupported Twelve Data interval");
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new TwelveDataError("limit must be 1..5000");
    const params: Record<string, string> = {
      symbol: wireSymbol,
      interval: TWELVE_DATA_INTERVAL[interval],
      outputsize: String(Math.min(Math.max(limit, 1), 5000)),
      format: "JSON"
    };
    if (interval !== "1d") params.timezone = "UTC";
    const body = (await this.request(this.buildUrl("/time_series", params))) as TwelveSeries;
    const values = this.assertOk(body, "Twelve Data time series request");
    const now = Date.now();
    return normalizeCandles(values.map((value) => this.toNormalized(symbol, interval, value, now)));
  }

  async fetchCandlesRange(symbol: string, interval: CandleInterval, startTime: number, endTime: number): Promise<NormalizedCandle[]> {
    const wireSymbol = toTwelveDataSymbol(symbol);
    if (!(interval in TWELVE_DATA_INTERVAL)) throw new TwelveDataError("Unsupported Twelve Data interval");
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) throw new TwelveDataError("Invalid historical range");
    const step = INTERVAL_MS[interval];
    // Never request beyond the last complete interval. The current interval is
    // still forming (and for `1day` Twelve Data rejects the current day with
    // HTTP 400 "No data is available", which still consumes a credit).
    const cappedEnd = Math.min(endTime, Math.floor(Date.now() / step) * step);
    if (startTime >= cappedEnd) return [];
    const output: NormalizedCandle[] = [];
    let cursor = startTime;
    let pages = 0;
    while (cursor < cappedEnd && pages < 100) {
      const params: Record<string, string> = {
        symbol: wireSymbol,
        interval: TWELVE_DATA_INTERVAL[interval],
        start_date: new Date(cursor).toISOString(),
        end_date: new Date(cappedEnd).toISOString(),
        outputsize: "5000",
        order: "ASC",
        format: "JSON"
      };
      if (interval !== "1d") params.timezone = "UTC";
      let values: TwelveValue[];
      try {
        const body = (await this.request(this.buildUrl("/time_series", params), 20_000)) as TwelveSeries;
        values = this.assertOk(body, "Twelve Data historical request");
      } catch (error) {
        // A range with no trading data (e.g. a weekend) is not an error: stop.
        if (error instanceof TwelveDataError && error.code === 400 && /no data is available/i.test(error.message)) break;
        throw error;
      }
      if (values.length === 0) break;
      const now = Date.now();
      let lastOpen = cursor;
      for (const value of values) {
        const candle = this.toNormalized(symbol, interval, value, now);
        lastOpen = Math.max(lastOpen, candle.openTime.getTime());
        if (candle.openTime.getTime() >= startTime && candle.openTime.getTime() < cappedEnd) output.push(candle);
      }
      const next = lastOpen + step;
      if (!Number.isFinite(next) || next <= cursor) throw new TwelveDataError("Twelve Data pagination did not advance");
      cursor = next;
      pages += 1;
    }
    if (pages >= 100 && cursor < cappedEnd) throw new TwelveDataError("Twelve Data historical range exceeded the 100-page safety limit");
    return normalizeCandles(output);
  }

  async fetchInstrumentMetadata(symbol: string): Promise<InstrumentMetadata> {
    const wireSymbol = toTwelveDataSymbol(symbol);
    const body = await this.request(this.buildUrl("/symbol_search", { symbol: wireSymbol }));
    const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
    const match = data.find((entry) => String(entry.symbol ?? "").toUpperCase() === wireSymbol);
    const instrumentType = match ? String(match.instrument_type ?? "UNKNOWN") : "NOT_FOUND";
    return {
      provider: this.name,
      symbol,
      market: "forex",
      available: Boolean(match),
      status: instrumentType,
      pricePrecision: forexPricePrecision(symbol),
      quantityPrecision: 0
    };
  }

  /** Fetch the account's current API credit usage. `/api_usage` does not consume a credit. */
  async getApiUsage(): Promise<TwelveDataUsage> {
    const body = await this.request(this.buildUrl("/api_usage", {}));
    const num = (key: string): number | null => {
      const value = Number(body[key]);
      return Number.isFinite(value) ? value : null;
    };
    return {
      currentUsage: num("current_usage"),
      planLimit: num("plan_limit"),
      dailyUsage: num("daily_usage"),
      planDailyLimit: num("plan_daily_limit"),
      planCategory: typeof body.plan_category === "string" ? body.plan_category : null
    };
  }
}

export function forexPricePrecision(symbol: string): number {
  if (symbol.startsWith("XAU") || symbol.startsWith("XAG")) return 2;
  if (symbol.endsWith("JPY")) return 3;
  return 5;
}
