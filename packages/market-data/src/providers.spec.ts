import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceUsdMProvider } from "./index.js";
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
