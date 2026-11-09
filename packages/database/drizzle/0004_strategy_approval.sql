ALTER TABLE strategy_configs ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT false;
ALTER TABLE strategy_configs ADD COLUMN IF NOT EXISTS approval_note text;
UPDATE strategy_configs SET enabled=false,approved=false WHERE approved IS NULL;
