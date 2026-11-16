import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scannerMocks = vi.hoisted(() => ({
  getDueNotifications: vi.fn(),
  updateNotification: vi.fn(),
  enqueueNotification: vi.fn()
}));

const dbMocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  selectFrom: vi.fn()
}));

vi.mock("@signal-engine/database/scanner-repository", () => ({
  getDueNotifications: scannerMocks.getDueNotifications,
  updateNotification: scannerMocks.updateNotification,
  enqueueNotification: scannerMocks.enqueueNotification
}));

vi.mock("@signal-engine/database", () => ({
  sql: Object.assign(vi.fn(async () => [{ "?column?": 1 }]), { end: vi.fn(async () => undefined) }),
  db: {
    insert: () => ({
      values: (vals: unknown) => {
        dbMocks.insertValues(vals);
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "notif-test-1" }]
          })
        };
      }
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => []
        })
      })
    })
  },
  notificationOutbox: { id: "id" },
  signals: { id: "id" }
}));

import { errorText, redactSecretsFromText } from "./format.js";
import { evaluateWorkerHealthRows, resolveExpectedWorkerComponents } from "./healthcheck.js";
import { evaluateRoleRuntimeHealth } from "./main.js";
import { evaluateScannerEligibility, twelveDataQuotaState } from "./monitoring.js";
import { classifyTelegramFailure, deliverPending, enqueuePrivateTestNotification } from "./telegram.js";

