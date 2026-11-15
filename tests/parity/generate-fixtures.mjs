import fs from 'fs';
import path from 'path';
import { evaluateStrategy } from '../../packages/core/dist/index.js';

const dir = path.resolve('tests/parity/fixtures');
const files = fs.readdirSync(dir).filter((file) => file.endsWith('-long-valid.json')).sort();
const write = (name, value) => {
  const target = path.join(dir, `${name}.json`);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};

function mirrorBars(bars) {
  const all = bars.flatMap((bar) => [bar.o, bar.h, bar.l, bar.c]);
  const axis = Math.max(...all) + Math.min(...all);
  return bars.map((bar) => ({
    ...bar,
    o: Number((axis - bar.o).toFixed(8)),
    h: Number((axis - bar.l).toFixed(8)),
    l: Number((axis - bar.h).toFixed(8)),
    c: Number((axis - bar.c).toFixed(8)),
  }));
}

function interval(fixture) {
  const bars = fixture.entryBars;
  return bars[bars.length - 1].t - bars[bars.length - 2].t;
}

function scalePrices(bars, factor) {
  return bars.map((bar) => ({
    ...bar,
    o: Number((bar.o * factor).toFixed(8)),
    h: Number((bar.h * factor).toFixed(8)),
    l: Number((bar.l * factor).toFixed(8)),
    c: Number((bar.c * factor).toFixed(8)),
  }));
}

function jitterPrices(bars, factor, amplitude) {
  const last = bars.slice(-2).map((bar) => ({ ...bar }));
  const jittered = bars.slice(0, -2).map((bar, index) => {
    const j = 1 + Math.sin((index + 1) * 1.37) * amplitude;
    const o = bar.o * factor * j;
    const c = bar.c * factor * j;
    return {
      ...bar,
      o: Number(o.toFixed(8)),
      c: Number(c.toFixed(8)),
      h: Number(Math.max(bar.h * factor * j, o, c).toFixed(8)),
      l: Number(Math.min(bar.l * factor * j, o, c).toFixed(8))
    };
  });
  return [...jittered, ...last.map((bar) => ({ ...bar, o: Number((bar.o * factor).toFixed(8)), h: Number((bar.h * factor).toFixed(8)), l: Number((bar.l * factor).toFixed(8)), c: Number((bar.c * factor).toFixed(8)) }))];
}

function transformFixture(fixture, label, transform, extra = {}) {
  return {
    ...fixture,
    name: `${fixture.name.replace(/-valid$/, `-${label}`)}`,
    entryBars: transform(fixture.entryBars),
    trendBars: transform(fixture.trendBars),
    category: 'positive',
    ...extra
  };
}

const altParams = {
  'ema-pullback': { atrPeriod: 10, stopAtrMultiple: 1.2, target2Multiple: 2.5 },
  'breakout-retest': { rangeLookback: 15, retestToleranceAtr: 0.3, atrPeriod: 10 },
  'sr-rejection': { swingLeft: 1, swingRight: 1, srLookback: 90, srToleranceAtr: 0.6 },
  'reversal': { rsiPeriod: 10, macdFast: 8, macdSlow: 21, macdSignal: 5, atrPeriod: 10 },
  'vol-expansion': { volumeLookback: 14, bollingerPeriod: 15, volatilityExpansion: 1.4 },
  'ms-continuation': { structureLookback: 30, atrPeriod: 10, stopAtrMultiple: 1.2 }
};

const borderline = {
  'ema-pullback': (fixture, index) => {
    const bar = fixture.entryBars[index];
    bar.c = Number((bar.o - 0.4).toFixed(8));
    bar.l = Number((Math.min(bar.l, bar.o, bar.c) - 0.1).toFixed(8));
  },
  'breakout-retest': (fixture, index) => {
    const bar = fixture.entryBars[index];
    bar.c = bar.o;
    bar.h = Math.max(bar.h, bar.o, bar.l, bar.c);
    bar.l = Math.min(bar.l, bar.o, bar.h, bar.c);
  },
  'sr-rejection': (fixture, index) => {
    const bar = fixture.entryBars[index];
    bar.c = bar.o;
    bar.h = Math.max(bar.h, bar.o, bar.l, bar.c);
    bar.l = Math.min(bar.l, bar.o, bar.h, bar.c);
  },
  'reversal': (fixture) => {
    for (let index = 50; index < fixture.trendBars.length; index += 1) {
      const price = 130 + (index - 50) * 1.5;
      Object.assign(fixture.trendBars[index], { o: price, c: price + 1, h: price + 1.4, l: price - 0.4 });
    }
  },
  'vol-expansion': (fixture, index) => {
    fixture.entryBars[index].v = 11;
  }
};

function toCandles(bars) {
  return bars.map((bar) => ({
    openTime: bar.t,
    closeTime: bar.ct,
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v ?? 0,
    complete: bar.complete !== false
  }));
}

function lastSignalIndex(fixture) {
  let found = -1;
  for (let index = 0; index < fixture.entryBars.length; index += 1) {
    const entryCandles = toCandles(fixture.entryBars.slice(0, index + 1));
    const last = entryCandles.at(-1);
    const trendCandles = toCandles(fixture.trendBars).filter((candle) => candle.closeTime <= last.closeTime);
    if (evaluateStrategy(fixture.strategyKey, { symbol: fixture.symbol, timeframe: fixture.timeframe, entryCandles, trendCandles }, fixture.params ?? {})) found = index;
  }
  return found;
}

