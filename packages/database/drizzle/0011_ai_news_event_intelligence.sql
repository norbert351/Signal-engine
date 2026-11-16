-- Additive migration 0011: AI, News Intelligence, Global Events & Event Trading
-- Preserves all existing tables, data, and disabled strategy states.
-- Ensures TONUSDT remains disabled/unavailable until exchange confirms TRADING status.

UPDATE instruments
SET enabled = false, available = false, updated_at = now()
WHERE provider = 'binance_usdm' AND symbol = 'TONUSDT'
  AND (metadata->>'status' IS NULL OR metadata->>'status' <> 'TRADING');

-- ============================================================================
-- 1. NEWS INTELLIGENCE TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS news_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(64) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  source_type varchar(32) NOT NULL,
  url text,
  credibility_tier varchar(32) NOT NULL DEFAULT 'tier2_financial',
  credibility_score numeric(5,2) NOT NULL DEFAULT 75.00,
  enabled boolean NOT NULL DEFAULT true,
  requires_credentials boolean NOT NULL DEFAULT false,
  credential_env_var varchar(64),
  provider_status varchar(32) NOT NULL DEFAULT 'ready',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS news_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES news_sources(id),
  external_id varchar(180),
  url text NOT NULL,
  title text NOT NULL,
  summary text,
  content_snippet text,
  author varchar(120),
  published_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  normalized_at timestamptz NOT NULL DEFAULT now(),
  content_hash varchar(64) NOT NULL UNIQUE,
  title_fingerprint varchar(64) NOT NULL,
  duplicate_of_id uuid REFERENCES news_articles(id),
  category varchar(64) NOT NULL,
  subcategory varchar(64),
  credibility_score numeric(5,2) NOT NULL DEFAULT 70.00,
  relevance_score numeric(5,2) NOT NULL DEFAULT 50.00,
  importance varchar(16) NOT NULL DEFAULT 'medium',
  direction_bias varchar(16) NOT NULL DEFAULT 'neutral',
  status varchar(24) NOT NULL DEFAULT 'normalized',
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_articles_published_idx ON news_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS news_articles_fingerprint_idx ON news_articles(title_fingerprint, published_at DESC);
CREATE INDEX IF NOT EXISTS news_articles_category_idx ON news_articles(category, importance, published_at DESC);

CREATE TABLE IF NOT EXISTS news_article_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES news_articles(id),
  update_type varchar(32) NOT NULL,
  summary text NOT NULL,
  previous_hash varchar(64),
  new_hash varchar(64),
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_article_updates_article_idx ON news_article_updates(article_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS news_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(32) NOT NULL,
  canonical_name varchar(120) NOT NULL,
  code varchar(32) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_entity_type_code_uq UNIQUE(entity_type, code)
);

CREATE TABLE IF NOT EXISTS news_article_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES news_articles(id),
  entity_id uuid NOT NULL REFERENCES news_entities(id),
  role varchar(32) NOT NULL DEFAULT 'mentioned',
  confidence numeric(5,2) NOT NULL DEFAULT 80.00,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_article_entity_uq UNIQUE(article_id, entity_id)
);

CREATE TABLE IF NOT EXISTS news_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key varchar(180) NOT NULL UNIQUE,
  primary_article_id uuid REFERENCES news_articles(id),
  category varchar(64) NOT NULL,
  headline text NOT NULL,
  summary text,
  structured_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  importance varchar(16) NOT NULL DEFAULT 'medium',
  direction_bias varchar(16) NOT NULL DEFAULT 'neutral',
  source_credibility numeric(5,2) NOT NULL DEFAULT 75.00,
  corroboration_count integer NOT NULL DEFAULT 1,
  conflicting_reports boolean NOT NULL DEFAULT false,
  status varchar(24) NOT NULL DEFAULT 'active',
  first_reported_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_events_reported_idx ON news_events(first_reported_at DESC);
CREATE INDEX IF NOT EXISTS news_events_category_idx ON news_events(category, importance, first_reported_at DESC);

CREATE TABLE IF NOT EXISTS news_event_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  news_event_id uuid NOT NULL REFERENCES news_events(id),
  symbol varchar(32) NOT NULL,
  market varchar(16) NOT NULL,
  relationship_type varchar(32) NOT NULL DEFAULT 'direct',
  direction_hypothesis varchar(16) NOT NULL DEFAULT 'uncertain',
  relevance_score numeric(5,2) NOT NULL DEFAULT 70.00,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_event_asset_uq UNIQUE(news_event_id, symbol)
);
CREATE INDEX IF NOT EXISTS news_event_assets_symbol_idx ON news_event_assets(symbol, created_at DESC);

