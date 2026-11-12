import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TwelveDataError,
  TwelveDataProvider,
  TWELVE_DATA_INTERVAL,
  fromTwelveDataSymbol,
  parseTwelveDataTime,
  redactSecrets,
  toTwelveDataSymbol
} from "./twelve-data.js";

const FOREX = ["EUR_USD", "GBP_USD", "USD_JPY", "EUR_JPY", "XAU_USD"] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function provider(): TwelveDataProvider {
  return new TwelveDataProvider({ apiKey: "test-key", baseUrl: "https://example.test", requestTimeoutMs: 1_000 });
}
function series(values: Array<Record<string, string>>, extra: Record<string, unknown> = {}) {
  return { meta: { symbol: "EUR/USD" }, status: "ok", values, ...extra };
}
function urlOf(fetchMock: ReturnType<typeof vi.fn>, index = -1): URL {
  const call = fetchMock.mock.calls.at(index);
  return new URL(String(call?.[0]));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Twelve Data symbol and interval mapping", () => {
  it("maps every Signal Engine interval to a documented Twelve Data interval", () => {
    expect(TWELVE_DATA_INTERVAL).toEqual({ "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" });
  });

  it("maps all five configured instruments to wire symbols and back", () => {
    expect(FOREX.map((symbol) => toTwelveDataSymbol(symbol))).toEqual(["EUR/USD", "GBP/USD", "USD/JPY", "EUR/JPY", "XAU/USD"]);
    expect(FOREX.map((symbol) => fromTwelveDataSymbol(toTwelveDataSymbol(symbol)))).toEqual([...FOREX]);
  });

  it("rejects malformed symbols before any request", async () => {
    const instance = provider();
    await expect(instance.fetchCandles("EURUSD", "1m", 1)).rejects.toThrow(/Invalid Twelve Data forex symbol/);
    await expect(instance.fetchCandles("eur_usd", "1m", 1)).rejects.toThrow(/Invalid Twelve Data forex symbol/);
  });

  it("sends the correct wire symbol, interval, timezone and API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(series([{ datetime: "2026-01-05 10:00:00", open: "1.1", high: "1.2", low: "1.0", close: "1.15" }])));
    vi.stubGlobal("fetch", fetchMock);
    await provider().fetchCandles("EUR_USD", "15m", 5);
    const url = urlOf(fetchMock);
    expect(url.pathname).toBe("/time_series");
    expect(url.searchParams.get("symbol")).toBe("EUR/USD");
    expect(url.searchParams.get("interval")).toBe("15min");
    expect(url.searchParams.get("timezone")).toBe("UTC");
    expect(url.searchParams.get("outputsize")).toBe("5");
    expect(url.searchParams.get("apikey")).toBe("test-key");
  });

  it("does not send a timezone for daily candles (documented as ignored)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(series([{ datetime: "2026-01-05", open: "1.1", high: "1.2", low: "1.0", close: "1.15" }])));
    vi.stubGlobal("fetch", fetchMock);
    await provider().fetchCandles("EUR_USD", "1d", 5);
    expect(urlOf(fetchMock).searchParams.get("timezone")).toBeNull();
    expect(urlOf(fetchMock).searchParams.get("interval")).toBe("1day");
  });
});

describe("Twelve Data authentication and usage", () => {
  it("requires an API key", async () => {
    const instance = new TwelveDataProvider({ apiKey: "", baseUrl: "https://example.test" });
    await expect(instance.fetchCandles("EUR_USD", "1m", 1)).rejects.toThrow(/TWELVE_DATA_API_KEY/);
  });

  it("parses the account usage endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      current_usage: 1,
      plan_limit: 8,
      daily_usage: 216,
      plan_daily_limit: 800,
      plan_category: "basic"
    })));
    const usage = await provider().getApiUsage();
    expect(usage).toEqual({ currentUsage: 1, planLimit: 8, dailyUsage: 216, planDailyLimit: 800, planCategory: "basic" });
  });

  it("surfaces invalid API key errors without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: 401, status: "error", message: "Invalid API key" })));
    await expect(provider().fetchCandles("EUR_USD", "1m", 1)).rejects.toMatchObject({ name: "TwelveDataError", code: 401 });
  });

  it("redacts API keys from error text", () => {
    expect(redactSecrets("GET https://api.twelvedata.com/time_series?apikey=secret123&symbol=EUR/USD failed")).toBe(
      "GET https://api.twelvedata.com/time_series?apikey=***&symbol=EUR/USD failed"
    );
  });
});

