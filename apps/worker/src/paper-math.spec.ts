import { describe, expect, it } from "vitest";
import { returnAfterCosts } from "./paper-math.js";
import { formatSignalMessage } from "./format.js";

const entry = new Date("2026-01-01T00:00:00Z");
const eightHoursLater = new Date("2026-01-01T08:00:00Z");

describe("paper return model", () => {
  it("computes long and short gross returns directionally", () => {
    expect(returnAfterCosts("LONG", 100, 110, 0, entry, entry, 0, "crypto_perpetual")).toBeCloseTo(0.1);
    expect(returnAfterCosts("SHORT", 100, 90, 0, entry, entry, 0, "crypto_perpetual")).toBeCloseTo(0.1);
  });

  it("subtracts round-trip costs", () => {
    expect(returnAfterCosts("LONG", 100, 110, 12, entry, entry, 0, "crypto_perpetual")).toBeCloseTo(0.0988);
  });

  it("charges positive funding to longs and credits shorts", () => {
    const long = returnAfterCosts("LONG", 100, 100, 0, entry, eightHoursLater, 8, "crypto_perpetual");
    const short = returnAfterCosts("SHORT", 100, 100, 0, entry, eightHoursLater, 8, "crypto_perpetual");
    expect(long).toBeLessThan(0);
    expect(short).toBeGreaterThan(0);
  });

  it("does not apply crypto funding to forex", () => {
    expect(returnAfterCosts("LONG", 100, 100, 0, entry, eightHoursLater, 8, "forex")).toBe(0);
  });
});

describe("signal message", () => {
  it("formats prices with symbol precision and includes the signal-only disclaimer", () => {
    const message = formatSignalMessage({
      symbol: "BTCUSDT",
      market: "crypto_perpetual",
      direction: "LONG",
      timeframe: "1h",
      confirmationTimeframe: "4h",
      strategyName: "EMA Trend Pullback",
      entry: 100,
      stop: 95,
      targets: [{ price: "110", allocationPct: 50 }, { price: "120", allocationPct: 50 }],
      rewardRisk: "2",
      qualityScore: "78.5",
      rationale: ["trend aligned"],
      invalidation: ["close below 95"],
      expiresAt: new Date("2026-01-01T12:00:00Z")
    });
    expect(message).toContain("Entry: 100.00");
    expect(message).toContain("TP1: 110.00");
    expect(message).toContain("Signal only. No trade has been placed.");
  });
});
