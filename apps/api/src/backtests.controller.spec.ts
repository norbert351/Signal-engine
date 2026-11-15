import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBacktest: vi.fn(async (input: Record<string, unknown>) => ({ id: "backtest-1", ...input })),
  listBacktests: vi.fn()
}));
vi.mock("@signal-engine/database/admin-repository", () => ({
  createBacktest: mocks.createBacktest,
  listBacktests: mocks.listBacktests
}));

import { BacktestsController } from "./backtests.controller.js";

const costs = { fee_bps_per_side: 5, spread_bps: 2, slippage_bps: 2, funding_bps_per_8h: 0 };
const dataset = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z", trendTimeframe: "4h" };
const valid = { strategyKey: "ema-trend-pullback", strategyVersion: 1, timeframe: "1h", instrumentId: "instrument-1", ...dataset, assumptions: costs };

describe("BacktestsController", () => {
  it("passes explicit costs through to backtest creation", async () => {
    const result = await new BacktestsController().create(valid);
    expect(result.id).toBe("backtest-1");
    expect(mocks.createBacktest).toHaveBeenCalledWith(expect.objectContaining({ assumptions: costs, instrumentId: "instrument-1" }));
  });

  it("accepts explicit zero costs and numeric strings", async () => {
    const zero = { fee_bps_per_side: 0, spread_bps: "0", slippage_bps: 0, funding_bps_per_8h: "0" };
    await new BacktestsController().create({ ...valid, assumptions: zero });
    expect(mocks.createBacktest).toHaveBeenCalledWith(expect.objectContaining({ assumptions: zero }));
  });

  it.each([
    undefined,
    {},
    { ...costs, fee_bps_per_side: undefined },
    { ...costs, fee_bps_per_side: true },
    { ...costs, spread_bps: "not-a-number" },
    { ...costs, slippage_bps: -1 },
    [costs]
  ])("rejects missing, malformed, or invalid costs", async (assumptions) => {
    mocks.createBacktest.mockClear();
    await expect(new BacktestsController().create({ ...valid, assumptions })).rejects.toThrow(/cost assumption/i);
    expect(mocks.createBacktest).not.toHaveBeenCalled();
  });

  it("rejects a backtest with neither stored range metadata nor explicit bars", async () => {
    await expect(new BacktestsController().create({ strategyKey: "ema-trend-pullback", strategyVersion: 1, timeframe: "1h", assumptions: costs })).rejects.toThrow(/Provide/);
  });
});
