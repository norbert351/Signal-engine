ALTER TABLE strategy_configs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE strategy_configs ADD COLUMN IF NOT EXISTS parameter_hash varchar(64);
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS parameters jsonb;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS signal_open_conflict_idx ON signal_records(symbol, timeframe, status, published_at DESC);
CREATE INDEX IF NOT EXISTS signal_status_timeframe_idx ON signal_records(status, timeframe, symbol);
CREATE INDEX IF NOT EXISTS system_alert_component_idx ON system_alerts(component, resolved_at);
CREATE INDEX IF NOT EXISTS notification_delivery_status_idx ON notification_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS candle_gap_idx ON market_candles(instrument_id, timeframe, is_complete, open_time);
CREATE INDEX IF NOT EXISTS backtest_status_idx ON backtest_runs(status, created_at);
CREATE INDEX IF NOT EXISTS paper_trade_signal_status_idx ON paper_trade_records(signal_id, status);

UPDATE strategy_configs
SET parameter_hash = encode(digest(parameters::text, 'sha256'), 'hex')
WHERE parameter_hash IS NULL;
