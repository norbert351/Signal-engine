import { readdir, readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(testUrl) && /test/i.test(new URL(testUrl!).pathname);
const suite = describe.skipIf(!enabled);

suite("database integration", () => {
  let client: import("postgres").Sql;
  let db: typeof import("./index.js").db;
  let schema: typeof import("./schema.js");
  let system: typeof import("./system-repository.js");
  let admin: typeof import("./admin-repository.js");
  let ingestion: typeof import("./ingestion-repository.js");
  let sql: typeof import("./index.js").sql;

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    const postgres = (await import("postgres")).default;
    client = postgres(testUrl!, { max: 1 });
    await client.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    const directory = new URL("../drizzle/", import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) {
      await client.unsafe(await readFile(new URL(name, directory), "utf8"));
    }
    const database = await import("./index.js");
    sql = database.sql;
    db = database.db;
    schema = await import("./schema.js");
    system = await import("./system-repository.js");
    admin = await import("./admin-repository.js");
    ingestion = await import("./ingestion-repository.js");
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await client?.end({ timeout: 5 });
  });

  it("keeps instruments disabled when the provider reports them unavailable", async () => {
    const created = await ingestion.ensureInstrument("test_provider", "crypto_perpetual", "TESTA", { available: false });
    expect(created.enabled).toBe(false);
    const updated = await ingestion.ensureInstrument("test_provider", "crypto_perpetual", "TESTA", { available: true });
    expect(updated.enabled).toBe(false);
    const fresh = await ingestion.ensureInstrument("test_provider", "crypto_perpetual", "TESTB");
    expect(fresh.enabled).toBe(true);
  });

  it("persists normalized candles and maps lifecycle timestamp columns", async () => {
    const instrument = await ingestion.ensureInstrument("test_provider", "crypto_perpetual", "TESTC");
    const inserted = await ingestion.persistNormalizedCandles(instrument.id, "test_provider", [
      {
        interval: "1h",
        openTime: new Date("2026-01-01T00:00:00Z"),
        closeTime: new Date("2026-01-01T00:59:59Z"),
        open: "100",
        high: "101",
        low: "99",
        close: "100.5",
        volume: "10",
        complete: true
      }
    ]);
    expect(inserted).toBe(1);
    const rows = await db.select().from(schema.candles).where(eq(schema.candles.instrumentId, instrument.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ingestedAt).toBeInstanceOf(Date);
    await expect(db.select().from(schema.signalEvents).limit(0)).resolves.toEqual([]);
  });

  it("creates versioned strategy configs with parameter hashes", async () => {
    const first = await admin.createStrategyVersion({ key: "integration-strategy", name: "Integration", parameters: { emaFast: 20 }, riskConfig: { minimumRewardRisk: 2 } });
    const second = await admin.createStrategyVersion({ key: "integration-strategy", name: "Integration", parameters: { emaFast: 21 }, riskConfig: { minimumRewardRisk: 2 } });
    expect(first?.version).toBe(1);
    expect(second?.version).toBe(2);
    expect(first?.approved).toBe(false);
    expect(first?.enabled).toBe(false);
    expect(first?.parameterHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.parameterHash).not.toBe(second?.parameterHash);
  });

  it("blocks activation and approval until a sufficiently sampled backtest exists", async () => {
    const strategy = await admin.createStrategyVersion({ key: "approval-strategy", name: "Approval", parameters: {}, riskConfig: {} });
    await expect(admin.setStrategyEnabled(strategy!.id, true)).rejects.toThrow(/approved/);
    const backtest = await admin.createBacktest({ strategyKey: strategy!.key, strategyVersion: strategy!.version, timeframe: "1h", dataset: { start: new Date().toISOString() }, assumptions: {} });
    await db
      .update(schema.backtestRuns)
      .set({ status: "completed", completedAt: new Date(), metrics: { overall: { trades: 4 }, outOfSample: { trades: 1 }, outOfSampleBars: 10 } })
      .where(eq(schema.backtestRuns.id, backtest!.id));
    await expect(admin.setStrategyApproval(strategy!.id, true, "Insufficient sample for approval review")).rejects.toThrow(/at least/);
    await db
      .update(schema.backtestRuns)
      .set({ metrics: { overall: { trades: 40 }, outOfSample: { trades: 20 }, outOfSampleBars: 200 } })
      .where(eq(schema.backtestRuns.id, backtest!.id));
    const approved = await admin.setStrategyApproval(strategy!.id, true, "Out-of-sample sample and risk checks reviewed");
    expect(approved?.approved).toBe(true);
    const enabled = await admin.setStrategyEnabled(strategy!.id, true);
    expect(enabled?.enabled).toBe(true);
  });

  it("deduplicates and reopens alerts with notification cycles", async () => {
    const first = await system.upsertAlert({ component: "integration", dedupeKey: "integration:test", message: "first" });
    expect(first.isNew).toBe(true);
    const second = await system.upsertAlert({ component: "integration", dedupeKey: "integration:test", message: "second" });
    expect(second.isNew).toBe(false);
    expect(second.alert.count).toBe(2);
    const resolved = await system.resolveAlert("integration:test");
    expect(resolved?.resolvedAt).not.toBeNull();
    const reopened = await system.upsertAlert({ component: "integration", dedupeKey: "integration:test", message: "third" });
    expect(reopened.isNew).toBe(true);
    expect(reopened.alert.count).toBe(1);
  });

  it("records component health", async () => {
    await system.recordHealth("integration:health", "degraded", { reason: "test" });
    const rows = await system.listHealth();
    const row = rows.find((item) => item.component === "integration:health");
    expect(row?.status).toBe("degraded");
    expect((row?.details as { reason: string }).reason).toBe("test");
  });

  it("claims and resets requested backfill jobs", async () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-02T00:00:00Z");
    const requested = await admin.requestBackfill({ provider: "binance_usdm", symbol: "TESTA", timeframe: "1h", startTime: start, endTime: end });
    expect(requested?.status).toBe("requested");
    const claimed = await ingestion.claimBackfillRequests(5);
    const job = claimed.find((item) => item.id === requested!.id);
    expect(job?.status).toBe("running");
    const reset = await admin.resetBackfill(requested!.id);
    expect(reset?.status).toBe("requested");
    expect(reset?.cursorTime.getTime()).toBe(start.getTime());
  });
});

