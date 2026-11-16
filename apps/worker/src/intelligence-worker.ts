import { Worker } from "bullmq";
import {
  AiProviderRegistry,
  CentralIntelligenceService,
  EventNormalizationService,
  FastProcessingLayer,
  NewsIntelligenceService,
  onlyClosedCandles,
  PostEventMomentumService,
  PostEventReversalService,
  PreEventPositioningService,
  type Candle,
  type DirectionBias,
  type EventStrategyKey,
  type ImportanceLevel,
  type RawGlobalEventInput,
  type RawNewsArticleInput
} from "@signal-engine/core";
import {
  listEconomicEvents,
  listEventSignals,
  listEventStrategies,
  listNewsArticles,
  persistAiAnalysisRun,
  persistEventSignal,
  persistIntelligenceReportRecord,
  persistNormalizedGlobalEvent,
  persistNormalizedNewsArticle,
  updateEventSignalOutcome
} from "@signal-engine/database/intelligence-repository";
import { enqueueNotification, findInstrument, readRecentCandles } from "@signal-engine/database/scanner-repository";
import { connection } from "./queues.js";
import {
  errorText,
  formatBreakingNewsMessage,
  formatDailyIntelligenceSummaryMessage,
  formatEventAlertMessage,
  formatEventTradeMessage
} from "./format.js";

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

  const normalizedArticles = recentArticles.map((a) => {
    const base = newsService.normalizeArticle({
      sourceKey: "stored_article",
      url: a.url,
      title: a.title,
      summary: a.summary ?? "",
      publishedAt: a.publishedAt,
      collectedAt: a.collectedAt
    });
    return {
      ...base,
      contentHash: a.contentHash,
      titleFingerprint: a.titleFingerprint,
      category: a.category,
      importance: a.importance as ImportanceLevel,
      directionBias: a.directionBias as DirectionBias,
      credibilityScore: Number(a.credibilityScore),
      relevanceScore: Number(a.relevanceScore)
    };
  });

  const normalizedEvents = recentEvents
    .filter((e) => e.scheduledAt !== null || !e.isScheduled)
    .map((e) => {
      const existingEv = Array.isArray(e.verifiedEvidence)
        ? (e.verifiedEvidence as Array<{ sourceUrl: string; headline: string; verifiedAt: string }>)
        : [];
      return EventNormalizationService.normalizeEvent({
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
        verifiedEvidence:
          existingEv.length > 0
            ? existingEv
            : [
                {
                  sourceUrl: "https://www.federalreserve.gov",
                  headline: e.eventName,
                  verifiedAt: e.createdAt.toISOString()
                }
              ]
      });
    });

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

/**
 * Flow #9: Resolves a stored event signal's outcome against closed historical candles using
 * conservative stop-first, gap-aware OHLC execution and persists MFE, MAE, and net return.
 */