describe("Phase 5 worker operational resilience, notifications, and monitoring", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    scannerMocks.getDueNotifications.mockReset().mockResolvedValue([]);
    scannerMocks.updateNotification.mockReset().mockResolvedValue(undefined);
    dbMocks.insertValues.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("evaluates worker runtime health and detects stalled or disconnected workers", () => {
    const now = Date.now();
    const healthy = evaluateRoleRuntimeHealth(
      {
        role: "scanner",
        startedAt: new Date(now - 120_000).toISOString(),
        startedAtMs: now - 120_000,
        expectedIntervalMs: 60_000,
        lastCompletedAt: new Date(now - 20_000).toISOString(),
        lastCompletedAtMs: now - 20_000,
        consecutiveFailures: 0,
        activeJobs: 0
      },
      { workerRunning: true, redisReady: true, nowMs: now }
    );
    expect(healthy.status).toBe("ok");
    expect(healthy.stalled).toBe(false);

    const stalled = evaluateRoleRuntimeHealth(
      {
        role: "scanner",
        startedAt: new Date(now - 20 * 60_000).toISOString(),
        startedAtMs: now - 20 * 60_000,
        expectedIntervalMs: 60_000,
        lastCompletedAt: new Date(now - 15 * 60_000).toISOString(),
        lastCompletedAtMs: now - 15 * 60_000,
        consecutiveFailures: 0,
        activeJobs: 0
      },
      { workerRunning: true, redisReady: true, nowMs: now }
    );
    expect(stalled.status).toBe("error");
    expect(stalled.stalled).toBe(true);

    const checkResult = evaluateWorkerHealthRows(
      [{ component: "worker:scanner", status: "ok", checkedAt: new Date(now - 10_000), details: healthy.details }],
      resolveExpectedWorkerComponents("scanner"),
      now,
      180_000
    );
    expect(checkResult.ok).toBe(true);

    const failedCheck = evaluateWorkerHealthRows(
      [{ component: "worker:scanner", status: "ok", checkedAt: new Date(now - 10_000), details: stalled.details }],
      ["worker:scanner"],
      now,
      180_000
    );
    expect(failedCheck.ok).toBe(false);
    expect(failedCheck.reason).toMatch(/stalled/);
  });

  it("classifies Telegram failures and handles permanent vs transient errors with token redaction", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "999888777:AAH_secret_telegram_token_xyz";

    expect(classifyTelegramFailure(new Error("Telegram HTTP 400: Bad Request: chat not found"), 400)).toMatchObject({
      classification: "invalid_chat_id",
      permanent: true
    });
    expect(classifyTelegramFailure(new Error("Telegram HTTP 401: Unauthorized"), 401)).toMatchObject({
      classification: "bot_unauthorized",
      permanent: true
    });
    expect(classifyTelegramFailure(new Error("Telegram HTTP 429: Too Many Requests: retry after 15"), 429, 15)).toMatchObject({
      classification: "rate_limit",
      permanent: false,
      retryDelayMs: 15_000
    });
    expect(classifyTelegramFailure(new Error("The operation was aborted due to timeout"))).toMatchObject({
      classification: "timeout",
      permanent: false
    });

    scannerMocks.getDueNotifications.mockResolvedValue([
      { id: "n-invalid-chat", destination: "-100999", message: "Test 1", attempts: 0 },
      { id: "n-timeout", destination: "12345", message: "Test 2", attempts: 0 },
      { id: "n-ok", destination: "12345", message: "Test 3", attempts: 1 }
    ]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })
      )
      .mockRejectedValueOnce(new Error(`Request to https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage timed out`))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const summary = await deliverPending();
    expect(summary).toEqual({ delivered: 1, failed: 1, retried: 1, checked: 3 });

    expect(scannerMocks.updateNotification).toHaveBeenNthCalledWith(
      1,
      "n-invalid-chat",
      expect.objectContaining({
        status: "failed",
        attempts: 1,
        lastError: expect.stringContaining("[invalid_chat_id]")
      })
    );
    expect(scannerMocks.updateNotification).toHaveBeenNthCalledWith(
      2,
      "n-timeout",
      expect.objectContaining({
        status: "pending",
        attempts: 1,
        lastError: expect.stringContaining("[timeout]")
      })
    );
    const secondCallError = String(scannerMocks.updateNotification.mock.calls[1]?.[1]?.lastError ?? "");
    expect(secondCallError).not.toContain("AAH_secret_telegram_token_xyz");
    expect(secondCallError).toContain("bot[redacted]");

    expect(scannerMocks.updateNotification).toHaveBeenNthCalledWith(
      3,
      "n-ok",
      expect.objectContaining({
        status: "delivered",
        attempts: 2,
        providerMessageId: "42"
      })
    );
  });

  it("enforces private test chat isolation and refuses to send test notifications to main chat IDs", async () => {
    delete process.env.TELEGRAM_TEST_CHAT_ID;
    await expect(enqueuePrivateTestNotification()).resolves.toEqual({
      enqueued: false,
      reason: "TELEGRAM_TEST_CHAT_ID_not_configured"
    });

    process.env.TELEGRAM_CHAT_IDS = "-100111222333";
    process.env.TELEGRAM_TEST_CHAT_ID = "-100111222333";
    await expect(enqueuePrivateTestNotification()).rejects.toThrow(/Refusing to send test notification/);

    process.env.TELEGRAM_TEST_CHAT_ID = "777000111";
    const res = await enqueuePrivateTestNotification({ label: "unit-test" });
    expect(res.enqueued).toBe(true);
    expect(res.destination).toBe("777000111");
    expect(dbMocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: "777000111",
        eventType: "TEST_NOTIFICATION",
        message: expect.stringContaining("[TEST ONLY — NOT A TRADING SIGNAL]")
      })
    );
  });

  it("computes scanner eligibility and Twelve Data quota state accurately", () => {
    const wednesday = new Date("2026-11-11T12:00:00.000Z");
    const recent = new Date("2026-11-11T11:59:00.000Z");
    const stale = new Date("2026-11-10T00:00:00.000Z");
    const rows = [
      { provider: "binance_usdm", symbol: "BTCUSDT", market: "crypto_perpetual", timeframe: "1m", latest: recent, candles: 200 },
      { provider: "binance_usdm", symbol: "BTCUSDT", market: "crypto_perpetual", timeframe: "5m", latest: recent, candles: 200 },
      { provider: "binance_usdm", symbol: "BTCUSDT", market: "crypto_perpetual", timeframe: "15m", latest: recent, candles: 200 },
      { provider: "binance_usdm", symbol: "BTCUSDT", market: "crypto_perpetual", timeframe: "1h", latest: recent, candles: 200 },
      { provider: "binance_usdm", symbol: "BTCUSDT", market: "crypto_perpetual", timeframe: "4h", latest: stale, candles: 200 },
      { provider: "binance_usdm", symbol: "BTCUSDT", market: "crypto_perpetual", timeframe: "1d", latest: recent, candles: 20 }
    ];
    const eligibility = evaluateScannerEligibility(rows, wednesday);
    expect(eligibility.totalPairs).toBe(5);
    expect(eligibility.eligibleCount).toBe(3);
    expect(eligibility.eligiblePairs).toEqual([
      "binance_usdm:BTCUSDT:1m/5m",
      "binance_usdm:BTCUSDT:5m/15m",
      "binance_usdm:BTCUSDT:15m/1h"
    ]);
    expect(eligibility.blockedByReason.stale_trend_candle).toBe(1);
    expect(eligibility.blockedByReason.insufficient_history).toBe(1);

    const quota = twelveDataQuotaState({
      dailyUsage: 640,
      planDailyLimit: 800,
      planLimit: 8,
      planCategory: "basic"
    });
    expect(quota.effectiveDailyBudget).toBe(640);
    expect(quota.remaining).toBe(0);
  });

  it("redacts sensitive values in worker errorText", () => {
    process.env.TWELVE_DATA_API_KEY = "my-secret-td-key";
    expect(errorText(new Error("Request failed with key my-secret-td-key"))).toBe("Request failed with key [redacted]");
    expect(redactSecretsFromText("redis://default:my-redis-pass@redis:6379")).toBe("redis://default:[redacted]@redis:6379");
  });
});
