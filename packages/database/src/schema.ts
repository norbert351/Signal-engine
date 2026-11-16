import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  uniqueIndex,
  index,
  bigint
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const schemaMigrations = pgTable("schema_migrations", {
  name: varchar("name", { length: 160 }).primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow()
});

export const instruments = pgTable(
  "instruments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(),
    market: varchar("market", { length: 16 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    baseAsset: varchar("base_asset", { length: 16 }),
    quoteAsset: varchar("quote_asset", { length: 16 }),
    enabled: boolean("enabled").notNull().default(false),
    pricePrecision: integer("price_precision").notNull().default(2),
    quantityPrecision: integer("quantity_precision").notNull().default(0),
    available: boolean("available").notNull().default(true),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("instrument_provider_symbol_uq").on(t.provider, t.symbol)]
);

export const candles = pgTable(
  "market_candles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instrumentId: uuid("instrument_id").notNull().references(() => instruments.id),
    timeframe: varchar("timeframe", { length: 8 }).notNull(),
    openTime: timestamp("open_time", { withTimezone: true }).notNull(),
    closeTime: timestamp("close_time", { withTimezone: true }).notNull(),
    open: numeric("open", { precision: 28, scale: 12 }).notNull(),
    high: numeric("high", { precision: 28, scale: 12 }).notNull(),
    low: numeric("low", { precision: 28, scale: 12 }).notNull(),
    close: numeric("close", { precision: 28, scale: 12 }).notNull(),
    volume: numeric("volume", { precision: 36, scale: 12 }),
    isComplete: boolean("is_complete").notNull().default(false),
    source: varchar("source", { length: 32 }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("candle_instrument_tf_open_uq").on(t.instrumentId, t.timeframe, t.openTime),
    index("candle_lookup_idx").on(t.instrumentId, t.timeframe, t.openTime),
    index("candle_close_lookup_idx").on(t.instrumentId, t.timeframe, t.closeTime)
  ]
);

export const strategyConfigs = pgTable(
  "strategy_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 64 }).notNull(),
    version: integer("version").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(false),
    approved: boolean("approved").notNull().default(false),
    approvalNote: text("approval_note"),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
    riskConfig: jsonb("risk_config").$type<Record<string, unknown>>().notNull(),
    parameterHash: varchar("parameter_hash", { length: 64 }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("strategy_key_version_uq").on(t.key, t.version)]
);

export const signals = pgTable(
  "signal_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    dedupeKey: varchar("dedupe_key", { length: 180 }).notNull().unique(),
    instrumentId: uuid("instrument_id").notNull().references(() => instruments.id),
    strategyConfigId: uuid("strategy_config_id").notNull().references(() => strategyConfigs.id),
    market: varchar("market", { length: 16 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    direction: varchar("direction", { length: 8 }).notNull(),
    entryType: varchar("entry_type", { length: 16 }).notNull(),
    entryMin: numeric("entry_min", { precision: 28, scale: 12 }).notNull(),
    entryMax: numeric("entry_max", { precision: 28, scale: 12 }).notNull(),
    stopLoss: numeric("stop_loss", { precision: 28, scale: 12 }).notNull(),
    targets: jsonb("targets").$type<Array<{ price: string; rewardRisk: string; allocationPct?: number }>>().notNull(),
    rewardRisk: numeric("reward_risk", { precision: 12, scale: 4 }).notNull(),
    timeframe: varchar("timeframe", { length: 8 }).notNull(),
    tradingStyle: varchar("trading_style", { length: 16 }),
    confirmationTimeframe: varchar("confirmation_timeframe", { length: 8 }),
    strategyKey: varchar("strategy_key", { length: 64 }),
    strategyVersion: integer("strategy_version"),
    qualityScore: numeric("quality_score", { precision: 6, scale: 2 }),
    qualityFactors: jsonb("quality_factors").$type<Record<string, unknown>>().notNull().default({}),
    scoreFormulaVersion: varchar("score_formula_version", { length: 32 }),
    invalidationConditions: jsonb("invalidation_conditions").$type<string[]>().notNull().default([]),
    rationale: jsonb("rationale").$type<string[]>().notNull(),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: createdAt()
  },
  (t) => [
    index("signal_symbol_published_idx").on(t.symbol, t.publishedAt),
    index("signal_status_expiry_idx").on(t.status, t.expiresAt),
    index("signal_instrument_published_idx").on(t.instrumentId, t.publishedAt),
    index("signal_strategy_idx").on(t.strategyKey, t.strategyVersion, t.publishedAt)
  ]
);

export const signalEvents = pgTable(
  "signal_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    signalId: uuid("signal_id").notNull().references(() => signals.id),
    eventType: varchar("event_type", { length: 32 }).notNull(),
    eventKey: varchar("event_key", { length: 220 }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("signal_event_signal_idx").on(t.signalId, t.occurredAt), uniqueIndex("signal_event_key_uq").on(t.eventKey)]
);

export const backtestRuns = pgTable("backtest_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  strategyKey: varchar("strategy_key", { length: 64 }).notNull(),
  strategyVersion: integer("strategy_version").notNull(),
  instrumentId: uuid("instrument_id").references(() => instruments.id),
  timeframe: varchar("timeframe", { length: 8 }).notNull(),
  dataset: jsonb("dataset").$type<Record<string, unknown>>().notNull(),
  assumptions: jsonb("assumptions").$type<Record<string, unknown>>().notNull(),
  parameters: jsonb("parameters").$type<Record<string, unknown>>(),
  metrics: jsonb("metrics").$type<Record<string, unknown>>(),
  status: varchar("status", { length: 20 }).notNull().default("queued"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt()
});

export const notificationOutbox = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    signalId: uuid("signal_id").references(() => signals.id),
    channel: varchar("channel", { length: 20 }).notNull().default("telegram"),
    destination: varchar("destination", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 32 }).notNull().default("signal"),
    eventKey: varchar("event_key", { length: 240 }),
    message: text("message"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    providerMessageId: varchar("provider_message_id", { length: 128 }),
    lastError: text("last_error"),
    createdAt: createdAt()
  },
  (t) => [
    uniqueIndex("notification_event_key_uq").on(t.eventKey),
    index("notification_pending_idx").on(t.status, t.nextAttemptAt)
  ]
);

