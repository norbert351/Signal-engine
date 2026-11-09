ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS target_index integer NOT NULL DEFAULT 0;
ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS remaining_pct numeric(8,4) NOT NULL DEFAULT 100;
ALTER TABLE paper_trade_records ADD COLUMN IF NOT EXISTS realized_return numeric(16,8) NOT NULL DEFAULT 0;