describe("Twelve Data candle normalization", () => {
  it("parses a successful time series response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(series([
      { datetime: "2026-01-05 10:05:00", open: "1.10", high: "1.12", low: "1.09", close: "1.11" },
      { datetime: "2026-01-05 10:00:00", open: "1.09", high: "1.11", low: "1.08", close: "1.10" }
    ]))));
    const rows = await provider().fetchCandles("EUR_USD", "5m", 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.provider).toBe("twelve_data");
    expect(rows[0]!.market).toBe("forex");
    expect(rows[0]!.symbol).toBe("EUR_USD");
    expect(rows[0]!.open).toBe("1.09");
    expect(rows[0]!.openTime.getTime()).toBe(Date.UTC(2026, 0, 5, 10, 0, 0));
    expect(rows[1]!.openTime.getTime()).toBe(Date.UTC(2026, 0, 5, 10, 5, 0));
    expect(rows[0]!.closeTime.getTime() - rows[0]!.openTime.getTime()).toBe(299_999);
  });

  it("normalizes intraday timestamps as UTC instants", () => {
    expect(parseTwelveDataTime("2026-01-05 12:34:56", "1h").toISOString()).toBe("2026-01-05T12:34:56.000Z");
    expect(parseTwelveDataTime("2026-01-05T12:34:56Z", "1h").toISOString()).toBe("2026-01-05T12:34:56.000Z");
  });

  it("anchors daily candles at UTC midnight of the labelled date", () => {
    expect(parseTwelveDataTime("2026-01-05", "1d").toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(parseTwelveDataTime("2026-01-05 00:00:00", "1d").toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(() => parseTwelveDataTime("05/01/2026", "1d")).toThrow(/daily timestamp/);
  });

  it("represents unavailable volume as null and never fabricates it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(series([
      { datetime: "2026-01-05 10:00:00", open: "1.1", high: "1.2", low: "1.0", close: "1.15" },
      { datetime: "2026-01-05 09:00:00", open: "1.1", high: "1.2", low: "1.0", close: "1.15", volume: "" }
    ]))));
    const rows = await provider().fetchCandles("XAU_USD", "1h", 2);
    expect(rows.every((row) => row.volume === null)).toBe(true);
  });

  it("preserves supplied volume and decimal precision", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(series([
      { datetime: "2026-01-05 10:00:00", open: "1.10000000001", high: "1.2", low: "1.0", close: "1.15", volume: "1234.5" }
    ]))));
    const rows = await provider().fetchCandles("EUR_USD", "1h", 1);
    expect(rows[0]!.volume).toBe("1234.5");
    expect(rows[0]!.open).toBe("1.10000000001");
  });

  it("marks the current interval as incomplete and past candles as complete", async () => {
    const step = 3_600_000;
    const boundary = Math.floor(Date.now() / step) * step;
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(series([
      { datetime: fmt(boundary), open: "1.1", high: "1.2", low: "1.0", close: "1.15" },
      { datetime: fmt(boundary - step), open: "1.1", high: "1.2", low: "1.0", close: "1.15" }
    ]))));
    const rows = await provider().fetchCandles("EUR_USD", "1h", 2);
    const incomplete = rows.find((row) => row.openTime.getTime() === boundary);
    const complete = rows.find((row) => row.openTime.getTime() === boundary - step);
    expect(incomplete?.complete).toBe(false);
    expect(complete?.complete).toBe(true);
  });

  it("deduplicates duplicate candles safely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(series([
      { datetime: "2026-01-05 10:00:00", open: "1.1", high: "1.2", low: "1.0", close: "1.15" },
      { datetime: "2026-01-05 10:00:00", open: "1.1", high: "1.25", low: "1.0", close: "1.18" }
    ]))));
    const rows = await provider().fetchCandles("EUR_USD", "1h", 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.high).toBe("1.25");
  });

  it("rejects invalid OHLC values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(series([
      { datetime: "2026-01-05 10:00:00", open: "1.1", high: "1.05", low: "1.0", close: "1.15" }
    ]))));
    await expect(provider().fetchCandles("EUR_USD", "1h", 1)).rejects.toThrow(/bounds|OHLC/);
  });
});