-- ============================================================================
-- 2. AI PROVIDERS, MODELS, RUNS & VALIDATION TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(32) NOT NULL UNIQUE,
  name varchar(80) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  requires_credentials boolean NOT NULL DEFAULT true,
  credential_env_var varchar(64),
  health_status varchar(24) NOT NULL DEFAULT 'awaiting_credentials',
  last_checked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_model_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key varchar(32) NOT NULL REFERENCES ai_providers(key),
  task_layer varchar(32) NOT NULL,
  model_name varchar(80) NOT NULL,
  max_tokens integer NOT NULL DEFAULT 1024,
  timeout_ms integer NOT NULL DEFAULT 15000,
  temperature numeric(4,2) NOT NULL DEFAULT 0.00,
  cost_per_1k_input_usd numeric(10,6) NOT NULL DEFAULT 0,
  cost_per_1k_output_usd numeric(10,6) NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_model_provider_layer_uq UNIQUE(provider_key, task_layer, model_name)
);

CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_key varchar(64) NOT NULL,
  version integer NOT NULL,
  system_prompt_hash varchar(64) NOT NULL,
  schema_version varchar(32) NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_prompt_task_version_uq UNIQUE(task_key, version)
);

CREATE TABLE IF NOT EXISTS ai_model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key varchar(32) NOT NULL,
  model_name varchar(80) NOT NULL,
  task_layer varchar(32) NOT NULL,
  task_key varchar(64) NOT NULL,
  prompt_version varchar(32) NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_status varchar(24) NOT NULL DEFAULT 'pending',
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms integer NOT NULL DEFAULT 0,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12,6),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_model_runs_created_idx ON ai_model_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS ai_model_runs_task_idx ON ai_model_runs(task_key, validation_status, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_validation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_run_id uuid NOT NULL REFERENCES ai_model_runs(id),
  valid boolean NOT NULL,
  checks_passed jsonb NOT NULL DEFAULT '[]'::jsonb,
  checks_failed jsonb NOT NULL DEFAULT '[]'::jsonb,
  downgraded boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key varchar(32) NOT NULL,
  model_name varchar(80) NOT NULL,
  window_date varchar(10) NOT NULL,
  requests_count integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_provider_model_date_uq UNIQUE(provider_key, model_name, window_date)
);

CREATE TABLE IF NOT EXISTS news_ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid REFERENCES news_articles(id),
  news_event_id uuid REFERENCES news_events(id),
  ai_run_id uuid REFERENCES ai_model_runs(id),
  layer varchar(32) NOT NULL,
  structured_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  interpretations jsonb NOT NULL DEFAULT '[]'::jsonb,
  scenarios jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_assets jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_status varchar(24) NOT NULL DEFAULT 'validated',
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_ai_analyses_event_idx ON news_ai_analyses(news_event_id, created_at DESC);

-- ============================================================================
-- 3. GLOBAL EVENTS INTELLIGENCE TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(64) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  source_type varchar(32) NOT NULL,
  credibility_score numeric(5,2) NOT NULL DEFAULT 85.00,
  enabled boolean NOT NULL DEFAULT true,
  requires_credentials boolean NOT NULL DEFAULT false,
  credential_env_var varchar(64),
  provider_status varchar(32) NOT NULL DEFAULT 'ready',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key varchar(180) NOT NULL UNIQUE,
  source_id uuid REFERENCES event_sources(id),
  event_type varchar(32) NOT NULL DEFAULT 'scheduled_economic',
  category varchar(64) NOT NULL,
  event_name varchar(180) NOT NULL,
  country varchar(16) NOT NULL DEFAULT 'US',
  currency varchar(16) NOT NULL DEFAULT 'USD',
  scheduled_at timestamptz,
  published_at timestamptz,
  collected_at timestamptz NOT NULL DEFAULT now(),
  timezone varchar(32) NOT NULL DEFAULT 'UTC',
  previous_value numeric(24,8),
  revised_previous_value numeric(24,8),
  consensus_value numeric(24,8),
  actual_value numeric(24,8),
  unit varchar(24),
  importance varchar(16) NOT NULL DEFAULT 'high',
  status varchar(24) NOT NULL DEFAULT 'scheduled',
  is_scheduled boolean NOT NULL DEFAULT true,
  verified_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS economic_events_scheduled_idx ON economic_events(scheduled_at ASC, importance);
