import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db, sql } from "./index.js";
import {
  aiModelConfigs,
  aiModelRuns,
  aiProviders,
  aiUsageRecords,
  aiValidationResults,
  economicEvents,
  eventActualResults,
  eventAssetMappings,
  eventBacktestRuns,
  eventBacktestTrades,
  eventExpectations,
  eventLifecycleRecords,
  eventSignalEvidence,
  eventSignalOutcomes,
  eventSignals,
  eventSources,
  eventStrategyConfigs,
  intelligenceEvidence,
  intelligenceReports,
  marketEventCorrelations,
  newsAiAnalyses,
  newsArticleEntities,
  newsArticles,
  newsArticleUpdates,
  newsEntities,
  newsEventAssets,
  newsEvents,
  newsSources,
  signalContextRecords
} from "./schema.js";

// ============================================================================
// 1. NEWS INTELLIGENCE PERSISTENCE & QUERIES
// ============================================================================

export async function listNewsSources() {
  const rows = await db.select().from(newsSources).orderBy(asc(newsSources.key));
  return rows.map((row) => {
    const hasCreds =
      !row.requiresCredentials ||
      Boolean(row.credentialEnvVar && process.env[row.credentialEnvVar]?.trim());
    return {
      ...row,
      effectiveStatus: !row.enabled
        ? "disabled"
        : row.requiresCredentials && !hasCreds
          ? "awaiting_credentials"
          : row.providerStatus
    };
  });
}

