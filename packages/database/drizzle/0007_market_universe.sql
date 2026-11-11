UPDATE instruments SET enabled=false, updated_at=now();

INSERT INTO instruments(provider,market,symbol,base_asset,quote_asset,enabled,price_precision,quantity_precision) VALUES
('binance_usdm','crypto_perpetual','BTCUSDT','BTC','USDT',true,2,3),
('binance_usdm','crypto_perpetual','ETHUSDT','ETH','USDT',true,2,3),
('binance_usdm','crypto_perpetual','BNBUSDT','BNB','USDT',true,2,3),
('binance_usdm','crypto_perpetual','SOLUSDT','SOL','USDT',true,4,1),
('binance_usdm','crypto_perpetual','XRPUSDT','XRP','USDT',true,4,1),
('binance_usdm','crypto_perpetual','DOGEUSDT','DOGE','USDT',true,5,0),
('binance_usdm','crypto_perpetual','ADAUSDT','ADA','USDT',true,4,0),
('binance_usdm','crypto_perpetual','LINKUSDT','LINK','USDT',true,3,2),
('binance_usdm','crypto_perpetual','AVAXUSDT','AVAX','USDT',true,3,1),
('binance_usdm','crypto_perpetual','LTCUSDT','LTC','USDT',true,2,2),
('binance_usdm','crypto_perpetual','DOTUSDT','DOT','USDT',true,3,1),
('binance_usdm','crypto_perpetual','TRXUSDT','TRX','USDT',true,5,0),
('binance_usdm','crypto_perpetual','TONUSDT','TON','USDT',true,3,1),
('binance_usdm','crypto_perpetual','SUIUSDT','SUI','USDT',true,4,1),
('binance_usdm','crypto_perpetual','NEARUSDT','NEAR','USDT',true,3,1),
('binance_usdm','crypto_perpetual','APTUSDT','APT','USDT',true,3,1),
('binance_usdm','crypto_perpetual','ARBUSDT','ARB','USDT',true,4,1),
('binance_usdm','crypto_perpetual','OPUSDT','OP','USDT',true,4,1),
('binance_usdm','crypto_perpetual','UNIUSDT','UNI','USDT',true,3,1),
('binance_usdm','crypto_perpetual','BCHUSDT','BCH','USDT',true,2,3),
('oanda_v20','forex','EUR_USD','EUR','USD',true,5,0),
('oanda_v20','forex','GBP_USD','GBP','USD',true,5,0),
('oanda_v20','forex','USD_JPY','USD','JPY',true,3,0),
('oanda_v20','forex','EUR_JPY','EUR','JPY',true,3,0),
('oanda_v20','forex','XAU_USD','XAU','USD',true,2,0)
ON CONFLICT(provider,symbol) DO UPDATE SET
  market=excluded.market,
  base_asset=excluded.base_asset,
  quote_asset=excluded.quote_asset,
  enabled=true,
  price_precision=excluded.price_precision,
  quantity_precision=excluded.quantity_precision,
  updated_at=now();

INSERT INTO strategy_configs(key,version,name,description,enabled,approved,parameters,risk_config) VALUES
('ema-trend-pullback',1,'EMA Trend Pullback','Completed-candle EMA pullback with higher timeframe EMA trend confirmation.',false,false,'{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3}'::jsonb,'{"minimumRewardRisk":2,"maximumStopDistancePct":5,"maxTargets":2}'::jsonb),
('range-breakout-retest',1,'Range Breakout Retest','Range breakout followed by a confirmed retest on a completed candle.',false,false,'{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3,"rangeLookback":20,"retestToleranceAtr":0.25}'::jsonb,'{"minimumRewardRisk":2,"maximumStopDistancePct":5,"maxTargets":2}'::jsonb),
('support-resistance-rejection',1,'Support Resistance Rejection','Confirmed swing support or resistance rejection with trend alignment.',false,false,'{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3,"srLookback":120,"srTolerancePct":0.005,"srToleranceAtr":0.5}'::jsonb,'{"minimumRewardRisk":2,"maximumStopDistancePct":5,"maxTargets":2}'::jsonb),
('market-structure-continuation',1,'Market Structure Continuation','Break of structure with higher timeframe and entry structure alignment.',false,false,'{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3,"structureLookback":40}'::jsonb,'{"minimumRewardRisk":2,"maximumStopDistancePct":5,"maxTargets":2}'::jsonb),
('trend-reversal-momentum',1,'Trend Reversal Momentum','Change of character with momentum confirmation and higher timeframe exhaustion.',false,false,'{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3,"rsiPeriod":14}'::jsonb,'{"minimumRewardRisk":2,"maximumStopDistancePct":5,"maxTargets":2}'::jsonb),
('volatility-expansion-breakout',1,'Volatility Expansion Breakout','ATR and Bollinger expansion breakout with relative volume confirmation.',false,false,'{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3,"volatilityExpansion":1.5,"minRelativeVolume":1.2,"bollingerPeriod":20,"bollingerMultiplier":2}'::jsonb,'{"minimumRewardRisk":2,"maximumStopDistancePct":5,"maxTargets":2}'::jsonb)
ON CONFLICT(key,version) DO NOTHING;

UPDATE instruments SET enabled=false, updated_at=now() WHERE provider NOT IN ('binance_usdm','oanda_v20');