CREATE INDEX IF NOT EXISTS economic_events_category_status_idx ON economic_events(category, status, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS event_expectations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES economic_events(id),
  consensus_value numeric(24,8),
  forecast_low numeric(24,8),
  forecast_high numeric(24,8),
  unit varchar(24),
  source varchar(80) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_expectations_event_idx ON event_expectations(event_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS event_actual_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES economic_events(id),
  actual_value numeric(24,8) NOT NULL,
  previous_value numeric(24,8),
  revised_previous_value numeric(24,8),
  surprise_value numeric(24,8),
  surprise_pct numeric(12,4),
  release_timestamp timestamptz NOT NULL,
  source varchar(80) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_actual_results_event_idx ON event_actual_results(event_id, release_timestamp DESC);

CREATE TABLE IF NOT EXISTS event_asset_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_category varchar(64) NOT NULL,
  event_pattern varchar(120) NOT NULL,
  symbol varchar(32) NOT NULL,
  market varchar(16) NOT NULL,
  sensitivity varchar(16) NOT NULL DEFAULT 'high',
  relationship_type varchar(32) NOT NULL DEFAULT 'macro_driver',
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_asset_mapping_uq UNIQUE(event_category, event_pattern, symbol)
);
CREATE INDEX IF NOT EXISTS event_asset_mappings_category_idx ON event_asset_mappings(event_category, symbol);

CREATE TABLE IF NOT EXISTS event_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES economic_events(id),
  field_changed varchar(64) NOT NULL,
  old_value text,
  new_value text,
  source varchar(80) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_lifecycle_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES economic_events(id),
  from_status varchar(24),
  to_status varchar(24) NOT NULL,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_lifecycle_event_idx ON event_lifecycle_records(event_id, occurred_at ASC);

-- ============================================================================
-- 4. EVENT TRADING INTELLIGENCE TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_strategy_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(64) NOT NULL,
  version integer NOT NULL,
  name varchar(120) NOT NULL,
  strategy_type varchar(32) NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT false,
  approved boolean NOT NULL DEFAULT false,
  approval_note text,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  parameter_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_strategy_key_version_uq UNIQUE(key, version)
);

