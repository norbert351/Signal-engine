CREATE TABLE IF NOT EXISTS schema_migrations (name varchar(160) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE instruments ADD COLUMN IF NOT EXISTS price_precision integer NOT NULL DEFAULT 2;
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS quantity_precision integer NOT NULL DEFAULT 0;
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true;
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS verified_at timestamptz;

ALTER TABLE signal_records ADD COLUMN IF NOT EXISTS trading_style varchar(16);
ALTER TABLE signal_records ADD COLUMN IF NOT EXISTS confirmation_timeframe varchar(8);
ALTER TABLE signal_records ADD COLUMN IF NOT EXISTS strategy_key varchar(64);
ALTER TABLE signal_records ADD COLUMN IF NOT EXISTS strategy_version integer;
ALTER TABLE signal_records ADD COLUMN IF NOT EXISTS quality_score numeric(6,2);
ALTER TABLE signal_records ADD COLUMN IF NOT EXISTS quality_factors jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE signal_records ADD COLUMN IF NOT EXISTS score_formula_version varchar(32);
ALTER TABLE signal_records ADD COLUMN IF NOT EXISTS invalidation_conditions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE signal_records ALTER COLUMN status SET DEFAULT 'PENDING';

ALTER TABLE signal_events ADD COLUMN IF NOT EXISTS event_key varchar(220);
CREATE UNIQUE INDEX IF NOT EXISTS signal_event_key_uq ON signal_events(event_key);

ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_signal_channel_destination_uq;
ALTER TABLE notification_deliveries ALTER COLUMN signal_id DROP NOT NULL;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS event_type varchar(32) NOT NULL DEFAULT 'signal';
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS event_key varchar(240);
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS message text;
CREATE UNIQUE INDEX IF NOT EXISTS notification_event_key_uq ON notification_deliveries(event_key);

ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS processed_through timestamptz;
ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS cost_bps numeric(10,4) NOT NULL DEFAULT 0;
ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS funding_bps_per_8h numeric(10,4) NOT NULL DEFAULT 0;
ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS closed_reason varchar(24);
ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS initial_stop numeric(28,12);
ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS initial_targets jsonb;

CREATE TABLE IF NOT EXISTS backfill_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(32) NOT NULL,
  symbol varchar(32) NOT NULL,
  timeframe varchar(8) NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  cursor_time timestamptz NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  candles_seen bigint NOT NULL DEFAULT 0,
  candles_written bigint NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backfill_progress_uq UNIQUE(provider,symbol,timeframe,start_time,end_time)
);
CREATE INDEX IF NOT EXISTS backfill_progress_status_idx ON backfill_progress(status, updated_at);

CREATE TABLE IF NOT EXISTS system_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component varchar(64) NOT NULL,
  severity varchar(16) NOT NULL DEFAULT 'warning',
  dedupe_key varchar(180) NOT NULL UNIQUE,
  message text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS candle_close_lookup_idx ON market_candles(instrument_id, timeframe, close_time DESC);
CREATE INDEX IF NOT EXISTS signal_instrument_published_idx ON signal_records(instrument_id, published_at DESC);
CREATE INDEX IF NOT EXISTS signal_strategy_idx ON signal_records(strategy_key, strategy_version, published_at DESC);
CREATE INDEX IF NOT EXISTS signal_dedupe_lookup_idx ON signal_records(dedupe_key);

UPDATE signal_records SET status='PENDING' WHERE status='published';
UPDATE signal_records SET status='ACTIVE' WHERE status='active';
UPDATE signal_records SET status='STOP_LOSS_HIT' WHERE status='stopped';
UPDATE signal_records SET status='TARGET_2_HIT' WHERE status='target_hit';
UPDATE signal_records SET status='EXPIRED' WHERE status='expired';
UPDATE paper_trade_records SET status='OPEN' WHERE status='open';
UPDATE paper_trade_records SET status='CLOSED' WHERE status='closed';