export async function persistNormalizedNewsArticle(input: {
  sourceKey: string;
  externalId?: string | undefined;
  url: string;
  title: string;
  summary: string;
  contentSnippet: string;
  author?: string | undefined;
  publishedAt: Date;
  collectedAt: Date;
  contentHash: string;
  titleFingerprint: string;
  category: string;
  importance: string;
  directionBias: string;
  credibilityScore: number;
  relevanceScore: number;
  entities: Array<{ entityType: string; canonicalName: string; code: string; role: string; confidence: number }>;
  facts: Array<Record<string, unknown>>;
  affectedInstruments: Array<{
    symbol: string;
    market: string;
    relationshipType: string;
    directionHypothesis: string;
    relevanceScore: number;
  }>;
  rawMetadata?: Record<string, unknown> | undefined;
}) {
  return db.transaction(async (tx) => {
    let [source] = await tx.select().from(newsSources).where(eq(newsSources.key, input.sourceKey)).limit(1);
    if (!source) {
      [source] = await tx
        .insert(newsSources)
        .values({
          key: input.sourceKey,
          name: input.sourceKey,
          sourceType: "official_rss",
          credibilityTier: "tier2_financial",
          credibilityScore: String(input.credibilityScore),
          enabled: true,
          requiresCredentials: false,
          providerStatus: "ready"
        })
        .returning();
    }

    const [existingByHash] = await tx
      .select()
      .from(newsArticles)
      .where(eq(newsArticles.contentHash, input.contentHash))
      .limit(1);
    if (existingByHash) {
      return { article: existingByHash, isDuplicate: true, isUpdate: false, newsEvent: null };
    }

    const [priorByFingerprint] = await tx
      .select()
      .from(newsArticles)
      .where(eq(newsArticles.titleFingerprint, input.titleFingerprint))
      .orderBy(desc(newsArticles.publishedAt))
      .limit(1);

    const isSyndicatedDuplicate =
      priorByFingerprint !== undefined &&
      Math.abs(input.publishedAt.getTime() - priorByFingerprint.publishedAt.getTime()) <= 6 * 3600_000;
    const isStoryUpdate = priorByFingerprint !== undefined && !isSyndicatedDuplicate;

    const [article] = await tx
      .insert(newsArticles)
      .values({
        sourceId: source!.id,
        ...(input.externalId ? { externalId: input.externalId } : {}),
        url: input.url,
        title: input.title,
        summary: input.summary,
        contentSnippet: input.contentSnippet,
        ...(input.author ? { author: input.author } : {}),
        publishedAt: input.publishedAt,
        collectedAt: input.collectedAt,
        contentHash: input.contentHash,
        titleFingerprint: input.titleFingerprint,
        ...(priorByFingerprint ? { duplicateOfId: priorByFingerprint.id } : {}),
        category: input.category,
        credibilityScore: String(input.credibilityScore),
        relevanceScore: String(input.relevanceScore),
        importance: input.importance,
        directionBias: input.directionBias,
        status: isSyndicatedDuplicate ? "duplicate" : isStoryUpdate ? "story_update" : "normalized",
        rawMetadata: input.rawMetadata ?? {}
      })
      .returning();

    if (isStoryUpdate && priorByFingerprint) {
      await tx.insert(newsArticleUpdates).values({
        articleId: priorByFingerprint.id,
        updateType: "developing_story_followup",
        summary: input.title,
        previousHash: priorByFingerprint.contentHash,
        newHash: input.contentHash
      });
    }

    for (const ent of input.entities) {
      const [entityRow] = await tx
        .insert(newsEntities)
        .values({
          entityType: ent.entityType,
          canonicalName: ent.canonicalName,
          code: ent.code
        })
        .onConflictDoUpdate({
          target: [newsEntities.entityType, newsEntities.code],
          set: { canonicalName: ent.canonicalName }
        })
        .returning();
      if (entityRow) {
        await tx
          .insert(newsArticleEntities)
          .values({
            articleId: article!.id,
            entityId: entityRow.id,
            role: ent.role,
            confidence: String(ent.confidence)
          })
          .onConflictDoNothing();
      }
    }

    const eventDedupeKey = `news:${input.category}:${input.titleFingerprint}`;
    const [existingEvent] = await tx
      .select()
      .from(newsEvents)
      .where(eq(newsEvents.dedupeKey, eventDedupeKey))
      .limit(1);

    let newsEventRow: typeof newsEvents.$inferSelect;
    if (existingEvent) {
      const conflicting =
        existingEvent.directionBias !== "neutral" &&
        input.directionBias !== "neutral" &&
        existingEvent.directionBias !== input.directionBias;
      const [updated] = await tx
        .update(newsEvents)
        .set({
          corroborationCount: existingEvent.corroborationCount + 1,
          conflictingReports: existingEvent.conflictingReports || conflicting,
          updatedAt: new Date()
        })
        .where(eq(newsEvents.id, existingEvent.id))
        .returning();
      newsEventRow = updated ?? existingEvent;
    } else {
      const [created] = await tx
        .insert(newsEvents)
        .values({
          dedupeKey: eventDedupeKey,
          primaryArticleId: article!.id,
          category: input.category,
          headline: input.title,
          summary: input.summary,
          structuredFacts: input.facts,
          importance: input.importance,
          directionBias: input.directionBias,
          sourceCredibility: String(input.credibilityScore),
          corroborationCount: 1,
          conflictingReports: input.directionBias === "conflicting",
          status: "active",
          firstReportedAt: input.publishedAt
        })
        .returning();
      newsEventRow = created!;
    }

    for (const asset of input.affectedInstruments) {
      await tx
        .insert(newsEventAssets)
        .values({
          newsEventId: newsEventRow.id,
          symbol: asset.symbol,
          market: asset.market,
          relationshipType: asset.relationshipType,
          directionHypothesis: asset.directionHypothesis,
          relevanceScore: String(asset.relevanceScore)
        })
        .onConflictDoNothing();
    }

    return {
      article: article!,
      isDuplicate: isSyndicatedDuplicate,
      isUpdate: isStoryUpdate,
      newsEvent: newsEventRow
    };
  });
}

export async function listNewsArticles(filters: {
  category?: string | undefined;
  importance?: string | undefined;
  limit?: number | undefined;
} = {}) {
  const conditions = [];
  if (filters.category) conditions.push(eq(newsArticles.category, filters.category));
  if (filters.importance) conditions.push(eq(newsArticles.importance, filters.importance));
  const bounded = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  return db
    .select()
    .from(newsArticles)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(newsArticles.publishedAt))
    .limit(bounded);
}

export async function listNewsEvents(filters: {
  category?: string | undefined;
  importance?: string | undefined;
  symbol?: string | undefined;
  limit?: number | undefined;
} = {}) {
  const bounded = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const conditions = [];
  if (filters.category) conditions.push(eq(newsEvents.category, filters.category));
  if (filters.importance) conditions.push(eq(newsEvents.importance, filters.importance));
  const events = await db
    .select()
    .from(newsEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(newsEvents.firstReportedAt))
    .limit(bounded);

  const out = [];
  for (const ev of events) {
    const assets = await db.select().from(newsEventAssets).where(eq(newsEventAssets.newsEventId, ev.id));
    if (filters.symbol && !assets.some((a) => a.symbol === filters.symbol)) continue;
    out.push({ ...ev, affectedAssets: assets });
  }
  return out;
}

