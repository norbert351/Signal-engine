import {
  AiProviderRegistry,
  CentralIntelligenceService,
  EventNormalizationService,
  FastProcessingLayer,
  NewsIntelligenceService,
  PostEventMomentumService,
  PostEventReversalService,
  PreEventPositioningService,
  type Candle,
  type EventStrategyKey,
  type RawGlobalEventInput,
  type RawNewsArticleInput
} from "@signal-engine/core";
import {
  listEconomicEvents,
  listEventStrategies,
  listNewsArticles,
  persistAiAnalysisRun,
  persistEventSignal,
  persistIntelligenceReportRecord,
  persistNormalizedGlobalEvent,
  persistNormalizedNewsArticle
} from "@signal-engine/database/intelligence-repository";
import { findInstrument, readRecentCandles } from "@signal-engine/database/scanner-repository";

const newsService = new NewsIntelligenceService();

export async function processRawNewsBatch(items: RawNewsArticleInput[]) {
  let ingested = 0;
  let duplicates = 0;
  let updates = 0;
  let aiAnalyzed = 0;

  for (const raw of items) {
    const normalized = newsService.normalizeArticle(raw);
    const persisted = await persistNormalizedNewsArticle({
      ...normalized,
      entities: normalized.entities,
      facts: normalized.facts as unknown as Array<Record<string, unknown>>,
      affectedInstruments: normalized.affectedInstruments,
      rawMetadata: raw.rawMetadata
    });

    if (persisted.isDuplicate) {
      duplicates += 1;
      continue;
    }
    if (persisted.isUpdate) updates += 1;
    else ingested += 1;

    const layer1 = FastProcessingLayer.processArticle(normalized, persisted.isDuplicate);
    if (layer1.eligibleForLayer2) {
      const { output, runRecord } = await AiProviderRegistry.runLayer2Analysis([normalized]);
      await persistAiAnalysisRun({
        articleId: persisted.article.id,
        ...(persisted.newsEvent ? { newsEventId: persisted.newsEvent.id } : {}),
        providerKey: runRecord.providerKey,
        modelName: runRecord.modelName,
        taskLayer: runRecord.taskLayer,
        taskKey: runRecord.taskKey,
        promptVersion: runRecord.promptVersion,
        inputSnapshot: runRecord.inputSnapshot,
        outputPayload: runRecord.outputPayload,
        validation: runRecord.validation,
        durationMs: runRecord.durationMs,
        inputTokens: runRecord.inputTokens,
        outputTokens: runRecord.outputTokens,
        estimatedCostUsd: runRecord.estimatedCostUsd,
        ...(runRecord.errorMessage ? { errorMessage: runRecord.errorMessage } : {}),
        structuredFacts: output.observedFacts as unknown as Array<Record<string, unknown>>,
        interpretations: output.interpretations as unknown as Array<Record<string, unknown>>,
        scenarios: output.possibleScenarios as unknown as Array<Record<string, unknown>>,
        affectedAssets: normalized.affectedInstruments as unknown as Array<Record<string, unknown>>
      });
      aiAnalyzed += 1;
    }
  }

  return { ingested, duplicates, updates, aiAnalyzed };
}

export async function processGlobalEventsBatch(items: RawGlobalEventInput[]) {
  const results = [];
  for (const raw of items) {
    const normalized = EventNormalizationService.normalizeEvent(raw);
    const saved = await persistNormalizedGlobalEvent({
      ...normalized,
      verifiedEvidence: normalized.verifiedEvidence as unknown as Array<Record<string, unknown>>
    });
    results.push({ id: saved.id, dedupeKey: saved.dedupeKey, status: saved.status });
  }
  return { count: results.length, events: results };
}

