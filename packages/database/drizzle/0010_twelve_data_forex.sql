-- Forex and gold now use Twelve Data as the market-data provider.
-- OANDA is removed from the active Forex ingestion path: existing OANDA
-- instruments are disabled (not deleted) so historical rows keep provenance.
UPDATE instruments SET enabled = false, updated_at = now() WHERE provider = 'oanda_v20';

INSERT INTO instruments(provider, market, symbol, base_asset, quote_asset, enabled, price_precision, quantity_precision) VALUES
('twelve_data','forex','EUR_USD','EUR','USD',true,5,0),
('twelve_data','forex','GBP_USD','GBP','USD',true,5,0),
('twelve_data','forex','USD_JPY','USD','JPY',true,3,0),
('twelve_data','forex','EUR_JPY','EUR','JPY',true,3,0),
('twelve_data','forex','XAU_USD','XAU','USD',true,2,0)
ON CONFLICT(provider,symbol) DO UPDATE SET
  market = excluded.market,
  base_asset = excluded.base_asset,
  quote_asset = excluded.quote_asset,
  enabled = true,
  price_precision = excluded.price_precision,
  quantity_precision = excluded.quantity_precision,
  updated_at = now();

UPDATE instruments SET enabled = false, updated_at = now() WHERE provider NOT IN ('binance_usdm','twelve_data');