// ============================================================================
// 2. GLOBAL EVENTS PERSISTENCE & QUERIES
// ============================================================================

export async function persistNormalizedGlobalEvent(input: {
  dedupeKey: string;
  sourceKey: string;
  eventType: string;
  category: string;
  eventName: string;
  country: string;
  currency: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  collectedAt: Date;
  timezone: string;
  previousValue: number | null;
  revisedPreviousValue: number | null;
  consensusValue: number | null;
  actualValue: number | null;
  unit: string | null;
  importance: string;
  status: string;
  isScheduled: boolean;
  surprise: {
    hasActualAndConsensus: boolean;
    surpriseValue: number | null;
    surprisePct: number | null;
  };
  verifiedEvidence: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown> | undefined;
}) {
  return db.transaction(async (tx) => {
    let [source] = await tx.select().from(eventSources).where(eq(eventSources.key, input.sourceKey)).limit(1);
    if (!source) {
      [source] = await tx
        .insert(eventSources)
        .values({
          key: input.sourceKey,
          name: input.sourceKey,
          sourceType: "official_calendar",
          credibilityScore: "90.00",
          enabled: true,
          requiresCredentials: false,
          providerStatus: "ready"
        })
        .returning();
    }

    const [existing] = await tx
      .select()
      .from(economicEvents)
      .where(eq(economicEvents.dedupeKey, input.dedupeKey))
      .limit(1);

    const values = {
      dedupeKey: input.dedupeKey,
      sourceId: source!.id,
      eventType: input.eventType,
      category: input.category,
      eventName: input.eventName,
      country: input.country,
      currency: input.currency,
      scheduledAt: input.scheduledAt,
      publishedAt: input.publishedAt,
      collectedAt: input.collectedAt,
      timezone: input.timezone,
      previousValue: input.previousValue !== null ? String(input.previousValue) : null,
      revisedPreviousValue: input.revisedPreviousValue !== null ? String(input.revisedPreviousValue) : null,
      consensusValue: input.consensusValue !== null ? String(input.consensusValue) : null,
      actualValue: input.actualValue !== null ? String(input.actualValue) : null,
      unit: input.unit,
      importance: input.importance,
      status: input.status,
      isScheduled: input.isScheduled,
      verifiedEvidence: input.verifiedEvidence,
      metadata: input.metadata ?? {},
      updatedAt: new Date()
    };

    let eventRow: typeof economicEvents.$inferSelect;
    if (!existing) {
      const [created] = await tx.insert(economicEvents).values(values).returning();
      eventRow = created!;
      await tx.insert(eventLifecycleRecords).values({
        eventId: eventRow.id,
        fromStatus: null,
        toStatus: input.status,
        reason: "initial_ingestion"
      });
    } else {
      const [updated] = await tx
        .update(economicEvents)
        .set(values)
        .where(eq(economicEvents.id, existing.id))
        .returning();
      eventRow = updated!;
      if (existing.status !== input.status) {
        await tx.insert(eventLifecycleRecords).values({
          eventId: eventRow.id,
          fromStatus: existing.status,
          toStatus: input.status,
          reason: "status_transition"
        });
      }
    }

    if (input.consensusValue !== null) {
      await tx.insert(eventExpectations).values({
        eventId: eventRow.id,
        consensusValue: String(input.consensusValue),
        unit: input.unit,
        source: input.sourceKey
      });
    }

    if (input.actualValue !== null) {
      await tx.insert(eventActualResults).values({
        eventId: eventRow.id,
        actualValue: String(input.actualValue),
        ...(input.previousValue !== null ? { previousValue: String(input.previousValue) } : {}),
        ...(input.revisedPreviousValue !== null ? { revisedPreviousValue: String(input.revisedPreviousValue) } : {}),
        ...(input.surprise.surpriseValue !== null ? { surpriseValue: String(input.surprise.surpriseValue) } : {}),
        ...(input.surprise.surprisePct !== null ? { surprisePct: String(input.surprise.surprisePct) } : {}),
        releaseTimestamp: input.publishedAt ?? new Date(),
        source: input.sourceKey
      });
    }

    return eventRow;
  });
}