export const systemHealth = pgTable("system_health", {
  id: uuid("id").defaultRandom().primaryKey(),
  component: varchar("component", { length: 64 }).notNull().unique(),
  status: varchar("status", { length: 16 }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow()
});

export const systemAlerts = pgTable("system_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  component: varchar("component", { length: 64 }).notNull(),
  severity: varchar("severity", { length: 16 }).notNull().default("warning"),
  dedupeKey: varchar("dedupe_key", { length: 180 }).notNull().unique(),
  message: text("message").notNull(),
  count: integer("count").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
});

export const paperTrades = pgTable(
  "paper_trade_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    signalId: uuid("signal_id").notNull().references(() => signals.id).unique(),
    status: varchar("status", { length: 16 }).notNull().default("OPEN"),
    direction: varchar("direction", { length: 8 }).notNull(),
    targetIndex: integer("target_index").notNull().default(0),
    remainingPct: numeric("remaining_pct", { precision: 8, scale: 4 }).notNull().default("100"),
    realizedReturn: numeric("realized_return", { precision: 16, scale: 8 }).notNull().default("0"),
    entryPrice: numeric("entry_price", { precision: 28, scale: 12 }).notNull(),
    entryTime: timestamp("entry_time", { withTimezone: true }).notNull(),
    exitPrice: numeric("exit_price", { precision: 28, scale: 12 }),
    exitTime: timestamp("exit_time", { withTimezone: true }),
    outcome: varchar("outcome", { length: 16 }),
    netReturn: numeric("net_return", { precision: 16, scale: 8 }),
    processedThrough: timestamp("processed_through", { withTimezone: true }),
    costBps: numeric("cost_bps", { precision: 10, scale: 4 }).notNull().default("0"),
    fundingBpsPer8h: numeric("funding_bps_per_8h", { precision: 10, scale: 4 }).notNull().default("0"),
    closedReason: varchar("closed_reason", { length: 24 }),
    initialStop: numeric("initial_stop", { precision: 28, scale: 12 }),
    initialTargets: jsonb("initial_targets").$type<Array<{ price: string; allocationPct?: number }>>(),
    createdAt: createdAt()
  },
  (t) => [index("paper_trade_status_idx").on(t.status, t.entryTime)]
);