describe("Twelve Data historical ingestion", () => {
  it("paginates a historical range and stops on an empty page", async () => {
    const step = 3_600_000;
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const page = (hours: number[]) => series(hours.map((hour) => ({
      datetime: new Date(start + hour * step).toISOString().slice(0, 19).replace("T", " "),
      open: "1.1", high: "1.2", low: "1.0", close: "1.15"
    })));
    const fetchMock = vi.fn().mockImplementation((input: URL) => {
      const startParam = new URL(String(input)).searchParams.get("start_date");
      if (startParam === new Date(start).toISOString()) return Promise.resolve(jsonResponse(page([0, 1])));
      if (startParam === new Date(start + 2 * step).toISOString()) return Promise.resolve(jsonResponse(page([2, 3])));
      return Promise.resolve(jsonResponse(series([])));
    });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await provider().fetchCandlesRange("EUR_USD", "1h", start, start + 6 * step);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.openTime.getTime())).toEqual([0, 1, 2, 3].map((hour) => start + hour * step));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("handles empty responses without error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(series([]))));
    const rows = await provider().fetchCandlesRange("EUR_USD", "1h", Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2));
    expect(rows).toEqual([]);
  });

  it("caps the requested range at the last complete interval", async () => {
    const step = 3_600_000;
    const now = Date.now();
    const cappedEnd = Math.floor(now / step) * step;
    const start = cappedEnd - 3 * step;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(series([])));
    vi.stubGlobal("fetch", fetchMock);
    await provider().fetchCandlesRange("EUR_USD", "1h", start, now);
    expect(urlOf(fetchMock, 0).searchParams.get("end_date")).toBe(new Date(cappedEnd).toISOString());
  });

  it("treats a no-data range as the end of available data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 400, status: "error", message: "No data is available on the specified dates." }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await provider().fetchCandlesRange("EUR_USD", "1d", Date.UTC(2026, 0, 3), Date.UTC(2026, 0, 5));
    expect(rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid historical ranges before requesting", async () => {
    await expect(provider().fetchCandlesRange("EUR_USD", "1h", 10, 10)).rejects.toThrow(/Invalid historical range/);
  });
});

describe("Twelve Data provider errors and resilience", () => {
  it("reports rate-limit responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: 429, status: "error", message: "API limit reached" })));
    await expect(provider().fetchCandles("EUR_USD", "1m", 1)).rejects.toMatchObject({ name: "TwelveDataError", code: 429 });
  });

  it("does not retry an HTTP 429 and surfaces the response detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 429, status: "error", message: "You have run out of API credits" }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const error = await provider().fetchCandles("EUR_USD", "1m", 1).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "TwelveDataError", code: 429 });
    expect((error as Error).message).toMatch(/run out of API credits/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the response message for non-rate-limit HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: 400, status: "error", message: "Invalid start_date" }, 400)));
    await expect(provider().fetchCandlesRange("EUR_USD", "1h", 1, 2)).rejects.toThrow(/Invalid start_date/);
  });

  it("reports quota exhaustion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: 429, status: "error", message: "You have reached the daily limit" })));
    await expect(provider().fetchCandles("EUR_USD", "1m", 1)).rejects.toThrow(/quota exceeded|daily limit/);
  });

  it("reports HTTP failures without exposing the API key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    await expect(provider().fetchCandles("EUR_USD", "1m", 1)).rejects.toThrow(/HTTP 503/);
  });

  it("wraps provider timeouts in a sanitized error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const error = await provider().fetchCandles("EUR_USD", "1m", 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TwelveDataError);
    expect((error as Error).message).toMatch(/Twelve Data request failed/);
    expect((error as Error).message).not.toContain("test-key");
  });

  it("retries a transient server error and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(series([{ datetime: "2026-01-05 10:00:00", open: "1.1", high: "1.2", low: "1.0", close: "1.15" }])));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await provider().fetchCandles("EUR_USD", "1h", 1);
    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports malformed payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "ok" })));
    await expect(provider().fetchCandles("EUR_USD", "1h", 1)).rejects.toThrow(/Malformed/);
  });
});

describe("Twelve Data instrument availability", () => {
  it("confirms XAU/USD availability through symbol search", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ symbol: "XAU/USD", instrument_name: "Gold Spot / US Dollar", instrument_type: "Precious Metal", exchange: "COMMODITY" }],
      status: "ok"
    }));
    vi.stubGlobal("fetch", fetchMock);
    const metadata = await provider().fetchInstrumentMetadata("XAU_USD");
    expect(metadata.available).toBe(true);
    expect(metadata.status).toBe("Precious Metal");
    expect(metadata.pricePrecision).toBe(2);
    expect(urlOf(fetchMock).searchParams.get("symbol")).toBe("XAU/USD");
  });

  it("reports unavailable symbols without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [], status: "ok" })));
    const metadata = await provider().fetchInstrumentMetadata("EUR_USD");
    expect(metadata.available).toBe(false);
    expect(metadata.status).toBe("NOT_FOUND");
  });
});