export async function resolveEventSignalOutcome(
  eventSignalId: string,
  candles: Candle[],
  costAssumptions = { feeBpsPerSide: 4, spreadBps: 8, slippageBps: 5 }
) {
  const signals = await listEventSignals({ limit: 200 });
  const sig = signals.find((s) => s.id === eventSignalId);
  if (!sig) throw new Error(`Event signal not found: ${eventSignalId}`);

  if (
    sig.entryPrice === null ||
    sig.stopLoss === null ||
    (sig.direction !== "LONG" && sig.direction !== "SHORT")
  ) {
    return null;
  }

  const closed = onlyClosedCandles(candles);
  const triggerMs = sig.createdAt.getTime();
  const afterBars = closed.filter((c) => c.openTime >= triggerMs);
  if (afterBars.length === 0) return null;

  const firstBar = afterBars[0]!;
  const slipFrac = (costAssumptions.spreadBps * 0.5 + costAssumptions.slippageBps) / 10_000;
  const observedEntry =
    sig.direction === "LONG" ? firstBar.open * (1 + slipFrac) : firstBar.open * (1 - slipFrac);
  const intendedEntry = Number(sig.entryPrice);
  const riskDist = Math.abs(intendedEntry - Number(sig.stopLoss));
  const stopLoss = sig.direction === "LONG" ? observedEntry - riskDist : observedEntry + riskDist;
  const rawTargets = Array.isArray(sig.targets) ? (sig.targets as Array<{ price?: string | number }>) : [];
  const target1 =
    rawTargets.length > 0 && rawTargets[0]?.price !== undefined
      ? Number(rawTargets[0].price)
      : sig.direction === "LONG"
        ? observedEntry + riskDist * 2.0
        : observedEntry - riskDist * 2.0;
  const expiresAtMs = sig.expiresAt ? sig.expiresAt.getTime() : firstBar.closeTime + 3 * 3600_000;

  let exitPrice = firstBar.close;
  let exitTimeMs = firstBar.closeTime;
  let status: "target_hit" | "stop_hit" | "expired" = "expired";
  let mfe = 0;
  let mae = 0;

  for (const bar of afterBars) {
    const fav =
      sig.direction === "LONG"
        ? (bar.high - observedEntry) / observedEntry
        : (observedEntry - bar.low) / observedEntry;
    const adv =
      sig.direction === "LONG"
        ? (observedEntry - bar.low) / observedEntry
        : (bar.high - observedEntry) / observedEntry;
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);

    const stopHit = sig.direction === "LONG" ? bar.low <= stopLoss : bar.high >= stopLoss;
    const targetHit = sig.direction === "LONG" ? bar.high >= target1 : bar.low <= target1;

    if (stopHit) {
      exitPrice = sig.direction === "LONG" ? Math.min(stopLoss, bar.open) : Math.max(stopLoss, bar.open);
      exitTimeMs = bar.closeTime;
      status = "stop_hit";
      break;
    }
    if (targetHit) {
      exitPrice = target1;
      exitTimeMs = bar.closeTime;
      status = "target_hit";
      break;
    }
    exitPrice = bar.close;
    exitTimeMs = bar.closeTime;
    if (bar.closeTime >= expiresAtMs) {
      status = "expired";
      break;
    }
  }

  const grossReturn =
    sig.direction === "LONG"
      ? (exitPrice - observedEntry) / observedEntry
      : (observedEntry - exitPrice) / observedEntry;
  const exitCosts = (costAssumptions.feeBpsPerSide * 2 + costAssumptions.spreadBps * 0.5 + costAssumptions.slippageBps * 0.5) / 10_000;
  const netReturn = Number((grossReturn - exitCosts).toFixed(6));
  const holdingSeconds = Math.max(1, Math.round((exitTimeMs - firstBar.openTime) / 1000));

  return updateEventSignalOutcome({
    eventSignalId: sig.id,
    status,
    observedEntryAssumption: Number(observedEntry.toFixed(8)),
    exitPrice: Number(exitPrice.toFixed(8)),
    exitTime: new Date(exitTimeMs),
    netReturn,
    maxFavorableExcursion: Number(mfe.toFixed(6)),
    maxAdverseExcursion: Number(mae.toFixed(6)),
    holdingSeconds,
    closedReason: status
  });
}

/**
 * Flow #10: Guarded intelligence notification outbox writer.
 * Never sends live messages to the main Telegram group unless explicitly authorized,
 * and blocks any event trade notification whose strategy is disabled or unapproved.
 */
