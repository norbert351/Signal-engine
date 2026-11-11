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
    ingestedAt: createdAt()
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
    occurredAt: createdAt()
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

export const systemAlerts = pgTable(
  "system_alerts",
  {
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
  }
);

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
  (t) => [uniqueIndex("backfill_progress_uq").on(t.provider, t.symbol, t.timeframe, t.startTime, t.endTime), index("backfill_progress_status_idx").on(t.status, t.updatedAt)]
);
