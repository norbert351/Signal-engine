import fs from 'fs';

const tolerance = Number(process.env.PARITY_TOLERANCE ?? '1e-8');
const tsPath = process.argv[2] ?? '/tmp/parity-ts.json';
const pyPath = process.argv[3] ?? '/tmp/parity-py.json';
const matrixPath = process.env.PARITY_MATRIX ?? 'docs/parity-matrix.json';

const comparedFields = [
  'fixture identity and category',
  'evaluation count',
  'signal presence and index',
  'strategyKey',
  'strategyVersion',
  'triggerCloseTime',
  'timeframe',
  'direction',
  'entry',
  'stop',
  'targets',
  'rr',
  'score',
  'scoreFactors',
  'rationale',
  'invalidation',
  'evidence'
];
const scoreFactorKeys = [
  'trendAlignment',
  'marketStructure',
  'momentum',
  'volumeConfirmation',
  'supportResistance',
  'volatilitySuitability',
  'riskReward',
  'entryQuality'
];
const requiredFields = [
  'strategyKey',
  'strategyVersion',
  'triggerCloseTime',
  'timeframe',
  'direction',
  'entry',
  'stop',
  'targets',
  'rr',
  'score',
  'scoreFactors',
  'rationale',
  'invalidation',
  'evidence'
];
const knownIntentionalDifferences = [
  'Exception message wording for rejected parameters is not compared; both implementations rejecting the same evaluation is treated as a match.',
  'Rationale and invalidation text is compared exactly for emitted signals.'
];
const remainingLimitations = [
  'Fixtures are deterministic synthetic market sequences, not independent market samples.',
  'Parity proves implementation agreement, not profitability, statistical significance, or data sufficiency.',
  'Only 1h fixtures are exercised by this harness.',
  'The Python runner executes the source tree; its fixture and strategy revision must match the TypeScript build.'
];

function number(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function equalNumber(a, b) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= tolerance;
}

function compareValue(a, b, field, diffs) {
  if (typeof a === 'number' || typeof b === 'number') {
    if (!equalNumber(number(a), number(b))) diffs.push({ field, ts: a, py: b });
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      diffs.push({ field, ts: a, py: b });
      return;
    }
    a.forEach((value, index) => compareValue(value, b[index], `${field}[${index}]`, diffs));
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) compareValue(a[key], b[key], `${field}.${key}`, diffs);
    return;
  }
  if (a !== b) diffs.push({ field, ts: a, py: b });
}

function missingFields(signal) {
  const missing = requiredFields.filter((field) => signal[field] === undefined);
  if (signal.scoreFactors) {
    for (const field of scoreFactorKeys) {
      if (!Number.isFinite(Number(signal.scoreFactors[field]))) missing.push(`scoreFactors.${field}`);
    }
  }
  return missing;
}

function compareSignal(ts, py) {
  const diffs = [];
  compareValue(ts.strategyKey, py.strategyKey, 'strategyKey', diffs);
  compareValue(ts.strategyVersion, py.strategyVersion, 'strategyVersion', diffs);
  compareValue(ts.triggerCloseTime, py.triggerCloseTime, 'triggerCloseTime', diffs);
  compareValue(ts.timeframe, py.timeframe, 'timeframe', diffs);
  compareValue(ts.direction, py.direction, 'direction', diffs);
  compareValue(ts.entry, py.entry, 'entry', diffs);
  compareValue(ts.stop, py.stop, 'stop', diffs);
  compareValue(ts.targets, py.targets, 'targets', diffs);
  compareValue(ts.rr, py.rr, 'rr', diffs);
  compareValue(ts.score, py.score, 'score', diffs);
  compareValue(ts.scoreFactors, py.scoreFactors, 'scoreFactors', diffs);
  compareValue(ts.rationale, py.rationale, 'rationale', diffs);
  compareValue(ts.invalidation, py.invalidation, 'invalidation', diffs);
  compareValue(ts.evidence, py.evidence, 'evidence', diffs);
  return diffs;
}

function fixtureSignals(fixture) {
  return (fixture.results || []).filter((item) => !item.error);
}