export const backfillProgress = pgTable(
  "backfill_progress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 8 }).notNull(),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    cursorTime: timestamp("cursor_time", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    candlesSeen: bigint("candles_seen", { mode: "number" }).notNull().default(0),
    candlesWritten: bigint("candles_written", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("backfill_progress_uq").on(t.provider, t.symbol, t.timeframe, t.startTime, t.endTime),
    index("backfill_progress_status_idx").on(t.status, t.updatedAt)
  ]
);

// ============================================================================
// AI, NEWS, GLOBAL EVENTS & EVENT TRADING TABLES (MIGRATION 0011)
// ============================================================================

export const newsSources = pgTable("news_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  sourceType: varchar("source_type", { length: 32 }).notNull(),
  url: text("url"),
  credibilityTier: varchar("credibility_tier", { length: 32 }).notNull().default("tier2_financial"),
  credibilityScore: numeric("credibility_score", { precision: 5, scale: 2 }).notNull().default("75.00"),
  enabled: boolean("enabled").notNull().default(true),
  requiresCredentials: boolean("requires_credentials").notNull().default(false),
  credentialEnvVar: varchar("credential_env_var", { length: 64 }),
  providerStatus: varchar("provider_status", { length: 32 }).notNull().default("ready"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const newsArticles = pgTable(
  "news_articles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id").notNull().references(() => newsSources.id),
    externalId: varchar("external_id", { length: 180 }),
    url: text("url").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    contentSnippet: text("content_snippet"),
    author: varchar("author", { length: 120 }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
    normalizedAt: timestamp("normalized_at", { withTimezone: true }).notNull().defaultNow(),
    contentHash: varchar("content_hash", { length: 64 }).notNull().unique(),
    titleFingerprint: varchar("title_fingerprint", { length: 64 }).notNull(),
    duplicateOfId: uuid("duplicate_of_id"),
    category: varchar("category", { length: 64 }).notNull(),
    subcategory: varchar("subcategory", { length: 64 }),
    credibilityScore: numeric("credibility_score", { precision: 5, scale: 2 }).notNull().default("70.00"),
    relevanceScore: numeric("relevance_score", { precision: 5, scale: 2 }).notNull().default("50.00"),
    importance: varchar("importance", { length: 16 }).notNull().default("medium"),
    directionBias: varchar("direction_bias", { length: 16 }).notNull().default("neutral"),
    status: varchar("status", { length: 24 }).notNull().default("normalized"),
    rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt()
  },
  (t) => [
    index("news_articles_published_idx").on(t.publishedAt),
    index("news_articles_fingerprint_idx").on(t.titleFingerprint, t.publishedAt),
    index("news_articles_category_idx").on(t.category, t.importance, t.publishedAt)
  ]
);

export const newsArticleUpdates = pgTable(
  "news_article_updates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id").notNull().references(() => newsArticles.id),
    updateType: varchar("update_type", { length: 32 }).notNull(),
    summary: text("summary").notNull(),
    previousHash: varchar("previous_hash", { length: 64 }),
    newHash: varchar("new_hash", { length: 64 }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("news_article_updates_article_idx").on(t.articleId, t.detectedAt)]
);

export const newsEntities = pgTable(
  "news_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    canonicalName: varchar("canonical_name", { length: 120 }).notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("news_entity_type_code_uq").on(t.entityType, t.code)]
);

export const newsArticleEntities = pgTable(
  "news_article_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id").notNull().references(() => newsArticles.id),
    entityId: uuid("entity_id").notNull().references(() => newsEntities.id),
    role: varchar("role", { length: 32 }).notNull().default("mentioned"),
    confidence: numeric("confidence", { precision: 5, scale: 2 }).notNull().default("80.00"),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("news_article_entity_uq").on(t.articleId, t.entityId)]
);

