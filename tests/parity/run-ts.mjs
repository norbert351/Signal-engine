import fs from 'fs';
import path from 'path';
import { evaluateStrategy, scoreOpportunity, validateCandles } from '../../packages/core/dist/index.js';

const fixturesDir = process.env.PARITY_FIXTURES || path.resolve('tests/parity/fixtures');
const files = fs.readdirSync(fixturesDir).filter((file) => file.endsWith('.json')).sort();
const categories = new Set(['positive', 'negative', 'edge']);

function toCandle(bar) {
  return {
    openTime: bar.t,
    closeTime: bar.ct,
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v ?? 0,
    complete: bar.complete !== false
  };
}

function validateFixture(fixture, file) {
  if (!fixture.strategyKey) throw new Error(`${file}: missing strategyKey`);
  if (!fixture.name) throw new Error(`${file}: missing name`);
  if (!categories.has(fixture.category)) throw new Error(`${file}: invalid category ${fixture.category}`);
  for (const key of ['entryBars', 'trendBars']) {
    const bars = fixture[key];
    if (!Array.isArray(bars) || bars.length === 0) throw new Error(`${file}: ${key} must be a non-empty array`);
    validateCandles(bars.map(toCandle));
    for (let index = 1; index < bars.length; index += 1) {
      if (bars[index].ct <= bars[index - 1].ct) throw new Error(`${file}: ${key} duplicate/unsorted closeTime at ${index}`);
    }
  }
}

const out = { version: 3, tolerance: Number(process.env.PARITY_TOLERANCE ?? '1e-8'), strategies: {} };
for (const file of files) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'));
  validateFixture(fixture, file);
  const { strategyKey, entryBars, trendBars, params, timeframe, symbol } = fixture;
  const results = [];
  for (let i = 0; i < entryBars.length; i++) {
    const entryCandles = entryBars.slice(0, i + 1).map(toCandle);
    const last = entryCandles[entryCandles.length - 1];
    const trendCandles = trendBars.map(toCandle).filter((candle) => candle.closeTime <= last.closeTime);
    let result;
    try {
      result = evaluateStrategy(strategyKey, { symbol: symbol || 'TEST', timeframe: timeframe || '1h', entryCandles, trendCandles }, params || {});
    } catch (error) {
      results.push({ index: i, error: String(error) });
      continue;
    }
    if (!result) continue;
    const { candidate, direction } = result;
    const risk = direction === 'LONG' ? candidate.entry - candidate.stopLoss : candidate.stopLoss - candidate.entry;
    const quality = scoreOpportunity(result.scoreFactors);
    results.push({
      index: i,
      strategyKey: result.strategyKey,
      strategyVersion: result.strategyVersion,
      triggerCloseTime: result.triggerCloseTime,
      timeframe: candidate.timeframe,
      direction,
      entry: candidate.entry,
      stop: candidate.stopLoss,
      targets: candidate.targets,
      rr: (direction === 'LONG' ? candidate.targets[0] - candidate.entry : candidate.entry - candidate.targets[0]) / risk,
      score: quality.score,
      scoreFactors: quality.breakdown,
      rationale: candidate.rationale,
      invalidation: candidate.invalidation,
      evidence: candidate.evidence
    });
  }
  out.strategies[strategyKey] = out.strategies[strategyKey] || [];
  out.strategies[strategyKey].push({
    fixture: fixture.name || file,
    file,
    category: fixture.category,
    params: params || {},
    evaluations: entryBars.length,
    results
  });
}
process.stdout.write(JSON.stringify(out));