const ts = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
const py = JSON.parse(fs.readFileSync(pyPath, 'utf8'));
const report = {
  version: 3,
  tolerance,
  comparedFields,
  knownIntentionalDifferences,
  remainingLimitations,
  strategies: {},
  summary: {}
};
const allStrategies = [...new Set([...Object.keys(ts.strategies), ...Object.keys(py.strategies)])].sort();

for (const strategy of allStrategies) {
  const tsFixtures = ts.strategies[strategy] || [];
  const pyFixtures = py.strategies[strategy] || [];
  const pyByFile = new Map(pyFixtures.map((fixture) => [fixture.file ?? fixture.fixture, fixture]));
  let comparisons = 0;
  let matches = 0;
  let material = 0;
  const notes = [];
  const fixtureDetails = [];

  const tsFiles = new Set(tsFixtures.map((fixture) => fixture.file ?? fixture.fixture));
  const pyFiles = new Set(pyFixtures.map((fixture) => fixture.file ?? fixture.fixture));
  for (const file of pyFiles) {
    if (!tsFiles.has(file)) {
      material += 1;
      notes.push({ file, issue: 'fixture_missing_in_ts' });
    }
  }

  for (const tsFixture of tsFixtures) {
    const file = tsFixture.file ?? tsFixture.fixture;
    const pyFixture = pyByFile.get(file);
    if (!pyFixture) {
      material += 1;
      notes.push({ fixture: tsFixture.fixture, file, issue: 'fixture_missing_in_py' });
      fixtureDetails.push({ fixture: tsFixture.fixture, file, category: tsFixture.category, evaluations: tsFixture.evaluations, signals: fixtureSignals(tsFixture).length });
      continue;
    }
    if ((tsFixture.evaluations ?? 0) !== (pyFixture.evaluations ?? 0)) {
      material += 1;
      notes.push({ fixture: tsFixture.fixture, file, issue: 'evaluation_count_mismatch', ts: tsFixture.evaluations, py: pyFixture.evaluations });
    }
    if (tsFixture.category !== pyFixture.category) {
      material += 1;
      notes.push({ fixture: tsFixture.fixture, file, issue: 'category_mismatch', ts: tsFixture.category, py: pyFixture.category });
    }
    const evaluations = Math.max(tsFixture.evaluations ?? 0, pyFixture.evaluations ?? 0);
    const tsByIndex = new Map((tsFixture.results || []).map((item) => [item.index, item]));
    const pyByIndex = new Map((pyFixture.results || []).map((item) => [item.index, item]));
    for (let index = 0; index < evaluations; index += 1) {
      comparisons += 1;
      const tsSignal = tsByIndex.get(index);
      const pySignal = pyByIndex.get(index);
      if (!tsSignal && !pySignal) {
        matches += 1;
        continue;
      }
      if (!tsSignal || !pySignal) {
        material += 1;
        notes.push({ fixture: tsFixture.fixture, file, index, issue: !tsSignal ? 'missing_in_ts' : 'missing_in_py', ts: tsSignal ?? null, py: pySignal ?? null });
        continue;
      }
      if (tsSignal.error || pySignal.error) {
        if (tsSignal.error && pySignal.error) {
          matches += 1;
          continue;
        }
        material += 1;
        notes.push({ fixture: tsFixture.fixture, file, index, issue: 'error', ts: tsSignal.error, py: pySignal.error });
        continue;
      }
      const tsMissing = missingFields(tsSignal);
      const pyMissing = missingFields(pySignal);
      if (tsMissing.length || pyMissing.length) {
        material += 1;
        notes.push({ fixture: tsFixture.fixture, file, index, issue: 'missing_required_fields', tsMissing, pyMissing });
        continue;
      }
      const diffs = compareSignal(tsSignal, pySignal);
      if (diffs.length === 0) matches += 1;
      else {
        material += 1;
        notes.push({ fixture: tsFixture.fixture, file, index, diffs });
      }
    }
    fixtureDetails.push({
      fixture: tsFixture.fixture,
      file,
      category: tsFixture.category,
      evaluations: tsFixture.evaluations,
      signals: fixtureSignals(tsFixture).length,
      errors: (tsFixture.results || []).filter((item) => item.error).length
    });
  }

  const positiveFixtures = tsFixtures.filter((fixture) => fixture.category === 'positive');
  const negativeFixtures = tsFixtures.filter((fixture) => fixture.category === 'negative');
  const edgeFixtures = tsFixtures.filter((fixture) => fixture.category === 'edge');
  const positiveSignals = positiveFixtures.flatMap(fixtureSignals);
  const negativeSignals = negativeFixtures.flatMap(fixtureSignals);
  const edgeSignals = edgeFixtures.flatMap(fixtureSignals);
  const positiveErrors = positiveFixtures.flatMap((fixture) => (fixture.results || []).filter((item) => item.error));
  const directions = [...new Set(positiveSignals.map((signal) => signal.direction))].sort();
  const coverageIssues = [];
  if (positiveFixtures.length < 2) coverageIssues.push('fewer than two positive fixtures');
  if (positiveSignals.length < 4) coverageIssues.push('fewer than four positive signals');
  if (!directions.includes('LONG') || !directions.includes('SHORT')) coverageIssues.push('missing LONG or SHORT positive direction coverage');
  if (negativeSignals.length > 0) coverageIssues.push('negative fixture produced a signal');
  if (positiveErrors.length > 0) coverageIssues.push('positive fixture raised an error');

  let status = 'PARITY_OK';
  if (material > 0) status = 'BLOCKED';
  else if (coverageIssues.length > 0) status = 'INSUFFICIENT_COVERAGE';

  report.strategies[strategy] = {
    status,
    tolerance,
    comparedFields,
    knownIntentionalDifferences,
    remainingLimitations,
    coverage: {
      fixtures: tsFixtures.length,
      positiveFixtures: positiveFixtures.length,
      negativeFixtures: negativeFixtures.length,
      edgeFixtures: edgeFixtures.length,
      positiveSignals: positiveSignals.length,
      negativeSignals: negativeSignals.length,
      edgeSignals: edgeSignals.length,
      positiveDirections: directions,
      issues: coverageIssues
    },
    evaluations: tsFixtures.reduce((sum, fixture) => sum + (fixture.evaluations ?? 0), 0),
    comparisons,
    signals: positiveSignals.length + negativeSignals.length + edgeSignals.length,
    matches,
    materialDifferences: material,
    notes: notes.slice(0, 50),
    fixtures: fixtureDetails
  };
}