export const newsEvents = pgTable(
  "news_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    dedupeKey: varchar("dedupe_key", { length: 180 }).notNull().unique(),
    primaryArticleId: uuid("primary_article_id").references(() => newsArticles.id),
    category: varchar("category", { length: 64 }).notNull(),
    headline: text("headline").notNull(),
    summary: text("summary"),
    structuredFacts: jsonb("structured_facts").$type<Array<Record<string, unknown>>>().notNull().default([]),
    importance: varchar("importance", { length: 16 }).notNull().default("medium"),
    directionBias: varchar("direction_bias", { length: 16 }).notNull().default("neutral"),
    sourceCredibility: numeric("source_credibility", { precision: 5, scale: 2 }).notNull().default("75.00"),
    corroborationCount: integer("corroboration_count").notNull().default(1),
    conflictingReports: boolean("conflicting_reports").notNull().default(false),
    status: varchar("status", { length: 24 }).notNull().default("active"),
    firstReportedAt: timestamp("first_reported_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("news_events_reported_idx").on(t.firstReportedAt),
    index("news_events_category_idx").on(t.category, t.importance, t.firstReportedAt)
  ]
);

export const newsEventAssets = pgTable(
  "news_event_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    newsEventId: uuid("news_event_id").notNull().references(() => newsEvents.id),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    market: varchar("market", { length: 16 }).notNull(),
    relationshipType: varchar("relationship_type", { length: 32 }).notNull().default("direct"),
    directionHypothesis: varchar("direction_hypothesis", { length: 16 }).notNull().default("uncertain"),
    relevanceScore: numeric("relevance_score", { precision: 5, scale: 2 }).notNull().default("70.00"),
    createdAt: createdAt()
  },
  (t) => [
    uniqueIndex("news_event_asset_uq").on(t.newsEventId, t.symbol),
    index("news_event_assets_symbol_idx").on(t.symbol, t.createdAt)
  ]
);

export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 80 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  requiresCredentials: boolean("requires_credentials").notNull().default(true),
  credentialEnvVar: varchar("credential_env_var", { length: 64 }),
  healthStatus: varchar("health_status", { length: 24 }).notNull().default("awaiting_credentials"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt()
});

export const aiModelConfigs = pgTable(
  "ai_model_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerKey: varchar("provider_key", { length: 32 }).notNull().references(() => aiProviders.key),
    taskLayer: varchar("task_layer", { length: 32 }).notNull(),
    modelName: varchar("model_name", { length: 80 }).notNull(),
    maxTokens: integer("max_tokens").notNull().default(1024),
    timeoutMs: integer("timeout_ms").notNull().default(15000),
    temperature: numeric("temperature", { precision: 4, scale: 2 }).notNull().default("0.00"),
    costPer1kInputUsd: numeric("cost_per_1k_input_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    costPer1kOutputUsd: numeric("cost_per_1k_output_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("ai_model_provider_layer_uq").on(t.providerKey, t.taskLayer, t.modelName)]
);

export const aiPromptVersions = pgTable(
  "ai_prompt_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskKey: varchar("task_key", { length: 64 }).notNull(),
    version: integer("version").notNull(),
    systemPromptHash: varchar("system_prompt_hash", { length: 64 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 32 }).notNull(),
    description: text("description"),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("ai_prompt_task_version_uq").on(t.taskKey, t.version)]
);

export const aiModelRuns = pgTable(
  "ai_model_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerKey: varchar("provider_key", { length: 32 }).notNull(),
    modelName: varchar("model_name", { length: 80 }).notNull(),
    taskLayer: varchar("task_layer", { length: 32 }).notNull(),
    taskKey: varchar("task_key", { length: 64 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 32 }).notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    outputPayload: jsonb("output_payload").$type<Record<string, unknown>>().notNull().default({}),
    validationStatus: varchar("validation_status", { length: 24 }).notNull().default("pending"),
    validationErrors: jsonb("validation_errors").$type<string[]>().notNull().default([]),
    durationMs: integer("duration_ms").notNull().default(0),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
    errorMessage: text("error_message"),
    createdAt: createdAt()
  },
  (t) => [
    index("ai_model_runs_created_idx").on(t.createdAt),
    index("ai_model_runs_task_idx").on(t.taskKey, t.validationStatus, t.createdAt)
  ]
);