export async function listEconomicEvents(filters: {
  category?: string | undefined;
  importance?: string | undefined;
  status?: string | undefined;
  country?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit?: number | undefined;
} = {}) {
  const conditions = [];
  if (filters.category) conditions.push(eq(economicEvents.category, filters.category));
  if (filters.importance) conditions.push(eq(economicEvents.importance, filters.importance));
  if (filters.status) conditions.push(eq(economicEvents.status, filters.status));
  if (filters.country) conditions.push(eq(economicEvents.country, filters.country.toUpperCase()));
  if (filters.from) conditions.push(gte(economicEvents.scheduledAt, filters.from));
  if (filters.to) conditions.push(lte(economicEvents.scheduledAt, filters.to));
  const bounded = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  return db
    .select()
    .from(economicEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(economicEvents.scheduledAt), desc(economicEvents.createdAt))
    .limit(bounded);
}

export async function listEventAssetMappings(symbol?: string, eventCategory?: string) {
  const conditions = [];
  if (symbol) conditions.push(eq(eventAssetMappings.symbol, symbol));
  if (eventCategory) conditions.push(eq(eventAssetMappings.eventCategory, eventCategory));
  return db
    .select()
    .from(eventAssetMappings)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(eventAssetMappings.eventCategory), asc(eventAssetMappings.symbol));
}

// ============================================================================
// 3. EVENT TRADING STRATEGIES, SIGNALS, OUTCOMES & BACKTESTS
// ============================================================================

export async function listEventStrategies() {
  return db.select().from(eventStrategyConfigs).orderBy(asc(eventStrategyConfigs.key), asc(eventStrategyConfigs.version));
}

export async function persistEventSignal(input: {
  dedupeKey: string;
  eventId?: string | undefined;
  newsEventId?: string | undefined;
  instrumentId?: string | undefined;
  strategyKey: string;
  strategyVersion?: number | undefined;
  strategyType: string;
  eventCategory: string;
  eventName: string;
  symbol: string;
  market: string;
  timeframe: string;
  confirmationTimeframe?: string | undefined;
  direction: string;
  actionClassification: string;
  entryPrice: number | null;
  stopLoss: number | null;
  targets: number[];
  rewardRisk: number | null;
  eventImportance: string;
  riskClassification: string;
  scheduledEventAt?: Date | null | undefined;
  actualEventAt?: Date | null | undefined;
  sourceReferences: string[];
  quantitativeEvidence: Record<string, unknown>;
  aiAnalysisId?: string | undefined;
  scoreBreakdown: Record<string, unknown>;
  validationStatus: string;
  rejectionReason?: string | undefined;
  outcomeStatus: string;
  estimatedSlippageBps: number;
  publishedAt?: Date | undefined;
  expiresAt?: Date | undefined;
}) {
  return db.transaction(async (tx) => {
    const [strategy] = await tx
      .select()
      .from(eventStrategyConfigs)
      .where(
        and(
          eq(eventStrategyConfigs.key, input.strategyKey),
          eq(eventStrategyConfigs.version, input.strategyVersion ?? 1)
        )
      )
      .limit(1);

    const targetObjects =
      input.entryPrice !== null && input.stopLoss !== null
        ? input.targets.map((price, idx) => ({
            price: String(price),
            rewardRisk: String(
              (Math.abs(price - input.entryPrice!) / Math.max(1e-9, Math.abs(input.entryPrice! - input.stopLoss!))).toFixed(4)
            ),
            allocationPct: idx === 0 ? 50 : 50
          }))
        : [];

    const [created] = await tx
      .insert(eventSignals)
      .values({
        dedupeKey: input.dedupeKey,
        ...(input.eventId ? { eventId: input.eventId } : {}),
        ...(input.newsEventId ? { newsEventId: input.newsEventId } : {}),
        ...(input.instrumentId ? { instrumentId: input.instrumentId } : {}),
        ...(strategy ? { strategyConfigId: strategy.id } : {}),
        strategyKey: input.strategyKey,
        strategyVersion: input.strategyVersion ?? 1,
        strategyType: input.strategyType,
        eventCategory: input.eventCategory,
        eventName: input.eventName,
        symbol: input.symbol,
        market: input.market,
        timeframe: input.timeframe,
        ...(input.confirmationTimeframe ? { confirmationTimeframe: input.confirmationTimeframe } : {}),
        direction: input.direction,
        actionClassification: input.actionClassification,
        entryPrice: input.entryPrice !== null ? String(input.entryPrice) : null,
        stopLoss: input.stopLoss !== null ? String(input.stopLoss) : null,
        targets: targetObjects,
        rewardRisk: input.rewardRisk !== null ? String(input.rewardRisk) : null,
        eventImportance: input.eventImportance,
        riskClassification: input.riskClassification,
        scheduledEventAt: input.scheduledEventAt ?? null,
        actualEventAt: input.actualEventAt ?? null,
        sourceReferences: input.sourceReferences,
        quantitativeEvidence: input.quantitativeEvidence,
        ...(input.aiAnalysisId ? { aiAnalysisId: input.aiAnalysisId } : {}),
        scoreBreakdown: input.scoreBreakdown,
        validationStatus: input.validationStatus,
        ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
        outcomeStatus: input.outcomeStatus,
        ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
      })
      .onConflictDoNothing()
      .returning();

    if (!created) {
      const [existing] = await tx.select().from(eventSignals).where(eq(eventSignals.dedupeKey, input.dedupeKey)).limit(1);
      return existing!;
    }

    await tx.insert(eventSignalEvidence).values({
      eventSignalId: created.id,
      evidenceType: "quantitative_and_risk_evaluation",
      sourceRef: input.eventId ?? input.newsEventId ?? input.dedupeKey,
      payload: input.quantitativeEvidence
    });

    await tx
      .insert(eventSignalOutcomes)
      .values({
        eventSignalId: created.id,
        status: input.outcomeStatus,
        intendedEntry: input.entryPrice !== null ? String(input.entryPrice) : null,
        observedEntryAssumption: input.entryPrice !== null ? String(input.entryPrice) : null,
        estimatedSlippageBps: String(input.estimatedSlippageBps),
        methodology: "stop_first_gap_aware_ohlc",
        ...(input.rejectionReason ? { closedReason: input.rejectionReason.slice(0, 32) } : {})
      })
      .onConflictDoNothing();

    return created;
  });
}

