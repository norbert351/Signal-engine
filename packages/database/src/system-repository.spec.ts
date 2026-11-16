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
  let backtests: typeof import("./backtest-repository.js");
  let ingestion: typeof import("./ingestion-repository.js");
  let scanner: typeof import("./scanner-repository.js");
  let intelligence: typeof import("./intelligence-repository.js");
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
    backtests = await import("./backtest-repository.js");
    ingestion = await import("./ingestion-repository.js");
    scanner = await import("./scanner-repository.js");
    intelligence = await import("./intelligence-repository.js");
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

  it("seeds the twelve_data forex universe and persists null-volume forex candles", async () => {
    const rows = await db.select().from(schema.instruments).where(eq(schema.instruments.provider, "twelve_data"));
    const forex = rows.filter((row) => row.market === "forex");
    expect(forex.map((row) => row.symbol).sort()).toEqual(["EUR_JPY", "EUR_USD", "GBP_USD", "USD_JPY", "XAU_USD"]);
    expect(forex.every((row) => row.enabled)).toBe(true);
    const eurusd = forex.find((row) => row.symbol === "EUR_USD")!;
    const inserted = await ingestion.persistNormalizedCandles(eurusd.id, "twelve_data", [
      {
        interval: "1h",
        openTime: new Date("2026-01-05T10:00:00Z"),
        closeTime: new Date("2026-01-05T10:59:59Z"),
        open: "1.1",
        high: "1.2",
        low: "1.0",
        close: "1.15",
        volume: null,
        complete: true
      }
    ]);
    expect(inserted).toBe(1);
    const stored = await db.select().from(schema.candles).where(eq(schema.candles.instrumentId, eurusd.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.volume).toBeNull();
    expect(stored[0]?.source).toBe("twelve_data");
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
    const backtest = await admin.createBacktest({ strategyKey: strategy!.key, strategyVersion: strategy!.version, timeframe: "1h", dataset: { start: new Date().toISOString() }, assumptions: { fee_bps_per_side: 5, spread_bps: 2, slippage_bps: 2, funding_bps_per_8h: 0 } });
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

  it("claims, resets, and reclaims stale running backfill jobs", async () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-02T00:00:00Z");
    const requested = await admin.requestBackfill({ provider: "binance_usdm", symbol: "TESTA", timeframe: "1h", startTime: start, endTime: end });
    expect(requested?.status).toBe("requested");
    const claimed = await ingestion.claimBackfillRequests(5);
    const job = claimed.find((item) => item.id === requested!.id);
    expect(job?.status).toBe("running");

    // Simulate worker interruption leaving backfill stuck in running for >15m
    const cursorMidpoint = new Date("2026-01-01T12:00:00Z");
    await db
      .update(schema.backfillProgress)
      .set({ cursorTime: cursorMidpoint, updatedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(schema.backfillProgress.id, requested!.id));
    const reclaimed = await ingestion.claimBackfillRequests(5);
    const reclaimedJob = reclaimed.find((item) => item.id === requested!.id);
    expect(reclaimedJob?.status).toBe("running");
    expect(reclaimedJob?.cursorTime.getTime()).toBe(cursorMidpoint.getTime());

    const reset = await admin.resetBackfill(requested!.id);
    expect(reset?.status).toBe("requested");
    expect(reset?.cursorTime.getTime()).toBe(start.getTime());
  });

  it("claims queued backtests once and only finishes with the active claim token", async () => {
    const strategy = await admin.createStrategyVersion({ key: "backtest-claim-strategy", name: "Backtest Claim", parameters: {}, riskConfig: {} });
    const costs = { fee_bps_per_side: 5, spread_bps: 2, slippage_bps: 2, funding_bps_per_8h: 0 };
    const queued = await admin.createBacktest({ strategyKey: strategy!.key, strategyVersion: strategy!.version, timeframe: "1h", dataset: { start: new Date().toISOString() }, assumptions: costs });
    const first = await backtests.claimQueuedBacktests(50);
    const job = first.find((item) => item.id === queued!.id);
    expect(job?.status).toBe("running");
    expect(job?.startedAt).toBeInstanceOf(Date);
    expect((job?.metrics as { progress?: { stage?: string } })?.progress?.stage).toBe("running");
    const duplicate = await backtests.claimQueuedBacktests(50);
    expect(duplicate.find((item) => item.id === queued!.id)).toBeUndefined();

    const secondQueued = await admin.createBacktest({ strategyKey: strategy!.key, strategyVersion: strategy!.version, timeframe: "1h", dataset: { start: new Date().toISOString() }, assumptions: costs });
    const [workerA, workerB] = await Promise.all([backtests.claimQueuedBacktests(50), backtests.claimQueuedBacktests(50)]);
    expect([...workerA, ...workerB].filter((item) => item.id === secondQueued!.id)).toHaveLength(1);
    const secondJob = [...workerA, ...workerB].find((item) => item.id === secondQueued!.id);
    expect(await backtests.finishBacktest(secondQueued!.id, { consumed: true }, "completed", costs, secondJob!.startedAt!)).toBe(true);

    const wrongToken = new Date(job!.startedAt!.getTime() - 1);
    expect(await backtests.updateBacktestProgress(queued!.id, { stage: "retry", attempts: 2 }, wrongToken)).toBe(false);
    expect(await backtests.updateBacktestProgress(queued!.id, { stage: "retry", attempts: 2 }, job!.startedAt!)).toBe(true);
    expect(await backtests.finishBacktest(queued!.id, { progress: { stage: "completed" } }, "completed", { ...costs, explicit: true, version: "costs-v1" }, wrongToken)).toBe(false);
    let [stored] = await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, queued!.id));
    expect(stored?.status).toBe("running");

    expect(await backtests.finishBacktest(queued!.id, { overall: { trades: 1 } }, "completed", { ...costs, explicit: true, version: "costs-v1" }, job!.startedAt!)).toBe(true);
    [stored] = await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, queued!.id));
    expect(stored?.status).toBe("completed");
    expect((stored?.assumptions as Record<string, unknown>).version).toBe("costs-v1");
    const listed = (await admin.listBacktests()).find((item) => item.id === queued!.id);
    expect(listed?.legacyCostDataUnverified).toBe(false);

    expect(await backtests.finishBacktest(queued!.id, { overwritten: true }, "failed", undefined, job!.startedAt!)).toBe(false);
    [stored] = await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, queued!.id));
    expect(stored?.status).toBe("completed");
    expect(stored?.metrics).toEqual({ overall: { trades: 1 } });

    await expect(admin.createBacktest({ strategyKey: strategy!.key, strategyVersion: strategy!.version, timeframe: "1h", dataset: { start: new Date().toISOString() }, assumptions: {} })).rejects.toThrow(/Explicit cost assumptions/);
    const [legacy] = await db.insert(schema.backtestRuns).values({ strategyKey: strategy!.key, strategyVersion: strategy!.version, timeframe: "1h", dataset: { start: new Date().toISOString() }, assumptions: {}, parameters: {}, status: "completed", completedAt: new Date() }).returning();
    const legacyListed = (await admin.listBacktests()).find((item) => item.id === legacy!.id);
    expect(legacyListed?.legacyCostDataUnverified).toBe(true);
  });

  it("reclaims stale running backtests without letting the old worker finish them", async () => {
    const strategy = await admin.createStrategyVersion({ key: "backtest-stale-strategy", name: "Backtest Stale", parameters: {}, riskConfig: {} });
    const costs = { fee_bps_per_side: 5, spread_bps: 2, slippage_bps: 2, funding_bps_per_8h: 0 };
    const queued = await admin.createBacktest({ strategyKey: strategy!.key, strategyVersion: strategy!.version, timeframe: "1h", dataset: { start: new Date().toISOString() }, assumptions: costs });
    const first = (await backtests.claimQueuedBacktests(50)).find((item) => item.id === queued!.id);
    expect(first?.startedAt).toBeInstanceOf(Date);
    await db.update(schema.backtestRuns).set({ startedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(schema.backtestRuns.id, queued!.id));
    const reclaimed = (await backtests.claimQueuedBacktests(50)).find((item) => item.id === queued!.id);
    expect(reclaimed?.status).toBe("running");
    expect(reclaimed!.startedAt!.getTime()).toBeGreaterThan(first!.startedAt!.getTime());
    expect((reclaimed?.metrics as { progress?: { stage?: string; reclaimed?: boolean } })?.progress).toMatchObject({ stage: "reclaimed", reclaimed: true });

    expect(await backtests.updateBacktestProgress(queued!.id, { stage: "retry" }, first!.startedAt!)).toBe(false);
    expect(await backtests.finishBacktest(queued!.id, { worker: "old" }, "completed", costs, first!.startedAt!)).toBe(false);
    let [stored] = await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, queued!.id));
    expect(stored?.status).toBe("running");

    expect(await backtests.finishBacktest(queued!.id, { worker: "new" }, "completed", costs, reclaimed!.startedAt!)).toBe(true);
    [stored] = await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, queued!.id));
    expect(stored?.status).toBe("completed");
    expect(stored?.metrics).toEqual({ worker: "new" });
  });

  it("deduplicates notification outbox entries and recovers interrupted sending notifications", async () => {
    const firstCount = await scanner.enqueueNotification({
      eventType: "TEST_ALERT",
      eventKey: "phase5:dedupe:key",
      message: "Test alert message",
      destinations: ["chat-test-1"]
    });
    const duplicateCount = await scanner.enqueueNotification({
      eventType: "TEST_ALERT",
      eventKey: "phase5:dedupe:key",
      message: "Test alert message",
      destinations: ["chat-test-1"]
    });
    expect(firstCount).toBe(1);
    expect(duplicateCount).toBe(0);

    const due = await scanner.getDueNotifications(new Date(), 50);
    const item = due.find((row) => row.destination === "chat-test-1");
    expect(item).toBeDefined();

    // While in 'sending' with future nextAttemptAt, a second worker cannot claim it
    const concurrentDue = await scanner.getDueNotifications(new Date(), 50);
    expect(concurrentDue.find((row) => row.id === item!.id)).toBeUndefined();

    // After lease expiry (5m), an interrupted 'sending' notification is reclaimed
    const afterLease = new Date(Date.now() + 6 * 60_000);
    const reclaimedDue = await scanner.getDueNotifications(afterLease, 50);
    expect(reclaimedDue.find((row) => row.id === item!.id)).toBeDefined();
  });

  it("reports backtest operational summary and database volume metrics", async () => {
    const btSummary = await system.backtestOperationalSummary();
    expect(btSummary.completed).toBeGreaterThanOrEqual(1);
    expect(typeof btSummary.staleRunning).toBe("number");

    const dbVol = await system.databaseVolumeSummary();
    expect(dbVol.sizeBytes).toBeGreaterThan(0);
    expect(dbVol.activeConnections).toBeGreaterThanOrEqual(1);
    expect(dbVol.maxConnections).toBeGreaterThanOrEqual(10);
  });

  it("persists news articles, extracted events, global events, AI runs, event signals, outcomes, and intelligence reports while keeping all strategies disabled", async () => {
    const eventStrategies = await intelligence.listEventStrategies();
    expect(eventStrategies.map((s) => s.key).sort()).toEqual([
      "post-event-momentum",
      "post-event-reversal",
      "pre-event-positioning"
    ]);
    expect(eventStrategies.every((s) => !s.enabled && !s.approved)).toBe(true);

    const [tonRow] = await db.select().from(schema.instruments).where(eq(schema.instruments.symbol, "TONUSDT"));
    expect(tonRow?.enabled).toBe(false);
    expect(tonRow?.available).toBe(false);

    const sources = await intelligence.listNewsSources();
    expect(sources.length).toBeGreaterThanOrEqual(6);

    const articleResult = await intelligence.persistNormalizedNewsArticle({
      sourceKey: "federal_reserve_rss",
      url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261116a.htm",
      title: "Federal Reserve releases FOMC statement on inflation and interest rates",
      summary: "Committee maintains data-dependent monetary policy stance.",
      contentSnippet: "Inflation and labor market conditions monitored closely.",
      publishedAt: new Date("2026-11-16T14:00:00Z"),
      collectedAt: new Date("2026-11-16T14:00:10Z"),
      contentHash: "hash_fomc_20261116_01",
      titleFingerprint: "fp_fomc_20261116_01",
      category: "central_bank_decisions",
      importance: "high",
      directionBias: "neutral",
      credibilityScore: 98,
      relevanceScore: 90,
      entities: [{ entityType: "central_bank", canonicalName: "Federal Reserve", code: "FED", role: "primary", confidence: 95 }],
      facts: [{ factType: "statement", statement: "FOMC statement released", exactQuantityVerified: false }],
      affectedInstruments: [
        { symbol: "BTCUSDT", market: "crypto_perpetual", relationshipType: "macro_driver", directionHypothesis: "neutral", relevanceScore: 85 },
        { symbol: "EUR_USD", market: "forex", relationshipType: "macro_driver", directionHypothesis: "neutral", relevanceScore: 90 }
      ]
    });
    expect(articleResult.isDuplicate).toBe(false);
    expect(articleResult.newsEvent?.category).toBe("central_bank_decisions");

    const aiSaved = await intelligence.persistAiAnalysisRun({
      articleId: articleResult.article.id,
      newsEventId: articleResult.newsEvent!.id,
      providerKey: "deterministic_fallback",
      modelName: "deterministic-reasoning-v1",
      taskLayer: "layer2_reasoning",
      taskKey: "news_layer2_reasoning",
      promptVersion: "v1",
      inputSnapshot: { articleId: articleResult.article.id },
      outputPayload: { schemaVersion: "news-l2-v1" },
      validation: {
        valid: true,
        status: "validated",
        checksPassed: ["schema_version_valid", "source_references_present"],
        checksFailed: [],
        downgraded: false,
        notes: "Valid"
      },
      durationMs: 12,
      inputTokens: 120,
      outputTokens: 180,
      estimatedCostUsd: 0,
      structuredFacts: [{ statement: "FOMC statement", sourceUrl: articleResult.article.url }],
      interpretations: [{ thesis: "Macro watch", directionBias: "neutral", affectedSymbols: ["BTCUSDT", "EUR_USD"] }],
      scenarios: [],
      affectedAssets: [{ symbol: "BTCUSDT" }]
    });
    expect(aiSaved.run.validationStatus).toBe("validated");

    const econEvent = await intelligence.persistNormalizedGlobalEvent({
      dedupeKey: "US:USD:us-cpi-yoy:2026-11-16T13:30",
      sourceKey: "official_central_bank_calendar",
      eventType: "scheduled_economic",
      category: "inflation_announcements",
      eventName: "US CPI YoY",
      country: "US",
      currency: "USD",
      scheduledAt: new Date("2026-11-16T13:30:00Z"),
      publishedAt: new Date("2026-11-16T13:30:03Z"),
      collectedAt: new Date("2026-11-16T13:30:05Z"),
      timezone: "UTC",
      previousValue: 3.1,
      revisedPreviousValue: null,
      consensusValue: 3.0,
      actualValue: 2.8,
      unit: "pct",
      importance: "high",
      status: "monitoring_reaction",
      isScheduled: true,
      surprise: { hasActualAndConsensus: true, surpriseValue: -0.2, surprisePct: -6.6667 },
      verifiedEvidence: [{ sourceUrl: "https://www.bls.gov/cpi/", headline: "US CPI 2.8%", verifiedAt: "2026-11-16T13:30:03Z" }]
    });
    expect(econEvent.status).toBe("monitoring_reaction");

    const evSignal = await intelligence.persistEventSignal({
      dedupeKey: "evsig:test:us-cpi:BTCUSDT:15m:post-event-momentum",
      eventId: econEvent.id,
      strategyKey: "post-event-momentum",
      strategyType: "post_event_momentum",
      eventCategory: "inflation_announcements",
      eventName: "US CPI YoY",
      symbol: "BTCUSDT",
      market: "crypto_perpetual",
      timeframe: "15m",
      confirmationTimeframe: "1h",
      direction: "LONG",
      actionClassification: "LONG",
      entryPrice: 91500,
      stopLoss: 90800,
      targets: [92900, 93600],
      rewardRisk: 2.0,
      eventImportance: "high",
      riskClassification: "MODERATE_RISK",
      scheduledEventAt: econEvent.scheduledAt,
      actualEventAt: econEvent.publishedAt,
      sourceReferences: ["https://www.bls.gov/cpi/"],
      quantitativeEvidence: { displacementAtr: 1.35 },
      aiAnalysisId: aiSaved.analysis.id,
      scoreBreakdown: { strategyEnabled: false, strategyApproved: false },
      validationStatus: "approved",
      outcomeStatus: "pending_validation",
      estimatedSlippageBps: 5,
      expiresAt: new Date("2026-11-16T16:30:00Z")
    });
    expect(evSignal.validationStatus).toBe("approved");
    expect(evSignal.outcomeStatus).toBe("pending_validation");

    // Verify Flow #9: Event signal to historical outcome resolution
    const resolvedOutcome = await intelligence.updateEventSignalOutcome({
      eventSignalId: evSignal.id,
      status: "target_hit",
      observedEntryAssumption: 91520,
      exitPrice: 92900,
      exitTime: new Date("2026-11-16T14:30:00Z"),
      netReturn: 0.013578,
      maxFavorableExcursion: 0.016,
      maxAdverseExcursion: 0.002,
      holdingSeconds: 2700,
      closedReason: "target_hit"
    });
    expect(resolvedOutcome.status).toBe("target_hit");
    expect(Number(resolvedOutcome.netReturn)).toBeCloseTo(0.013578, 5);

    // Verify event revision audit trail in event_updates
    const revisedEconEvent = await intelligence.persistNormalizedGlobalEvent({
      dedupeKey: "US:USD:us-cpi-yoy:2026-11-16T13:30",
      sourceKey: "official_central_bank_calendar",
      eventType: "scheduled_economic",
      category: "inflation_announcements",
      eventName: "US CPI YoY",
      country: "US",
      currency: "USD",
      scheduledAt: new Date("2026-11-16T13:30:00Z"),
      publishedAt: new Date("2026-11-16T13:30:02Z"),
      collectedAt: new Date("2026-11-16T14:00:00Z"),
      timezone: "UTC",
      previousValue: 3.1,
      revisedPreviousValue: 3.2,
      consensusValue: 3.0,
      actualValue: 2.8,
      unit: "pct",
      importance: "high",
      status: "revised",
      isScheduled: true,
      surprise: { hasActualAndConsensus: true, surpriseValue: -0.2, surprisePct: -6.6667 },
      verifiedEvidence: [{ sourceUrl: "https://www.bls.gov/cpi/", headline: "US CPI revised", verifiedAt: "2026-11-16T14:00:00Z" }]
    });
    expect(revisedEconEvent.status).toBe("revised");
    const updateRows = await db.select().from(schema.eventUpdates).where(eq(schema.eventUpdates.eventId, econEvent.id));
    expect(updateRows.some((u) => u.fieldChanged === "revised_previous_value")).toBe(true);

    // Verify Flow #5: Market event correlation persistence
    const corrRow = await intelligence.recordMarketEventCorrelation({
      eventId: econEvent.id,
      symbol: "BTCUSDT",
      timeframe: "15m",
      reaction15mPct: 1.12,
      reaction1hPct: 1.85,
      reaction4hPct: 2.1,
      volumeRatio: 1.65,
      volatilityRatio: 1.48
    });
    expect(corrRow.symbol).toBe("BTCUSDT");

    const evBt = await intelligence.persistEventBacktestRun({
      strategyKey: "post-event-momentum",
      symbol: "BTCUSDT",
      timeframe: "15m",
      dataset: { eventsCount: 1 },
      assumptions: { feeBpsPerSide: 5, spreadBps: 4, slippageBps: 3, explicit: true },
      parameters: {},
      metrics: { promotionClassification: "insufficient_evidence", overall: { trades: 1 } },
      trades: [
        {
          eventDedupeKey: econEvent.dedupeKey,
          symbol: "BTCUSDT",
          strategyKey: "post-event-momentum",
          direction: "LONG",
          entryTimeMs: Date.parse("2026-11-16T13:45:00Z"),
          exitTimeMs: Date.parse("2026-11-16T14:30:00Z"),
          observedEntry: 91520,
          exitPrice: 92900,
          grossReturn: 0.015078,
          netReturn: 0.013578,
          slippageBps: 5,
          outcome: "target_hit"
        }
      ]
    });
    expect(evBt.status).toBe("completed");

    const report = await intelligence.persistIntelligenceReportRecord({
      reportKey: "daily_summary:2026-11-16T14",
      reportType: "daily_summary",
      title: "Daily Market & Event Intelligence Summary",
      summary: "Processed FOMC and US CPI events.",
      marketRegime: "event_driven_volatility",
      sections: [{ heading: "Events", items: [] }],
      evidenceRefs: [{ type: "economic_event", ref: econEvent.dedupeKey }],
      riskWarnings: ["Post-CPI volatility active"]
    });
    expect(report.marketRegime).toBe("event_driven_volatility");

    // Re-persist same reportKey to verify idempotent replacement of intelligence_evidence
    await intelligence.persistIntelligenceReportRecord({
      reportKey: "daily_summary:2026-11-16T14",
      reportType: "daily_summary",
      title: "Daily Market & Event Intelligence Summary (Updated)",
      summary: "Updated summary.",
      marketRegime: "event_driven_volatility",
      sections: [{ heading: "Events", items: [] }],
      evidenceRefs: [{ type: "economic_event", ref: econEvent.dedupeKey }],
      riskWarnings: ["Post-CPI volatility active"]
    });
    const evRows = await db
      .select()
      .from(schema.intelligenceEvidence)
      .where(eq(schema.intelligenceEvidence.reportId, report.id));
    expect(evRows).toHaveLength(1);
  });
});