export const aiValidationResults = pgTable("ai_validation_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  aiRunId: uuid("ai_run_id").notNull().references(() => aiModelRuns.id),
  valid: boolean("valid").notNull(),
  checksPassed: jsonb("checks_passed").$type<string[]>().notNull().default([]),
  checksFailed: jsonb("checks_failed").$type<string[]>().notNull().default([]),
  downgraded: boolean("downgraded").notNull().default(false),
  notes: text("notes"),
  createdAt: createdAt()
});

export const aiUsageRecords = pgTable(
  "ai_usage_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerKey: varchar("provider_key", { length: 32 }).notNull(),
    modelName: varchar("model_name", { length: 80 }).notNull(),
    windowDate: varchar("window_date", { length: 10 }).notNull(),
    requestsCount: integer("requests_count").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("ai_usage_provider_model_date_uq").on(t.providerKey, t.modelName, t.windowDate)]
);

export const newsAiAnalyses = pgTable(
  "news_ai_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id").references(() => newsArticles.id),
    newsEventId: uuid("news_event_id").references(() => newsEvents.id),
    aiRunId: uuid("ai_run_id").references(() => aiModelRuns.id),
    layer: varchar("layer", { length: 32 }).notNull(),
    structuredFacts: jsonb("structured_facts").$type<Array<Record<string, unknown>>>().notNull().default([]),
    interpretations: jsonb("interpretations").$type<Array<Record<string, unknown>>>().notNull().default([]),
    scenarios: jsonb("scenarios").$type<Array<Record<string, unknown>>>().notNull().default([]),
    affectedAssets: jsonb("affected_assets").$type<Array<Record<string, unknown>>>().notNull().default([]),
    validationStatus: varchar("validation_status", { length: 24 }).notNull().default("validated"),
    validationErrors: jsonb("validation_errors").$type<string[]>().notNull().default([]),
    createdAt: createdAt()
  },
  (t) => [index("news_ai_analyses_event_idx").on(t.newsEventId, t.createdAt)]
);

export const eventSources = pgTable("event_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  sourceType: varchar("source_type", { length: 32 }).notNull(),
  credibilityScore: numeric("credibility_score", { precision: 5, scale: 2 }).notNull().default("85.00"),
  enabled: boolean("enabled").notNull().default(true),
  requiresCredentials: boolean("requires_credentials").notNull().default(false),
  credentialEnvVar: varchar("credential_env_var", { length: 64 }),
  providerStatus: varchar("provider_status", { length: 32 }).notNull().default("ready"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt()
});

export const economicEvents = pgTable(
  "economic_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    dedupeKey: varchar("dedupe_key", { length: 180 }).notNull().unique(),
    sourceId: uuid("source_id").references(() => eventSources.id),
    eventType: varchar("event_type", { length: 32 }).notNull().default("scheduled_economic"),
    category: varchar("category", { length: 64 }).notNull(),
    eventName: varchar("event_name", { length: 180 }).notNull(),
    country: varchar("country", { length: 16 }).notNull().default("US"),
    currency: varchar("currency", { length: 16 }).notNull().default("USD"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
    timezone: varchar("timezone", { length: 32 }).notNull().default("UTC"),
    previousValue: numeric("previous_value", { precision: 24, scale: 8 }),
    revisedPreviousValue: numeric("revised_previous_value", { precision: 24, scale: 8 }),
    consensusValue: numeric("consensus_value", { precision: 24, scale: 8 }),
    actualValue: numeric("actual_value", { precision: 24, scale: 8 }),
    unit: varchar("unit", { length: 24 }),
    importance: varchar("importance", { length: 16 }).notNull().default("high"),
    status: varchar("status", { length: 24 }).notNull().default("scheduled"),
    isScheduled: boolean("is_scheduled").notNull().default(true),
    verifiedEvidence: jsonb("verified_evidence").$type<Array<Record<string, unknown>>>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("economic_events_scheduled_idx").on(t.scheduledAt, t.importance),
    index("economic_events_category_status_idx").on(t.category, t.status, t.scheduledAt)
  ]
);