for (const file of files) {
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const base = file.replace(/\.json$/, '');
  const prefix = base.replace(/-long-valid$/, '');
  const mirroredEntry = mirrorBars(fixture.entryBars);
  const mirroredTrend = mirrorBars(fixture.trendBars);

  write(`${prefix}-short-valid`, {
    ...fixture,
    name: `${prefix}-short-valid`,
    entryBars: mirroredEntry,
    trendBars: mirroredTrend,
    category: 'positive'
  });

  const positiveBases = [
    { suffix: 'long', entryBars: fixture.entryBars, trendBars: fixture.trendBars },
    { suffix: 'short', entryBars: mirroredEntry, trendBars: mirroredTrend }
  ];
  for (const positiveBase of positiveBases) {
    const shortFixture = {
      ...fixture,
      name: `${prefix}-${positiveBase.suffix}-valid`,
      entryBars: positiveBase.entryBars,
      trendBars: positiveBase.trendBars,
      category: 'positive'
    };
    write(`${prefix}-${positiveBase.suffix}-variant-scale`, transformFixture(shortFixture, 'variant-scale', (bars) => scalePrices(bars, 1.07)));
    write(`${prefix}-${positiveBase.suffix}-variant-jitter`, transformFixture(shortFixture, 'variant-jitter', (bars) => jitterPrices(bars, 0.97, 0.0008)));
    const params = altParams[prefix];
    if (params) {
      write(`${prefix}-${positiveBase.suffix}-variant-params`, {
        ...shortFixture,
        name: `${prefix}-${positiveBase.suffix}-variant-params`,
        params: { ...(fixture.params ?? {}), ...params },
        category: 'positive'
      });
    }
  }

  write(`${prefix}-conflicting-htf`, {
    ...fixture,
    name: `${prefix}-conflicting-htf`,
    trendBars: mirroredTrend,
    category: 'edge'
  });

  const last = fixture.entryBars[fixture.entryBars.length - 1];
  const step = interval(fixture);
  const incomplete = {
    ...last,
    t: last.t + step,
    ct: last.ct + step,
    o: last.c,
    c: last.c,
    h: last.c,
    l: last.c,
    complete: false
  };
  write(`${prefix}-incomplete-final`, {
    ...fixture,
    name: `${prefix}-incomplete-final`,
    entryBars: [...fixture.entryBars, incomplete],
    trendBars: [...fixture.trendBars, { ...fixture.trendBars.at(-1), t: fixture.trendBars.at(-1).t + step, ct: fixture.trendBars.at(-1).ct + step, complete: false }],
    category: 'edge'
  });

  write(`${prefix}-insufficient-htf`, {
    ...fixture,
    name: `${prefix}-insufficient-htf`,
    trendBars: fixture.trendBars.slice(0, 40),
    category: 'edge'
  });

  write(`${prefix}-tight-targets`, {
    ...fixture,
    name: `${prefix}-tight-targets`,
    params: { ...(fixture.params || {}), minRewardRisk: 3.2, target2Multiple: 3.5 },
    category: 'edge'
  });

  write(`${prefix}-invalid-params`, {
    ...fixture,
    name: `${prefix}-invalid-params`,
    params: { ...(fixture.params || {}), rangeLookback: 1 },
    category: 'edge'
  });

  if (borderline[prefix]) {
    const index = lastSignalIndex(fixture);
    if (index < 0) throw new Error(`No positive signal found for ${prefix}`);
    const longBorderline = {
      ...fixture,
      name: `${prefix}-long-borderline`,
      entryBars: fixture.entryBars.map((bar) => ({ ...bar })),
      trendBars: fixture.trendBars.map((bar) => ({ ...bar })),
      category: 'negative'
    };
    borderline[prefix](longBorderline, index);
    write(`${prefix}-long-borderline`, longBorderline);
    write(`${prefix}-short-borderline`, {
      ...longBorderline,
      name: `${prefix}-short-borderline`,
      entryBars: mirrorBars(longBorderline.entryBars),
      trendBars: mirrorBars(longBorderline.trendBars)
    });
  }
}

const volFile = path.join(dir, 'vol-expansion-long-valid.json');
if (fs.existsSync(volFile)) {
  const fixture = JSON.parse(fs.readFileSync(volFile, 'utf8'));
  write('vol-expansion-zero-volume', {
    ...fixture,
    name: 'vol-expansion-zero-volume',
    entryBars: fixture.entryBars.map((bar) => ({ ...bar, v: 0 })),
    trendBars: fixture.trendBars.map((bar) => ({ ...bar, v: 0 })),
    category: 'edge'
  });
}

for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
  const target = path.join(dir, file);
  const fixture = JSON.parse(fs.readFileSync(target, 'utf8'));
  const name = file.replace(/\.json$/, '');
  const category = /-(long|short)-(valid|variant-)/.test(name)
    ? 'positive'
    : /(no-setup|flat-invalid|low-volume-invalid|borderline)/.test(name)
      ? 'negative'
      : 'edge';
  fixture.category = category;
  fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
}
