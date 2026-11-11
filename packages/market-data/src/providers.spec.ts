import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceUsdMProvider } from "./index.js";
import { OANDA_GRANULARITY, OandaV20Provider } from "./oanda.js";
import { findMissingCandles, isCandleStale, isForexMarketClosed, normalizeCandles, validateNormalizedCandle } from "./validation.js";
import type { NormalizedCandle } from "./index.js";

const now = Date.now();
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function candle(openTime: number, overrides: Partial<NormalizedCandle> = {}): NormalizedCandle {
  return {
    provider: "test",
    market: "crypto_perpetual",
    symbol: "BTCUSDT",
    interval: "5m",
    openTime: new Date(openTime),
    closeTime: new Date(openTime + 299999),
    open: "100",
    high: "102",
    low: "99",
    close: "101",
    volume: "10",
    complete: true,
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Binance USD-M provider", () => {
  it("parses real kline shape and marks the unfinished candle incomplete", async () => {
    const open = Math.floor(now / 300000) * 300000 - 300000;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([
      [open, "100", "102", "99", "101", "10", open + 299999],
      [open + 300000, "101", "103", "100", "102", "11", open + 599999]
    ])));
    const provider = new BinanceUsdMProvider("https://example.test");
    const rows = await provider.fetchCandles("BTCUSDT", "5m", 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.provider).toBe("binance_usdm");
    expect(rows[0]!.market).toBe("crypto_perpetual");
    expect(rows[0]!.complete).toBe(true);
    expect(rows[1]!.complete).toBe(false);
  });

  it("verifies perpetual contract metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      symbols: [{ symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", pricePrecision: 2, quantityPrecision: 3, filters: [] }]
    })));
    const provider = new BinanceUsdMProvider("https://example.test");
    const metadata = await provider.fetchInstrumentMetadata("BTCUSDT");
    expect(metadata.available).toBe(true);
    expect(metadata.contractType).toBe("PERPETUAL");
    expect(metadata.pricePrecision).toBe(2);
  });

  it("reports unavailable symbols without crashing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ symbols: [] })));
    const provider = new BinanceUsdMProvider("https://example.test");
    const metadata = await provider.fetchInstrumentMetadata("NOPEUSDT");
    expect(metadata.available).toBe(false);
    expect(metadata.status).toBe("NOT_LISTED");
  });

  it("rejects malformed provider rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([[1, "bad"]])));
    const provider = new BinanceUsdMProvider("https://example.test");
    await expect(provider.fetchCandles("BTCUSDT", "5m", 1)).rejects.toThrow();
  });

  it("rejects invalid symbols and limits before making a request", async () => {
    const provider = new BinanceUsdMProvider("https://example.test");
    await expect(provider.fetchCandles("bad symbol", "5m", 1)).rejects.toThrow();
    await expect(provider.fetchCandles("BTCUSDT", "5m", 0)).rejects.toThrow();
  });
});

describe("OANDA v20 provider", () => {
  it("maps every supported interval to a real OANDA granularity", () => {
    expect(OANDA_GRANULARITY).toEqual({ "1m": "M1", "5m": "M5", "15m": "M15", "1h": "H1", "4h": "H4", "1d": "D" });
  });

  it("parses midpoint candles and preserves completion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      candles: [
        { time: "2026-01-05T10:00:00.000000000Z", complete: true, volume: 10, mid: { o: "1.1", h: "1.2", l: "1.0", c: "1.15" } },
        { time: "2026-01-05T10:15:00.000000000Z", complete: false, volume: 2, mid: { o: "1.15", h: "1.16", l: "1.14", c: "1.155" } }
      ]
    })));
    const provider = new OandaV20Provider("token", "https://example.test");
    const rows = await provider.fetchCandles("EUR_USD", "15m", 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.market).toBe("forex");
    expect(rows[0]!.complete).toBe(true);
    expect(rows[1]!.complete).toBe(false);
    expect(rows[0]!.closeTime.getTime() - rows[0]!.openTime.getTime()).toBe(899999);
  });

  it("validates instrument metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ instrument: { type: "METAL", pipLocation: -2, tradeUnitsPrecision: 0 } })));
    const provider = new OandaV20Provider("token", "https://example.test");
    const metadata = await provider.fetchInstrumentMetadata("XAU_USD");
    expect(metadata.available).toBe(true);
    expect(metadata.pricePrecision).toBe(3);
  });

  it("requires a token and valid instrument", async () => {
    const provider = new OandaV20Provider("", "https://example.test");
    await expect(provider.fetchCandles("EUR_USD", "1m", 1)).rejects.toThrow(/OANDA_API_TOKEN/);
    const withToken = new OandaV20Provider("token", "https://example.test");
    await expect(withToken.fetchCandles("EURUSD", "1m", 1)).rejects.toThrow(/Invalid OANDA instrument/);
  });
});

describe("candle validation and gap detection", () => {
  it("deduplicates by open time and sorts", () => {
    const rows = normalizeCandles([candle(600000), candle(0), candle(600000, { high: "104", close: "103" })]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.openTime.getTime()).toBe(0);
    expect(rows[1]!.close).toBe("103");
  });

  it("rejects invalid OHLC and timestamps", () => {
    expect(() => validateNormalizedCandle(candle(0, { high: "90" }))).toThrow(/bounds/);
    expect(() => validateNormalizedCandle(candle(0, { closeTime: new Date(-1) }))).toThrow(/close time/);
  });

  it("detects missing crypto candles and ignores forex weekends", () => {
    const cryptoRows = [candle(0), candle(900000)];
    expect(findMissingCandles(cryptoRows, "5m", "crypto_perpetual")[0]!.missing).toBe(2);
    const friday = Date.UTC(2026, 0, 9, 20, 0, 0);
    const sunday = Date.UTC(2026, 0, 11, 22, 0, 0);
    const forexRows = [candle(friday, { market: "forex" }), candle(sunday, { market: "forex" })];
    expect(findMissingCandles(forexRows, "1h", "forex")).toHaveLength(0);
  });

  it("detects staleness but not during forex weekend closure", () => {
    const old = new Date(now - 10 * 60_000);
    expect(isCandleStale(old, "1m", "crypto_perpetual", new Date(now))).toBe(true);
    expect(isForexMarketClosed(new Date("2026-01-10T12:00:00Z"))).toBe(true);
    expect(isForexMarketClosed(new Date("2026-01-07T12:00:00Z"))).toBe(false);
  });
});