export const eventExpectations = pgTable(
  "event_expectations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id").notNull().references(() => economicEvents.id),
    consensusValue: numeric("consensus_value", { precision: 24, scale: 8 }),
    forecastLow: numeric("forecast_low", { precision: 24, scale: 8 }),
    forecastHigh: numeric("forecast_high", { precision: 24, scale: 8 }),
    unit: varchar("unit", { length: 24 }),
    source: varchar("source", { length: 80 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("event_expectations_event_idx").on(t.eventId, t.recordedAt)]
);

export const eventActualResults = pgTable(
  "event_actual_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id").notNull().references(() => economicEvents.id),
    actualValue: numeric("actual_value", { precision: 24, scale: 8 }).notNull(),
    previousValue: numeric("previous_value", { precision: 24, scale: 8 }),
    revisedPreviousValue: numeric("revised_previous_value", { precision: 24, scale: 8 }),
    surpriseValue: numeric("surprise_value", { precision: 24, scale: 8 }),
    surprisePct: numeric("surprise_pct", { precision: 12, scale: 4 }),
    releaseTimestamp: timestamp("release_timestamp", { withTimezone: true }).notNull(),
    source: varchar("source", { length: 80 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("event_actual_results_event_idx").on(t.eventId, t.releaseTimestamp)]
);