export async function listEventSignals(filters: {
  symbol?: string | undefined;
  strategyKey?: string | undefined;
  validationStatus?: string | undefined;
  outcomeStatus?: string | undefined;
  limit?: number | undefined;
} = {}) {
  const conditions = [];
  if (filters.symbol) conditions.push(eq(eventSignals.symbol, filters.symbol));
  if (filters.strategyKey) conditions.push(eq(eventSignals.strategyKey, filters.strategyKey));
  if (filters.validationStatus) conditions.push(eq(eventSignals.validationStatus, filters.validationStatus));
  if (filters.outcomeStatus) conditions.push(eq(eventSignals.outcomeStatus, filters.outcomeStatus));
  const bounded = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  return db
    .select()
    .from(eventSignals)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(eventSignals.createdAt))
    .limit(bounded);
}

export async function persistEventBacktestRun(input: {
  strategyKey: string;
  strategyVersion?: number | undefined;
  eventCategory?: string | undefined;
  symbol: string;
  timeframe: string;
  dataset: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  parameters: Record<string, unknown>;
  metrics: Record<string, unknown>;
  trades: Array<{
    eventDedupeKey: string;
    symbol: string;
    strategyKey: string;
    direction: string;
    entryTimeMs: number;
    exitTimeMs: number;
    observedEntry: number;
    exitPrice: number;
    grossReturn: number;
    netReturn: number;
    slippageBps: number;
    outcome: string;
  }>;
}) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [run] = await tx
      .insert(eventBacktestRuns)
      .values({
        strategyKey: input.strategyKey,
        strategyVersion: input.strategyVersion ?? 1,
        ...(input.eventCategory ? { eventCategory: input.eventCategory } : {}),
        symbol: input.symbol,
        timeframe: input.timeframe,
        dataset: input.dataset,
        assumptions: input.assumptions,
        parameters: input.parameters,
        metrics: input.metrics,
        status: "completed",
        startedAt: now,
        completedAt: now
      })
      .returning();

    for (const trade of input.trades) {
      await tx.insert(eventBacktestTrades).values({
        backtestRunId: run!.id,
        eventId: trade.eventDedupeKey,
        symbol: trade.symbol,
        strategyKey: trade.strategyKey,
        direction: trade.direction,
        entryTime: new Date(trade.entryTimeMs),
        exitTime: new Date(trade.exitTimeMs),
        entryPrice: String(trade.observedEntry),
        exitPrice: String(trade.exitPrice),
        grossReturn: String(trade.grossReturn),
        netReturn: String(trade.netReturn),
        slippageBps: String(trade.slippageBps),
        outcome: trade.outcome
      });
    }
    return run!;
  });
}

