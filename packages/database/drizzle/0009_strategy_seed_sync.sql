UPDATE strategy_configs SET
  name = 'EMA Trend Pullback',
  description = 'Completed-candle EMA pullback with higher timeframe EMA trend confirmation.',
  parameters = '{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3}'::jsonb,
  risk_config = '{"minimumRewardRisk":2,"maximumStopDistancePct":5,"maxTargets":2}'::jsonb,
  parameter_hash = encode(digest('{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3}', 'sha256'), 'hex'),
  updated_at = now()
WHERE key = 'ema-trend-pullback' AND version = 1 AND approved = false AND enabled = false;

UPDATE strategy_configs SET
  name = 'Range Breakout Retest',
  description = 'Range breakout followed by a confirmed retest on a completed candle.',
  parameters = '{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3,"rangeLookback":20,"retestToleranceAtr":0.25}'::jsonb,
  risk_config = '{"minimumRewardRisk":2,"maximumStopDistancePct":5,"maxTargets":2}'::jsonb,
  parameter_hash = encode(digest('{"emaFast":20,"emaSlow":50,"atrPeriod":14,"stopAtrMultiple":1.5,"minRewardRisk":2,"target2Multiple":3,"rangeLookback":20,"retestToleranceAtr":0.25}', 'sha256'), 'hex'),
  updated_at = now()
WHERE key = 'range-breakout-retest' AND version = 1 AND approved = false AND enabled = false;