export async function evaluateEventTradingForEvent(
  rawEvent: RawGlobalEventInput,
  symbol: string,
  timeframe = "15m",
  confirmationTimeframe = "1h",
  strategyKeys: EventStrategyKey[] = ["pre-event-positioning", "post-event-momentum", "post-event-reversal"]
) {
  const normalizedEvent = EventNormalizationService.normalizeEvent(rawEvent);
  const savedEvent = await persistNormalizedGlobalEvent({
    ...normalizedEvent,
    verifiedEvidence: normalizedEvent.verifiedEvidence as unknown as Array<Record<string, unknown>>
  });

  const provider = symbol.includes("_") ? "twelve_data" : "binance_usdm";
  const market = symbol.includes("_") ? ("forex" as const) : ("crypto_perpetual" as const);
  const instrument = await findInstrument(provider, symbol);

  const [entryRows, confirmRows] = instrument
    ? await Promise.all([
        readRecentCandles(instrument.id, timeframe, 120),
        readRecentCandles(instrument.id, confirmationTimeframe, 120)
      ])
    : [[], []];

  const toCore = (rows: typeof entryRows): Candle[] =>
    rows.map((r) => ({
      openTime: r.openTime.getTime(),
      closeTime: r.closeTime.getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      ...(r.volume === null ? {} : { volume: Number(r.volume) }),
      complete: r.isComplete
    }));

  const entryCandles = toCore(entryRows);
  const confirmationCandles = toCore(confirmRows);
  const strategyRows = await listEventStrategies();
  const byKey = new Map(strategyRows.map((s) => [s.key, s]));

  const outputs = [];
  for (const key of strategyKeys) {
    const configRow = byKey.get(key);
    const isEnabledAndApproved = Boolean(configRow?.enabled && configRow?.approved);

    const evalInput = {
      event: normalizedEvent,
      symbol,
      market,
      timeframe,
      confirmationTimeframe,
      entryCandles,
      confirmationCandles,
      instrumentAvailable: instrument ? instrument.enabled && instrument.available : symbol !== "TONUSDT"
    };

    const evaluated =
      key === "pre-event-positioning"
        ? PreEventPositioningService.evaluate(evalInput)
        : key === "post-event-momentum"
          ? PostEventMomentumService.evaluate(evalInput)
          : PostEventReversalService.evaluate(evalInput);

    // Even if quantitatively valid, an unapproved/disabled strategy remains in pending_validation/detected state
    // and is NEVER published to production Telegram or live trading feeds.
    const outcomeStatus =
      evaluated.validationStatus === "approved"
        ? isEnabledAndApproved
          ? "published"
          : "pending_validation"
        : "rejected";

    const persisted = await persistEventSignal({
      dedupeKey: `evsig:${savedEvent.dedupeKey}:${symbol}:${timeframe}:${key}`,
      eventId: savedEvent.id,
      ...(instrument ? { instrumentId: instrument.id } : {}),
      strategyKey: key,
      strategyVersion: configRow?.version ?? 1,
      strategyType: evaluated.strategyType,
      eventCategory: normalizedEvent.category,
      eventName: normalizedEvent.eventName,
      symbol,
      market,
      timeframe,
      confirmationTimeframe,
      direction: evaluated.direction,
      actionClassification: evaluated.actionClassification,
      entryPrice: evaluated.entryPrice,
      stopLoss: evaluated.stopLoss,
      targets: evaluated.targets,
      rewardRisk: evaluated.rewardRisk,
      eventImportance: normalizedEvent.importance,
      riskClassification: evaluated.riskClassification,
      scheduledEventAt: normalizedEvent.scheduledAt,
      actualEventAt: normalizedEvent.publishedAt,
      sourceReferences: normalizedEvent.verifiedEvidence.map((v) => v.sourceUrl),
      quantitativeEvidence: evaluated.quantitativeEvidence,
      scoreBreakdown: {
        strategyEnabled: configRow?.enabled ?? false,
        strategyApproved: configRow?.approved ?? false,
        rationale: evaluated.rationale
      },
      validationStatus: evaluated.validationStatus,
      ...(evaluated.rejectionReason ? { rejectionReason: evaluated.rejectionReason } : {}),
      outcomeStatus,
      estimatedSlippageBps: evaluated.estimatedSlippageBps,
      ...(outcomeStatus === "published" ? { publishedAt: new Date() } : {}),
      expiresAt: new Date(evaluated.expiresAtMs)
    });
    outputs.push(persisted);
  }
  return outputs;
}

export async function generateAndPersistDailyIntelligenceReport() {
  const [recentArticles, recentEvents] = await Promise.all([
    listNewsArticles({ limit: 25 }),
    listEconomicEvents({ limit: 25 })
  ]);

  const normalizedArticles = recentArticles.map((a) =>
    newsService.normalizeArticle({
      sourceKey: "federal_reserve_rss",
      url: a.url,
      title: a.title,
      summary: a.summary ?? "",
      publishedAt: a.publishedAt,
      collectedAt: a.collectedAt
    })
  );

  const normalizedEvents = recentEvents
    .filter((e) => e.scheduledAt !== null || !e.isScheduled)
    .map((e) =>
      EventNormalizationService.normalizeEvent({
        sourceKey: "official_central_bank_calendar",
        eventName: e.eventName,
        country: e.country,
        currency: e.currency,
        scheduledAt: e.scheduledAt,
        publishedAt: e.publishedAt,
        collectedAt: e.collectedAt,
        previousValue: e.previousValue !== null ? Number(e.previousValue) : null,
        consensusValue: e.consensusValue !== null ? Number(e.consensusValue) : null,
        actualValue: e.actualValue !== null ? Number(e.actualValue) : null,
        isScheduled: e.isScheduled,
        verifiedEvidence: [
          {
            sourceUrl: "https://www.federalreserve.gov",
            headline: e.eventName,
            verifiedAt: e.createdAt.toISOString()
          }
        ]
      })
    );

  const draft = CentralIntelligenceService.generateIntelligenceReport({
    reportType: "daily_summary",
    articles: normalizedArticles,
    events: normalizedEvents
  });

  return persistIntelligenceReportRecord({
    reportKey: draft.reportKey,
    reportType: draft.reportType,
    title: draft.title,
    summary: draft.summary,
    marketRegime: draft.marketRegime,
    sections: draft.sections as Array<Record<string, unknown>>,
    evidenceRefs: draft.evidenceRefs,
    riskWarnings: draft.riskWarnings
  });
}