const strategyEntries = Object.entries(report.strategies);
report.summary = {
  totalStrategies: strategyEntries.length,
  parity: strategyEntries.filter(([, item]) => item.status === 'PARITY_OK').length,
  blocked: strategyEntries.filter(([, item]) => item.status === 'BLOCKED').length,
  insufficientCoverage: strategyEntries.filter(([, item]) => item.status === 'INSUFFICIENT_COVERAGE').length,
  materialDifferences: strategyEntries.reduce((sum, [, item]) => sum + item.materialDifferences, 0),
  fixtures: strategyEntries.reduce((sum, [, item]) => sum + item.coverage.fixtures, 0),
  positiveFixtures: strategyEntries.reduce((sum, [, item]) => sum + item.coverage.positiveFixtures, 0),
  negativeFixtures: strategyEntries.reduce((sum, [, item]) => sum + item.coverage.negativeFixtures, 0),
  edgeFixtures: strategyEntries.reduce((sum, [, item]) => sum + item.coverage.edgeFixtures, 0),
  positiveSignals: strategyEntries.reduce((sum, [, item]) => sum + item.coverage.positiveSignals, 0),
  negativeSignals: strategyEntries.reduce((sum, [, item]) => sum + item.coverage.negativeSignals, 0),
  overallStatus: strategyEntries.every(([, item]) => item.status === 'PARITY_OK') ? 'PARITY_OK' : 'BLOCKED'
};
fs.writeFileSync(matrixPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
for (const [strategy, item] of strategyEntries) {
  console.log(strategy, item.status, `material=${item.materialDifferences}`, `fixtures=${item.coverage.fixtures}`, `positive=${item.coverage.positiveSignals}`, `negative=${item.coverage.negativeSignals}`, `comparisons=${item.comparisons}`);
}