CREATE TABLE IF NOT EXISTS event_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key varchar(200) NOT NULL UNIQUE,
  event_id uuid REFERENCES economic_events(id),
  news_event_id uuid REFERENCES news_events(id),
  instrument_id uuid REFERENCES instruments(id),
  strategy_config_id uuid REFERENCES event_strategy_configs(id),
  strategy_key varchar(64) NOT NULL,
  strategy_version integer NOT NULL DEFAULT 1,
  strategy_type varchar(32) NOT NULL,
  event_category varchar(64) NOT NULL,
  event_name varchar(180) NOT NULL,
  symbol varchar(32) NOT NULL,
  market varchar(16) NOT NULL,
  timeframe varchar(8) NOT NULL,
  confirmation_timeframe varchar(8),
  direction varchar(16) NOT NULL,
  action_classification varchar(24) NOT NULL DEFAULT 'NO_TRADE',
  entry_price numeric(28,12),
  stop_loss numeric(28,12),
  targets jsonb NOT NULL DEFAULT '[]'::jsonb,
  reward_risk numeric(12,4),
  event_importance varchar(16) NOT NULL DEFAULT 'high',
  risk_classification varchar(24) NOT NULL DEFAULT 'HIGH_RISK',
  scheduled_event_at timestamptz,
  actual_event_at timestamptz,
  source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  quantitative_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_analysis_id uuid REFERENCES news_ai_analyses(id),
  score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_status varchar(24) NOT NULL DEFAULT 'pending_validation',
  rejection_reason text,
  outcome_status varchar(24) NOT NULL DEFAULT 'detected',
  published_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_signals_symbol_created_idx ON event_signals(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS event_signals_status_idx ON event_signals(outcome_status, validation_status, created_at DESC);

CREATE TABLE IF NOT EXISTS event_signal_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_signal_id uuid NOT NULL REFERENCES event_signals(id),
  evidence_type varchar(32) NOT NULL,
  source_ref varchar(180),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_signal_evidence_sig_idx ON event_signal_evidence(event_signal_id, created_at ASC);

CREATE TABLE IF NOT EXISTS event_signal_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_signal_id uuid NOT NULL UNIQUE REFERENCES event_signals(id),
  status varchar(24) NOT NULL DEFAULT 'pending',
  intended_entry numeric(28,12),
  observed_entry_assumption numeric(28,12),
  estimated_slippage_bps numeric(10,4) NOT NULL DEFAULT 0,
  exit_price numeric(28,12),
  exit_time timestamptz,
  net_return numeric(16,8),
  max_favorable_excursion numeric(16,8),
  max_adverse_excursion numeric(16,8),
  holding_seconds integer,
  methodology varchar(64) NOT NULL DEFAULT 'stop_first_gap_aware_ohlc',
  closed_reason varchar(32),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_backtest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_key varchar(64) NOT NULL,
  strategy_version integer NOT NULL DEFAULT 1,
  event_category varchar(64),
  symbol varchar(32),
  timeframe varchar(8) NOT NULL,
  dataset jsonb NOT NULL DEFAULT '{}'::jsonb,
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_backtest_runs_status_idx ON event_backtest_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS event_backtest_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backtest_run_id uuid NOT NULL REFERENCES event_backtest_runs(id),
  event_id varchar(120),
  symbol varchar(32) NOT NULL,
  strategy_key varchar(64) NOT NULL,
  direction varchar(16) NOT NULL,
  entry_time timestamptz NOT NULL,
  exit_time timestamptz NOT NULL,
  entry_price numeric(28,12) NOT NULL,
  exit_price numeric(28,12) NOT NULL,
  gross_return numeric(16,8) NOT NULL,
  net_return numeric(16,8) NOT NULL,
  slippage_bps numeric(10,4) NOT NULL DEFAULT 0,
  outcome varchar(24) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_backtest_trades_run_idx ON event_backtest_trades(backtest_run_id, entry_time ASC);

-- ============================================================================
-- 5. CENTRAL INTELLIGENCE & CORRELATION TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS intelligence_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_key varchar(180) NOT NULL UNIQUE,
  report_type varchar(32) NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  market_regime varchar(32) NOT NULL DEFAULT 'mixed',
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_reports_generated_idx ON intelligence_reports(generated_at DESC);

CREATE TABLE IF NOT EXISTS intelligence_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES intelligence_reports(id),
  source_type varchar(32) NOT NULL,
  source_id varchar(120) NOT NULL,
  summary text NOT NULL,
  weight numeric(5,2) NOT NULL DEFAULT 1.00,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_event_correlations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES economic_events(id),
  news_event_id uuid REFERENCES news_events(id),
  symbol varchar(32) NOT NULL,
  timeframe varchar(8) NOT NULL DEFAULT '15m',
  reaction_15m_pct numeric(12,4),
  reaction_1h_pct numeric(12,4),
  reaction_4h_pct numeric(12,4),
  volume_ratio numeric(10,4),
  volatility_ratio numeric(10,4),
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_event_correlations_sym_idx ON market_event_correlations(symbol, observed_at DESC);

CREATE TABLE IF NOT EXISTS signal_context_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  technical_signal_id uuid REFERENCES signal_records(id),
  event_signal_id uuid REFERENCES event_signals(id),
  symbol varchar(32) NOT NULL,
  timeframe varchar(8) NOT NULL,
  alignment_status varchar(32) NOT NULL DEFAULT 'neutral',
  event_risk_level varchar(24) NOT NULL DEFAULT 'normal',
  recommendation varchar(32) NOT NULL DEFAULT 'PROCEED_QUANTITATIVE_ONLY',
  evidence_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  nearby_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_news_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signal_context_tech_sig_idx ON signal_context_records(technical_signal_id, created_at DESC);

-- ============================================================================
-- 6. SEED SOURCES, ASSET MAPPINGS, AI PROVIDERS & DISABLED EVENT STRATEGIES
-- ============================================================================

INSERT INTO news_sources(key, name, source_type, url, credibility_tier, credibility_score, enabled, requires_credentials, credential_env_var, provider_status) VALUES
('federal_reserve_rss', 'Federal Reserve Official Releases', 'official_rss', 'https://www.federalreserve.gov/feeds/press_all.xml', 'official_primary', 98.00, true, false, NULL, 'ready'),
('ecb_press_rss', 'European Central Bank Press Releases', 'official_rss', 'https://www.ecb.europa.eu/rss/press.html', 'official_primary', 98.00, true, false, NULL, 'ready'),
('sec_press_rss', 'US SEC Official Press Releases', 'official_rss', 'https://www.sec.gov/news/pressreleases.rss', 'official_primary', 97.00, true, false, NULL, 'ready'),
('binance_announcements', 'Binance Official Exchange Announcements', 'official_announcement', 'https://www.binance.com/en/support/announcement', 'official_primary', 92.00, true, false, NULL, 'ready'),
('cryptopanic_api', 'CryptoPanic News Aggregator API', 'rest_api', 'https://cryptopanic.com/api/v1/posts/', 'tier2_financial', 78.00, true, true, 'CRYPTOPANIC_API_KEY', 'awaiting_credentials'),
('newsapi_financial', 'NewsAPI Financial Wire Adapter', 'rest_api', 'https://newsapi.org/v2/everything', 'tier1_wire', 85.00, true, true, 'NEWS_API_KEY', 'awaiting_credentials')
ON CONFLICT(key) DO NOTHING;

INSERT INTO event_sources(key, name, source_type, credibility_score, enabled, requires_credentials, credential_env_var, provider_status) VALUES
('official_central_bank_calendar', 'Official Central Bank & Macro Schedule', 'official_calendar', 98.00, true, false, NULL, 'ready'),
('twelve_data_economic_calendar', 'Twelve Data Economic Calendar Adapter', 'rest_api', 90.00, true, true, 'TWELVE_DATA_API_KEY', 'ready'),
('verified_news_event_bridge', 'Verified News-to-Event Escalation Bridge', 'internal_verified', 88.00, true, false, NULL, 'ready')
ON CONFLICT(key) DO NOTHING;

INSERT INTO event_asset_mappings(event_category, event_pattern, symbol, market, sensitivity, relationship_type, notes) VALUES
('inflation_announcements', 'US_CPI', 'EUR_USD', 'forex', 'high', 'macro_driver', 'US CPI impacts USD rate expectations vs EUR'),
('inflation_announcements', 'US_CPI', 'GBP_USD', 'forex', 'high', 'macro_driver', 'US CPI impacts USD rate expectations vs GBP'),
('inflation_announcements', 'US_CPI', 'USD_JPY', 'forex', 'high', 'macro_driver', 'US CPI drives US Treasury yields and USD/JPY'),
('inflation_announcements', 'US_CPI', 'XAU_USD', 'forex', 'high', 'macro_driver', 'US CPI impacts real yields and USD gold pricing'),
('inflation_announcements', 'US_CPI', 'BTCUSDT', 'crypto_perpetual', 'high', 'macro_driver', 'US CPI impacts macro liquidity and crypto risk appetite'),
('central_bank_decisions', 'FOMC', 'EUR_USD', 'forex', 'high', 'macro_driver', 'Federal Reserve rate decision and statement'),
('central_bank_decisions', 'FOMC', 'GBP_USD', 'forex', 'high', 'macro_driver', 'Federal Reserve rate decision and statement'),
('central_bank_decisions', 'FOMC', 'USD_JPY', 'forex', 'high', 'macro_driver', 'Federal Reserve rate decision and statement'),
('central_bank_decisions', 'FOMC', 'XAU_USD', 'forex', 'high', 'macro_driver', 'Federal Reserve rate decision and statement'),
('central_bank_decisions', 'FOMC', 'BTCUSDT', 'crypto_perpetual', 'high', 'macro_driver', 'Federal Reserve rate decision and statement'),
('central_bank_decisions', 'FOMC', 'ETHUSDT', 'crypto_perpetual', 'high', 'macro_driver', 'Federal Reserve rate decision and statement'),
('central_bank_decisions', 'ECB', 'EUR_USD', 'forex', 'high', 'macro_driver', 'ECB Governing Council rate decision'),
('central_bank_decisions', 'ECB', 'EUR_JPY', 'forex', 'high', 'macro_driver', 'ECB Governing Council rate decision'),
('central_bank_decisions', 'BOJ', 'USD_JPY', 'forex', 'high', 'macro_driver', 'Bank of Japan monetary policy decision'),
('central_bank_decisions', 'BOJ', 'EUR_JPY', 'forex', 'high', 'macro_driver', 'Bank of Japan monetary policy decision'),
('central_bank_decisions', 'BOE', 'GBP_USD', 'forex', 'high', 'macro_driver', 'Bank of England MPC rate decision'),
('employment_reports', 'US_NFP', 'EUR_USD', 'forex', 'high', 'macro_driver', 'US Non-Farm Payrolls and unemployment report'),
('employment_reports', 'US_NFP', 'USD_JPY', 'forex', 'high', 'macro_driver', 'US Non-Farm Payrolls and unemployment report'),
('employment_reports', 'US_NFP', 'XAU_USD', 'forex', 'high', 'macro_driver', 'US Non-Farm Payrolls and unemployment report'),
('employment_reports', 'US_NFP', 'BTCUSDT', 'crypto_perpetual', 'medium', 'macro_driver', 'US Non-Farm Payrolls macro liquidity impact'),
('etf_announcements', 'BTC_ETF', 'BTCUSDT', 'crypto_perpetual', 'high', 'direct_catalyst', 'Bitcoin spot/derivatives ETF regulatory decision'),
('etf_announcements', 'ETH_ETF', 'ETHUSDT', 'crypto_perpetual', 'high', 'direct_catalyst', 'Ethereum ETF regulatory decision'),
('crypto_protocol_upgrades', 'ETH_UPGRADE', 'ETHUSDT', 'crypto_perpetual', 'high', 'direct_catalyst', 'Ethereum network upgrade or hard fork'),
('geopolitical_developments', 'GEOPOLITICAL_ESCALATION', 'XAU_USD', 'forex', 'high', 'safe_haven', 'Geopolitical escalation safe-haven flow'),
('geopolitical_developments', 'GEOPOLITICAL_ESCALATION', 'BTCUSDT', 'crypto_perpetual', 'medium', 'risk_sentiment', 'Geopolitical risk impact on 24/7 crypto markets')
ON CONFLICT(event_category, event_pattern, symbol) DO NOTHING;

INSERT INTO ai_providers(key, name, enabled, requires_credentials, credential_env_var, health_status, metadata) VALUES
('deterministic_fallback', 'Deterministic Rule & Schema Fallback Engine', true, false, NULL, 'ok', '{"local":true,"costUsd":0}'::jsonb),
('openai', 'OpenAI Structured Reasoning Provider', true, true, 'OPENAI_API_KEY', 'awaiting_credentials', '{"endpoint":"https://api.openai.com/v1/chat/completions"}'::jsonb),
('anthropic', 'Anthropic Claude Reasoning Provider', true, true, 'ANTHROPIC_API_KEY', 'awaiting_credentials', '{"endpoint":"https://api.anthropic.com/v1/messages"}'::jsonb),
('gemini', 'Google Gemini Structured Intelligence Provider', true, true, 'GEMINI_API_KEY', 'awaiting_credentials', '{"endpoint":"https://generativelanguage.googleapis.com/v1beta"}'::jsonb)
ON CONFLICT(key) DO NOTHING;

INSERT INTO ai_model_configs(provider_key, task_layer, model_name, max_tokens, timeout_ms, temperature, cost_per_1k_input_usd, cost_per_1k_output_usd, enabled) VALUES
('deterministic_fallback', 'layer1_fast', 'deterministic-fast-v1', 512, 2000, 0.00, 0, 0, true),
('deterministic_fallback', 'layer2_reasoning', 'deterministic-reasoning-v1', 1024, 5000, 0.00, 0, 0, true),
('openai', 'layer1_fast', 'gpt-4o-mini', 800, 10000, 0.00, 0.000150, 0.000600, true),
('openai', 'layer2_reasoning', 'gpt-4o', 1500, 20000, 0.00, 0.002500, 0.010000, true),
('gemini', 'layer1_fast', 'gemini-2.5-flash', 800, 10000, 0.00, 0.000075, 0.000300, true),
('gemini', 'layer2_reasoning', 'gemini-2.5-pro', 1500, 20000, 0.00, 0.001250, 0.005000, true)
ON CONFLICT(provider_key, task_layer, model_name) DO NOTHING;

INSERT INTO ai_prompt_versions(task_key, version, system_prompt_hash, schema_version, description) VALUES
('news_layer1_extraction', 1, encode(digest('news_layer1_extraction:v1:untrusted_content_guard', 'sha256'), 'hex'), 'news-l1-v1', 'Fast article classification, entity extraction, and fact extraction with prompt-injection quarantine.'),
('news_layer2_reasoning', 1, encode(digest('news_layer2_reasoning:v1:fact_vs_scenario_separation', 'sha256'), 'hex'), 'news-l2-v1', 'Multi-source comparison, contradiction detection, and cross-asset scenario analysis.'),
('event_impact_interpretation', 1, encode(digest('event_impact_interpretation:v1:strict_macro_bounds', 'sha256'), 'hex'), 'event-l2-v1', 'Scheduled/unscheduled event surprise and cross-asset impact analysis.')
ON CONFLICT(task_key, version) DO NOTHING;

INSERT INTO event_strategy_configs(key, version, name, strategy_type, description, enabled, approved, parameters, risk_config, parameter_hash) VALUES
(
  'pre-event-positioning',
  1,
  'Pre-Event Positioning',
  'pre_event',
  'Evaluates pre-event trend alignment, S/R distance, volatility bounds, and blackout restrictions prior to a high-impact scheduled release. Never predicts announcement outcome.',
  false,
  false,
  '{"minLeadMinutes":30,"maxLeadMinutes":240,"blackoutMinutes":15,"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2.0,"target2Multiple":3.0,"maxVolatilityRatio":1.6}'::jsonb,
  '{"maxSpreadBps":15,"maxVolatilityRatio":1.6,"minLiquidityRatio":0.8,"maxConcurrentEventSignals":2,"preEventBlackoutMinutes":15,"postEventObservationMinutes":5,"minimumRewardRisk":2.0,"maximumStopDistancePct":3.5}'::jsonb,
  encode(digest('{"minLeadMinutes":30,"maxLeadMinutes":240,"blackoutMinutes":15,"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2.0,"target2Multiple":3.0,"maxVolatilityRatio":1.6}', 'sha256'), 'hex')
),
(
  'post-event-momentum',
  1,
  'Post-Event Momentum Continuation',
  'post_event_momentum',
  'Waits for verified actual event release and post-release observation window, requiring surprise alignment with candle displacement, volume expansion, spread normalization, and confirmation timeframe structure.',
  false,
  false,
  '{"minObservationMinutes":5,"maxWindowMinutes":120,"minSurprisePct":5.0,"minDisplacementAtr":0.8,"minVolumeRatio":1.2,"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2.0,"target2Multiple":3.0}'::jsonb,
  '{"maxSpreadBps":18,"maxVolatilityRatio":2.5,"minLiquidityRatio":1.0,"maxConcurrentEventSignals":3,"preEventBlackoutMinutes":15,"postEventObservationMinutes":5,"minimumRewardRisk":2.0,"maximumStopDistancePct":4.0}'::jsonb,
  encode(digest('{"minObservationMinutes":5,"maxWindowMinutes":120,"minSurprisePct":5.0,"minDisplacementAtr":0.8,"minVolumeRatio":1.2,"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2.0,"target2Multiple":3.0}', 'sha256'), 'hex')
),
(
  'post-event-reversal',
  1,
  'Post-Event Exhaustion Reversal',
  'post_event_reversal',
  'Detects post-event spike exhaustion where initial displacement rejects a structural level with wick rejection, momentum deterioration, spread normalization, and confirmation timeframe support.',
  false,
  false,
  '{"minObservationMinutes":15,"maxWindowMinutes":180,"minSpikeAtr":1.2,"minRejectionWickRatio":0.45,"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2.0,"target2Multiple":3.0}'::jsonb,
  '{"maxSpreadBps":16,"maxVolatilityRatio":2.2,"minLiquidityRatio":0.9,"maxConcurrentEventSignals":2,"preEventBlackoutMinutes":15,"postEventObservationMinutes":15,"minimumRewardRisk":2.0,"maximumStopDistancePct":4.0}'::jsonb,
  encode(digest('{"minObservationMinutes":15,"maxWindowMinutes":180,"minSpikeAtr":1.2,"minRejectionWickRatio":0.45,"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2.0,"target2Multiple":3.0}', 'sha256'), 'hex')
)
ON CONFLICT(key, version) DO NOTHING;