export async function listEventBacktestRuns(limit = 50) {
  return db
    .select()
    .from(eventBacktestRuns)
    .orderBy(desc(eventBacktestRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

// ============================================================================
// 4. AI MODEL RUNS, VALIDATION, USAGE & CENTRAL INTELLIGENCE REPORTS
// ============================================================================

export async function persistAiAnalysisRun(input: {
  articleId?: string | undefined;
  newsEventId?: string | undefined;
  providerKey: string;
  modelName: string;
  taskLayer: string;
  taskKey: string;
  promptVersion: string;
  inputSnapshot: Record<string, unknown>;
  outputPayload: Record<string, unknown>;
  validation: {
    valid: boolean;
    status: string;
    checksPassed: string[];
    checksFailed: string[];
    downgraded: boolean;
    notes: string;
  };
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  errorMessage?: string | undefined;
  structuredFacts: Array<Record<string, unknown>>;
  interpretations: Array<Record<string, unknown>>;
  scenarios: Array<Record<string, unknown>>;
  affectedAssets: Array<Record<string, unknown>>;
}) {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(aiModelRuns)
      .values({
        providerKey: input.providerKey,
        modelName: input.modelName,
        taskLayer: input.taskLayer,
        taskKey: input.taskKey,
        promptVersion: input.promptVersion,
        inputSnapshot: input.inputSnapshot,
        outputPayload: input.outputPayload,
        validationStatus: input.validation.status,
        validationErrors: input.validation.checksFailed,
        durationMs: input.durationMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        estimatedCostUsd: String(input.estimatedCostUsd),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {})
      })
      .returning();

    await tx.insert(aiValidationResults).values({
      aiRunId: run!.id,
      valid: input.validation.valid,
      checksPassed: input.validation.checksPassed,
      checksFailed: input.validation.checksFailed,
      downgraded: input.validation.downgraded,
      notes: input.validation.notes
    });

    const windowDate = new Date().toISOString().slice(0, 10);
    await tx
      .insert(aiUsageRecords)
      .values({
        providerKey: input.providerKey,
        modelName: input.modelName,
        windowDate,
        requestsCount: 1,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        estimatedCostUsd: String(input.estimatedCostUsd)
      })
      .onConflictDoUpdate({
        target: [aiUsageRecords.providerKey, aiUsageRecords.modelName, aiUsageRecords.windowDate],
        set: {
          requestsCount: sql`${aiUsageRecords.requestsCount} + 1`,
          inputTokens: sql`${aiUsageRecords.inputTokens} + ${input.inputTokens}`,
          outputTokens: sql`${aiUsageRecords.outputTokens} + ${input.outputTokens}`,
          estimatedCostUsd: sql`${aiUsageRecords.estimatedCostUsd} + ${input.estimatedCostUsd}`,
          updatedAt: new Date()
        }
      });

    const [analysis] = await tx
      .insert(newsAiAnalyses)
      .values({
        ...(input.articleId ? { articleId: input.articleId } : {}),
        ...(input.newsEventId ? { newsEventId: input.newsEventId } : {}),
        aiRunId: run!.id,
        layer: input.taskLayer,
        structuredFacts: input.structuredFacts,
        interpretations: input.interpretations,
        scenarios: input.scenarios,
        affectedAssets: input.affectedAssets,
        validationStatus: input.validation.status,
        validationErrors: input.validation.checksFailed
      })
      .returning();

    return { run: run!, analysis: analysis! };
  });
}

export async function listAiAnalyses(limit = 50) {
  const bounded = Math.min(Math.max(limit, 1), 200);
  const analyses = await db.select().from(newsAiAnalyses).orderBy(desc(newsAiAnalyses.createdAt)).limit(bounded);
  const runs = await db.select().from(aiModelRuns).orderBy(desc(aiModelRuns.createdAt)).limit(bounded);
  const usage = await db.select().from(aiUsageRecords).orderBy(desc(aiUsageRecords.windowDate)).limit(30);
  const providers = await db.select().from(aiProviders).orderBy(asc(aiProviders.key));
  const models = await db.select().from(aiModelConfigs).orderBy(asc(aiModelConfigs.providerKey));
  return { analyses, runs, usage, providers, models };
}