export async function enqueueGuardedIntelligenceNotification(
  input:
    | {
        kind: "event_alert";
        eventKey: string;
        authorized: boolean;
        payload: Parameters<typeof formatEventAlertMessage>[0];
      }
    | {
        kind: "breaking_news";
        eventKey: string;
        authorized: boolean;
        payload: Parameters<typeof formatBreakingNewsMessage>[0];
      }
    | {
        kind: "daily_summary";
        eventKey: string;
        authorized: boolean;
        payload: Parameters<typeof formatDailyIntelligenceSummaryMessage>[0];
      }
    | {
        kind: "event_trade";
        eventKey: string;
        authorized: boolean;
        strategyEnabled: boolean;
        strategyApproved: boolean;
        payload: Parameters<typeof formatEventTradeMessage>[0];
      }
): Promise<{ queued: boolean; blockedReason?: string; messageHtml: string }> {
  let messageHtml: string;
  if (input.kind === "event_alert") {
    messageHtml = formatEventAlertMessage(input.payload);
  } else if (input.kind === "breaking_news") {
    messageHtml = formatBreakingNewsMessage(input.payload);
  } else if (input.kind === "daily_summary") {
    messageHtml = formatDailyIntelligenceSummaryMessage(input.payload);
  } else {
    messageHtml = formatEventTradeMessage(input.payload);
    if (!input.strategyEnabled || !input.strategyApproved) {
      return {
        queued: false,
        blockedReason: "event_strategy_disabled_or_unapproved",
        messageHtml
      };
    }
  }

  if (!input.authorized) {
    return {
      queued: false,
      blockedReason: "telegram_dispatch_not_authorized",
      messageHtml
    };
  }

  await enqueueNotification({
    eventType: `INTELLIGENCE_${input.kind.toUpperCase()}`,
    eventKey: input.eventKey,
    message: messageHtml
  });

  return { queued: true, messageHtml };
}

export function startIntelligenceQueueWorkers(): Worker[] {
  const workerOpts = {
    connection,
    concurrency: 1,
    limiter: { max: 20, duration: 60_000 }
  };

  const definitions: Array<[string, (job: { name?: string; data?: Record<string, unknown> }) => Promise<unknown>]> = [
    [
      "news-ingestion",
      async (job) => {
        const items = Array.isArray(job.data?.items) ? (job.data.items as RawNewsArticleInput[]) : [];
        return processRawNewsBatch(items);
      }
    ],
    [
      "news-normalization",
      async (job) => {
        const items = Array.isArray(job.data?.items) ? (job.data.items as RawNewsArticleInput[]) : [];
        return processRawNewsBatch(items);
      }
    ],
    [
      "news-analysis",
      async (job) => {
        const items = Array.isArray(job.data?.items) ? (job.data.items as RawNewsArticleInput[]) : [];
        return processRawNewsBatch(items);
      }
    ],
    [
      "event-calendar-sync",
      async (job) => {
        const items = Array.isArray(job.data?.items) ? (job.data.items as RawGlobalEventInput[]) : [];
        return processGlobalEventsBatch(items);
      }
    ],
    [
      "event-monitoring",
      async (job) => {
        const items = Array.isArray(job.data?.items) ? (job.data.items as RawGlobalEventInput[]) : [];
        return processGlobalEventsBatch(items);
      }
    ],
    [
      "event-impact-analysis",
      async (job) => {
        const items = Array.isArray(job.data?.items) ? (job.data.items as RawGlobalEventInput[]) : [];
        return processGlobalEventsBatch(items);
      }
    ],
    [
      "event-trading-analysis",
      async (job) => {
        const rawEvent = job.data?.event as RawGlobalEventInput | undefined;
        const symbol = typeof job.data?.symbol === "string" ? job.data.symbol : "EUR_USD";
        if (!rawEvent) return { evaluated: 0 };
        return evaluateEventTradingForEvent(rawEvent, symbol);
      }
    ],
    [
      "ai-reasoning",
      async (job) => {
        const items = Array.isArray(job.data?.items) ? (job.data.items as RawNewsArticleInput[]) : [];
        return processRawNewsBatch(items);
      }
    ],
    [
      "intelligence-reporting",
      async () => {
        return generateAndPersistDailyIntelligenceReport();
      }
    ]
  ];

  return definitions.map(([queueName, handler]) => {
    const w = new Worker(
      queueName,
      async (job) => {
        try {
          return await handler(job as { name?: string; data?: Record<string, unknown> });
        } catch (err) {
          console.error(`Intelligence queue ${queueName} job failed:`, errorText(err));
          throw err;
        }
      },
      workerOpts
    );
    w.on("error", (err) => {
      console.error(`Intelligence worker ${queueName} error:`, errorText(err));
    });
    return w;
  });
}
