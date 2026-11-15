import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@signal-engine/database/backtest-repository", () => ({
  claimQueuedBacktests: vi.fn(),
  finishBacktest: vi.fn(),
  loadBacktestCandles: vi.fn(),
  updateBacktestProgress: vi.fn()
}));

import { claimQueuedBacktests, finishBacktest, updateBacktestProgress } from "@signal-engine/database/backtest-repository";
import { classifyFailure, failureAttempts, postBacktest, processBacktests, validateEffectiveAssumptions, validateExplicitCosts } from "./backtests.js";

const costs = { fee_bps_per_side: 5, spread_bps: 2, slippage_bps: 2, funding_bps_per_8h: 0 };
const verified = { ...costs, explicit: true, version: "costs-v1" };

function job(assumptions: Record<string, unknown> = costs) {
  return {
    id: "backtest-1",
    strategyKey: "ema-trend-pullback",
    strategyVersion: 1,
    timeframe: "1h",
    dataset: { bars: Array.from({ length: 100 }, () => ({})), trendBars: Array.from({ length: 50 }, () => ({})) },
    assumptions,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "running"
  };
}

beforeEach(() => {
  vi.mocked(claimQueuedBacktests).mockReset().mockResolvedValue([]);
  vi.mocked(finishBacktest).mockReset().mockResolvedValue(true);
  vi.mocked(updateBacktestProgress).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("backtest cost and failure handling", () => {
  it("requires every explicit non-negative cost", () => {
    expect(validateExplicitCosts({ ...costs, fee_bps_per_side: "5" })).toEqual(costs);
    expect(validateExplicitCosts({ ...costs, fee_bps_per_side: "0", spread_bps: 0, slippage_bps: 0 })).toMatchObject({ fee_bps_per_side: 0, spread_bps: 0, slippage_bps: 0 });
    expect(() => validateExplicitCosts({ ...costs, fee_bps_per_side: -1 })).toThrow(/fee_bps_per_side/);
    expect(() => validateExplicitCosts({ ...costs, fee_bps_per_side: true })).toThrow(/fee_bps_per_side/);
    expect(() => validateExplicitCosts({ ...costs, spread_bps: Number.NaN })).toThrow(/spread_bps/);
    expect(() => validateExplicitCosts({ ...costs, slippage_bps: undefined })).toThrow(/slippage_bps/);
  });

  it("rejects changed or unverified cost assumptions returned by research", () => {
    expect(validateEffectiveAssumptions({ assumptions: verified }, costs)).toMatchObject(verified);
    expect(() => validateEffectiveAssumptions({ assumptions: { ...verified, fee_bps_per_side: 6 } }, costs)).toThrow(/changed cost assumption/);
    expect(() => validateEffectiveAssumptions({ assumptions: { ...costs, explicit: false, version: "costs-v1" } }, costs)).toThrow(/verified explicit/);
    expect(() => validateEffectiveAssumptions({ assumptions: { ...costs, explicit: true, version: "legacy" } }, costs)).toThrow(/verified explicit/);
    expect(validateEffectiveAssumptions({}, costs)).toMatchObject(verified);
  });

  it.each([
    ["The operation was aborted due to timeout", "timeout", true],
    ["Headers Timeout Error", "timeout", true],
    ["read ECONNRESET", "transient_infrastructure", true],
    ["connect ECONNREFUSED 127.0.0.1:8000", "transient_infrastructure", true],
    ["other side closed", "transient_infrastructure", true],
    ["Research service HTTP 500", "research_service_error", true],
    ["Research service HTTP 429", "research_service_error", true],
    ["Insufficient historical candles for a meaningful backtest", "data_error", false],
    ["Unsupported strategy key", "strategy_error", false],
    ["Invalid OHLC bounds", "validation_error", false],
    ["Postgres deadlock detected", "database_error", false],
    ["ENOMEM: out of memory", "resource_error", true],
    ["Broker rejected the request", "invalid_request_or_data", false]
  ])("classifies %s", (message, classification, transient) => {
    expect(classifyFailure(new Error(message))).toMatchObject({ classification, transient });
  });

  it("retries with an identical cost payload and records the attempt count", async () => {
    const body = { costs, assumptions: { ...costs } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "The operation was aborted due to timeout" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ metrics: { overall: { trades: 1 } }, assumptions: verified }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const retry = vi.fn(async () => undefined);
    const result = await postBacktest("http://research", body, retry);
    expect(result.attempts).toBe(2);
    expect(result.assumptions).toMatchObject(verified);
    expect(retry).toHaveBeenCalledWith(1, expect.any(Error));
    const payloads = fetchMock.mock.calls.map((call) => String((call[1] as RequestInit).body));
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toBe(payloads[1]);
    expect(JSON.parse(payloads[1]!)).toEqual(body);
  });

  it("bounds retries and does not retry invalid requests", async () => {
    const unavailable = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "service unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", unavailable);
    await expect(postBacktest("http://research", { costs })).rejects.toSatisfy((error) => failureAttempts(error) === 2);
    expect(unavailable).toHaveBeenCalledTimes(2);

    const invalid = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "invalid costs" }), { status: 400 }));
    vi.stubGlobal("fetch", invalid);
    await expect(postBacktest("http://research", { costs })).rejects.toSatisfy((error) => failureAttempts(error) === 1);
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("persists completed cost assumptions and progress for the active claim", async () => {
    const queued = job();
    vi.mocked(claimQueuedBacktests).mockResolvedValue([queued as never]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ metrics: { overall: { trades: 2 } }, assumptions: verified }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(processBacktests()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, stale: 0 });
    expect(finishBacktest).toHaveBeenCalledWith(
      queued.id,
      expect.objectContaining({ overall: { trades: 2 }, assumptions: verified, progress: { stage: "completed", attempts: 1 } }),
      "completed",
      verified,
      queued.startedAt
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).costs).toEqual(costs);
  });

  it("records retry progress without changing the stored cost assumptions", async () => {
    const queued = job();
    vi.mocked(claimQueuedBacktests).mockResolvedValue([queued as never]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "service unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ metrics: { overall: { trades: 1 } }, assumptions: verified }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(processBacktests()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, stale: 0 });
    expect(updateBacktestProgress).toHaveBeenCalledWith(
      queued.id,
      expect.objectContaining({ stage: "retry", attempts: 2, lastAttempt: 1, classification: "research_service_error" }),
      queued.startedAt
    );
    expect(finishBacktest).toHaveBeenCalledWith(
      queued.id,
      expect.objectContaining({ progress: { stage: "completed", attempts: 2 } }),
      "completed",
      verified,
      queued.startedAt
    );
  });

  it("preserves explicit costs and accurate attempts on failure", async () => {
    const queued = job();
    vi.mocked(claimQueuedBacktests).mockResolvedValue([queued as never]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "invalid costs" }), { status: 400 })));

    await expect(processBacktests()).resolves.toEqual({ claimed: 1, completed: 0, failed: 1, stale: 0 });
    expect(finishBacktest).toHaveBeenCalledWith(
      queued.id,
      expect.objectContaining({ failureClassification: "validation_error", transient: false, progress: { stage: "failed", attempts: 1 } }),
      "failed",
      costs,
      queued.startedAt
    );
  });

  it("labels failed legacy runs without inventing costs", async () => {
    const queued = job({});
    vi.mocked(claimQueuedBacktests).mockResolvedValue([queued as never]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(processBacktests()).resolves.toEqual({ claimed: 1, completed: 0, failed: 1, stale: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(finishBacktest).toHaveBeenCalledWith(
      queued.id,
      expect.objectContaining({ legacyCostDataUnverified: true, failureClassification: "validation_error" }),
      "failed",
      { legacyCostDataUnverified: true },
      queued.startedAt
    );
  });

  it("does not report success when a stale claim cannot finish", async () => {
    const queued = job();
    vi.mocked(claimQueuedBacktests).mockResolvedValue([queued as never]);
    vi.mocked(finishBacktest).mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ metrics: { overall: { trades: 1 } }, assumptions: verified }), { status: 200 })));

    await expect(processBacktests()).resolves.toEqual({ claimed: 1, completed: 0, failed: 0, stale: 1 });
  });
});