export async function persistIntelligenceReportRecord(input: {
  reportKey: string;
  reportType: string;
  title: string;
  summary: string;
  marketRegime: string;
  sections: Array<Record<string, unknown>>;
  evidenceRefs: Array<{ type: string; ref: string; url?: string }>;
  riskWarnings: string[];
}) {
  return db.transaction(async (tx) => {
    const [report] = await tx
      .insert(intelligenceReports)
      .values({
        reportKey: input.reportKey,
        reportType: input.reportType,
        title: input.title,
        summary: input.summary,
        marketRegime: input.marketRegime,
        sections: input.sections,
        evidenceRefs: input.evidenceRefs,
        riskWarnings: input.riskWarnings
      })
      .onConflictDoUpdate({
        target: intelligenceReports.reportKey,
        set: {
          title: input.title,
          summary: input.summary,
          marketRegime: input.marketRegime,
          sections: input.sections,
          evidenceRefs: input.evidenceRefs,
          riskWarnings: input.riskWarnings,
          generatedAt: new Date()
        }
      })
      .returning();

    for (const ev of input.evidenceRefs.slice(0, 10)) {
      await tx.insert(intelligenceEvidence).values({
        reportId: report!.id,
        sourceType: ev.type,
        sourceId: ev.ref,
        summary: ev.url ?? ev.ref,
        weight: "1.00"
      });
    }
    return report!;
  });
}

export async function listIntelligenceReports(limit = 30) {
  return db
    .select()
    .from(intelligenceReports)
    .orderBy(desc(intelligenceReports.generatedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function persistSignalContextRecord(input: {
  technicalSignalId?: string | undefined;
  eventSignalId?: string | undefined;
  symbol: string;
  timeframe: string;
  alignmentStatus: string;
  eventRiskLevel: string;
  recommendation: string;
  evidenceDimensions: Record<string, unknown>;
  nearbyEventIds: string[];
  relatedNewsIds: string[];
  rationale: string[];
}) {
  const [row] = await db
    .insert(signalContextRecords)
    .values({
      ...(input.technicalSignalId ? { technicalSignalId: input.technicalSignalId } : {}),
      ...(input.eventSignalId ? { eventSignalId: input.eventSignalId } : {}),
      symbol: input.symbol,
      timeframe: input.timeframe,
      alignmentStatus: input.alignmentStatus,
      eventRiskLevel: input.eventRiskLevel,
      recommendation: input.recommendation,
      evidenceDimensions: input.evidenceDimensions,
      nearbyEventIds: input.nearbyEventIds,
      relatedNewsIds: input.relatedNewsIds,
      rationale: input.rationale
    })
    .returning();
  return row!;
}

export async function listSignalContextRecords(symbol?: string, limit = 50) {
  const conditions = [];
  if (symbol) conditions.push(eq(signalContextRecords.symbol, symbol));
  return db
    .select()
    .from(signalContextRecords)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(signalContextRecords.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export async function recordMarketEventCorrelation(input: {
  eventId?: string | undefined;
  newsEventId?: string | undefined;
  symbol: string;
  timeframe: string;
  reaction15mPct?: number | null | undefined;
  reaction1hPct?: number | null | undefined;
  reaction4hPct?: number | null | undefined;
  volumeRatio?: number | null | undefined;
  volatilityRatio?: number | null | undefined;
}) {
  const [row] = await db
    .insert(marketEventCorrelations)
    .values({
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.newsEventId ? { newsEventId: input.newsEventId } : {}),
      symbol: input.symbol,
      timeframe: input.timeframe,
      reaction15mPct: input.reaction15mPct !== null && input.reaction15mPct !== undefined ? String(input.reaction15mPct) : null,
      reaction1hPct: input.reaction1hPct !== null && input.reaction1hPct !== undefined ? String(input.reaction1hPct) : null,
      reaction4hPct: input.reaction4hPct !== null && input.reaction4hPct !== undefined ? String(input.reaction4hPct) : null,
      volumeRatio: input.volumeRatio !== null && input.volumeRatio !== undefined ? String(input.volumeRatio) : null,
      volatilityRatio: input.volatilityRatio !== null && input.volatilityRatio !== undefined ? String(input.volatilityRatio) : null
    })
    .returning();
  return row!;
}