export const eventAssetMappings = pgTable(
  "event_asset_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventCategory: varchar("event_category", { length: 64 }).notNull(),
    eventPattern: varchar("event_pattern", { length: 120 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    market: varchar("market", { length: 16 }).notNull(),
    sensitivity: varchar("sensitivity", { length: 16 }).notNull().default("high"),
    relationshipType: varchar("relationship_type", { length: 32 }).notNull().default("macro_driver"),
    notes: text("notes"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt()
  },
  (t) => [
    uniqueIndex("event_asset_mapping_uq").on(t.eventCategory, t.eventPattern, t.symbol),
    index("event_asset_mappings_category_idx").on(t.eventCategory, t.symbol)
  ]
);

export const eventUpdates = pgTable("event_updates", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: uuid("event_id").notNull().references(() => economicEvents.id),
  fieldChanged: varchar("field_changed", { length: 64 }).notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  source: varchar("source", { length: 80 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
});

export const eventLifecycleRecords = pgTable(
  "event_lifecycle_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id").notNull().references(() => economicEvents.id),
    fromStatus: varchar("from_status", { length: 24 }),
    toStatus: varchar("to_status", { length: 24 }).notNull(),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("event_lifecycle_event_idx").on(t.eventId, t.occurredAt)]
);

export const eventStrategyConfigs = pgTable(
  "event_strategy_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 64 }).notNull(),
    version: integer("version").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    strategyType: varchar("strategy_type", { length: 32 }).notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(false),
    approved: boolean("approved").notNull().default(false),
    approvalNote: text("approval_note"),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    riskConfig: jsonb("risk_config").$type<Record<string, unknown>>().notNull().default({}),
    parameterHash: varchar("parameter_hash", { length: 64 }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("event_strategy_key_version_uq").on(t.key, t.version)]
);

export const eventSignals = pgTable(
  "event_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull().unique(),
    eventId: uuid("event_id").references(() => economicEvents.id),
    newsEventId: uuid("news_event_id").references(() => newsEvents.id),
    instrumentId: uuid("instrument_id").references(() => instruments.id),
    strategyConfigId: uuid("strategy_config_id").references(() => eventStrategyConfigs.id),
    strategyKey: varchar("strategy_key", { length: 64 }).notNull(),
    strategyVersion: integer("strategy_version").notNull().default(1),
    strategyType: varchar("strategy_type", { length: 32 }).notNull(),
    eventCategory: varchar("event_category", { length: 64 }).notNull(),
    eventName: varchar("event_name", { length: 180 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    market: varchar("market", { length: 16 }).notNull(),
    timeframe: varchar("timeframe", { length: 8 }).notNull(),
    confirmationTimeframe: varchar("confirmation_timeframe", { length: 8 }),
    direction: varchar("direction", { length: 16 }).notNull(),
    actionClassification: varchar("action_classification", { length: 24 }).notNull().default("NO_TRADE"),
    entryPrice: numeric("entry_price", { precision: 28, scale: 12 }),
    stopLoss: numeric("stop_loss", { precision: 28, scale: 12 }),
    targets: jsonb("targets").$type<Array<{ price: string; rewardRisk: string; allocationPct?: number }>>().notNull().default([]),
    rewardRisk: numeric("reward_risk", { precision: 12, scale: 4 }),
    eventImportance: varchar("event_importance", { length: 16 }).notNull().default("high"),
    riskClassification: varchar("risk_classification", { length: 24 }).notNull().default("HIGH_RISK"),
    scheduledEventAt: timestamp("scheduled_event_at", { withTimezone: true }),
    actualEventAt: timestamp("actual_event_at", { withTimezone: true }),
    sourceReferences: jsonb("source_references").$type<string[]>().notNull().default([]),
    quantitativeEvidence: jsonb("quantitative_evidence").$type<Record<string, unknown>>().notNull().default({}),
    aiAnalysisId: uuid("ai_analysis_id").references(() => newsAiAnalyses.id),
    scoreBreakdown: jsonb("score_breakdown").$type<Record<string, unknown>>().notNull().default({}),
    validationStatus: varchar("validation_status", { length: 24 }).notNull().default("pending_validation"),
    rejectionReason: text("rejection_reason"),
    outcomeStatus: varchar("outcome_status", { length: 24 }).notNull().default("detected"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("event_signals_symbol_created_idx").on(t.symbol, t.createdAt),
    index("event_signals_status_idx").on(t.outcomeStatus, t.validationStatus, t.createdAt)
  ]
);

export const eventSignalEvidence = pgTable(
  "event_signal_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventSignalId: uuid("event_signal_id").notNull().references(() => eventSignals.id),
    evidenceType: varchar("evidence_type", { length: 32 }).notNull(),
    sourceRef: varchar("source_ref", { length: 180 }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt()
  },
  (t) => [index("event_signal_evidence_sig_idx").on(t.eventSignalId, t.createdAt)]
);

export const eventSignalOutcomes = pgTable("event_signal_outcomes", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventSignalId: uuid("event_signal_id").notNull().unique().references(() => eventSignals.id),
  status: varchar("status", { length: 24 }).notNull().default("pending"),
  intendedEntry: numeric("intended_entry", { precision: 28, scale: 12 }),
  observedEntryAssumption: numeric("observed_entry_assumption", { precision: 28, scale: 12 }),
  estimatedSlippageBps: numeric("estimated_slippage_bps", { precision: 10, scale: 4 }).notNull().default("0"),
  exitPrice: numeric("exit_price", { precision: 28, scale: 12 }),
  exitTime: timestamp("exit_time", { withTimezone: true }),
  netReturn: numeric("net_return", { precision: 16, scale: 8 }),
  maxFavorableExcursion: numeric("max_favorable_excursion", { precision: 16, scale: 8 }),
  maxAdverseExcursion: numeric("max_adverse_excursion", { precision: 16, scale: 8 }),
  holdingSeconds: integer("holding_seconds"),
  methodology: varchar("methodology", { length: 64 }).notNull().default("stop_first_gap_aware_ohlc"),
  closedReason: varchar("closed_reason", { length: 32 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const eventBacktestRuns = pgTable(
  "event_backtest_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    strategyKey: varchar("strategy_key", { length: 64 }).notNull(),
    strategyVersion: integer("strategy_version").notNull().default(1),
    eventCategory: varchar("event_category", { length: 64 }),
    symbol: varchar("symbol", { length: 32 }),
    timeframe: varchar("timeframe", { length: 8 }).notNull(),
    dataset: jsonb("dataset").$type<Record<string, unknown>>().notNull().default({}),
    assumptions: jsonb("assumptions").$type<Record<string, unknown>>().notNull().default({}),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 24 }).notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt()
  },
  (t) => [index("event_backtest_runs_status_idx").on(t.status, t.createdAt)]
);

export const eventBacktestTrades = pgTable(
  "event_backtest_trades",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    backtestRunId: uuid("backtest_run_id").notNull().references(() => eventBacktestRuns.id),
    eventId: varchar("event_id", { length: 120 }),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    strategyKey: varchar("strategy_key", { length: 64 }).notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    entryTime: timestamp("entry_time", { withTimezone: true }).notNull(),
    exitTime: timestamp("exit_time", { withTimezone: true }).notNull(),
    entryPrice: numeric("entry_price", { precision: 28, scale: 12 }).notNull(),
    exitPrice: numeric("exit_price", { precision: 28, scale: 12 }).notNull(),
    grossReturn: numeric("gross_return", { precision: 16, scale: 8 }).notNull(),
    netReturn: numeric("net_return", { precision: 16, scale: 8 }).notNull(),
    slippageBps: numeric("slippage_bps", { precision: 10, scale: 4 }).notNull().default("0"),
    outcome: varchar("outcome", { length: 24 }).notNull(),
    createdAt: createdAt()
  },
  (t) => [index("event_backtest_trades_run_idx").on(t.backtestRunId, t.entryTime)]
);

export const intelligenceReports = pgTable(
  "intelligence_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reportKey: varchar("report_key", { length: 180 }).notNull().unique(),
    reportType: varchar("report_type", { length: 32 }).notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    marketRegime: varchar("market_regime", { length: 32 }).notNull().default("mixed"),
    sections: jsonb("sections").$type<Array<Record<string, unknown>>>().notNull().default([]),
    evidenceRefs: jsonb("evidence_refs").$type<Array<Record<string, unknown>>>().notNull().default([]),
    riskWarnings: jsonb("risk_warnings").$type<string[]>().notNull().default([]),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("intelligence_reports_generated_idx").on(t.generatedAt)]
);

export const intelligenceEvidence = pgTable("intelligence_evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportId: uuid("report_id").notNull().references(() => intelligenceReports.id),
  sourceType: varchar("source_type", { length: 32 }).notNull(),
  sourceId: varchar("source_id", { length: 120 }).notNull(),
  summary: text("summary").notNull(),
  weight: numeric("weight", { precision: 5, scale: 2 }).notNull().default("1.00"),
  createdAt: createdAt()
});

