import { describe, expect, it } from "vitest";
import { TwelveDataProvider, TWELVE_DATA_INTERVAL } from "./twelve-data.js";

/**
 * Live provider tests. Disabled by default so CI stays deterministic and no API
 * credits are consumed. Enable with LIVE_TWELVE_DATA=1 and a configured
 * TWELVE_DATA_API_KEY. The API key is never printed.
 */
const live = process.env.LIVE_TWELVE_DATA === "1" && Boolean(process.env.TWELVE_DATA_API_KEY);

describe.skipIf(!live)("Twelve Data live provider", () => {
  const provider = new TwelveDataProvider();

  it("authenticates and reports plan usage", async () => {
    const usage = await provider.getApiUsage();
    expect(usage.planCategory).toBeTruthy();
    expect(usage.planDailyLimit).toBeGreaterThan(0);
  });

  it("confirms XAU/USD availability", async () => {
    const metadata = await provider.fetchInstrumentMetadata("XAU_USD");
    expect(metadata.available).toBe(true);
  });

  it("fetches a completed EUR/USD candle for every supported interval", async () => {
    for (const interval of Object.keys(TWELVE_DATA_INTERVAL) as Array<keyof typeof TWELVE_DATA_INTERVAL>) {
      const rows = await provider.fetchCandles("EUR_USD", interval, 2);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.market).toBe("forex");
      expect(rows[0]!.symbol).toBe("EUR_USD");
    }
  });

  it("fetches a small historical range", async () => {
    // The basic plan allows 8 credits/minute; the tests above already consume
    // that budget (usage + metadata + one request per interval), so wait for the
    // rate-limit window to reset before issuing another request.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    const end = Date.now();
    const start = end - 6 * 3_600_000;
    const rows = await provider.fetchCandlesRange("EUR_USD", "1h", start, end);
    expect(Array.isArray(rows)).toBe(true);
  }, 90_000);
});