export const marketEventCorrelations = pgTable(
  "market_event_correlations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id").references(() => economicEvents.id),
    newsEventId: uuid("news_event_id").references(() => newsEvents.id),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 8 }).notNull().default("15m"),
    reaction15mPct: numeric("reaction_15m_pct", { precision: 12, scale: 4 }),
    reaction1hPct: numeric("reaction_1h_pct", { precision: 12, scale: 4 }),
    reaction4hPct: numeric("reaction_4h_pct", { precision: 12, scale: 4 }),
    volumeRatio: numeric("volume_ratio", { precision: 10, scale: 4 }),
    volatilityRatio: numeric("volatility_ratio", { precision: 10, scale: 4 }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("market_event_correlations_sym_idx").on(t.symbol, t.observedAt)]
);

export const signalContextRecords = pgTable(
  "signal_context_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    technicalSignalId: uuid("technical_signal_id").references(() => signals.id),
    eventSignalId: uuid("event_signal_id").references(() => eventSignals.id),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    timeframe: varchar("timeframe", { length: 8 }).notNull(),
    alignmentStatus: varchar("alignment_status", { length: 32 }).notNull().default("neutral"),
    eventRiskLevel: varchar("event_risk_level", { length: 24 }).notNull().default("normal"),
    recommendation: varchar("recommendation", { length: 32 }).notNull().default("PROCEED_QUANTITATIVE_ONLY"),
    evidenceDimensions: jsonb("evidence_dimensions").$type<Record<string, unknown>>().notNull().default({}),
    nearbyEventIds: jsonb("nearby_event_ids").$type<string[]>().notNull().default([]),
    relatedNewsIds: jsonb("related_news_ids").$type<string[]>().notNull().default([]),
    rationale: jsonb("rationale").$type<string[]>().notNull().default([]),
    createdAt: createdAt()
  },
  (t) => [index("signal_context_tech_sig_idx").on(t.technicalSignalId, t.createdAt)]
);
