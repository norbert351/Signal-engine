import { claimQueuedBacktests, finishBacktest, loadBacktestCandles, updateBacktestProgress } from "@signal-engine/database/backtest-repository";
import { errorText } from "./format.js";

const EXPIRY_BARS: Record<string, number> = { "1m": 15, "5m": 6, "15m": 12, "1h": 12, "4h": 12, "1d": 6 };
const TRADING_STYLE: Record<string, string> = { "1m": "scalping", "5m": "scalping", "15m": "intraday", "1h": "intraday", "4h": "swing", "1d": "swing" };
const REQUIRED_COST_FIELDS = ["fee_bps_per_side", "spread_bps", "slippage_bps", "funding_bps_per_8h"] as const;
const COST_MODEL_VERSION = "costs-v1";

type BacktestServiceResult = {
  metrics?: Record<string, unknown>;
  assumptions?: Record<string, unknown>;
  detail?: string;
  attempts: number;
};
type RetryHandler = (attempt: number, error: unknown) => Promise<void> | void;

function markAttempts(error: unknown, attempts: number): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  const current = (wrapped as Error & { attempts?: number }).attempts;
  if (!Number.isInteger(current) || current! < attempts) (wrapped as Error & { attempts?: number }).attempts = attempts;
  return wrapped;
}

function retryNotice(handler: RetryHandler | undefined, attempt: number, error: unknown) {
  return Promise.resolve(handler?.(attempt, error)).catch(() => undefined);
}

export function failureAttempts(error: unknown): number {
  const value = (error as { attempts?: unknown } | null)?.attempts;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

export function validateExplicitCosts(assumptions: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of REQUIRED_COST_FIELDS) {
    const value = assumptions[key];
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(num) || num < 0) throw new Error(`Missing or invalid explicit cost assumption: ${key}`);
    out[key] = num;
  }
  return out;
}

export function validateEffectiveAssumptions(
  result: Pick<BacktestServiceResult, "assumptions">,
  costs: Record<string, number>
): Record<string, unknown> {
  if (!result.assumptions) return { ...costs, explicit: true, version: COST_MODEL_VERSION };
  const returned = validateExplicitCosts(result.assumptions);
  for (const key of REQUIRED_COST_FIELDS) {
    if (returned[key] !== costs[key]) throw new Error(`Research service changed cost assumption: ${key}`);
  }
  if (result.assumptions.version !== COST_MODEL_VERSION || result.assumptions.explicit !== true) {
    throw new Error("Research service did not return verified explicit cost assumptions");
  }
  return { ...result.assumptions, ...costs, explicit: true, version: COST_MODEL_VERSION };
}

export function classifyFailure(error: unknown): { message: string; classification: string; transient: boolean } {
  const message = errorText(error, "Backtest failed");
  const lower = message.toLowerCase();
  let classification = "invalid_request_or_data";
  let transient = false;
  if (/timeout|timed out|etimedout/.test(lower)) {
    classification = "timeout";
    transient = true;
  } else if (/out of memory|enomem|heap|resource temporarily unavailable|too many open files|no space left|disk quota/.test(lower)) {
    classification = "resource_error";
    transient = true;
  } else if (/database|postgres|deadlock|serialization failure|connection pool|sqlstate|relation .* does not exist/.test(lower)) {
    classification = "database_error";
  } else if (/research service http (5\d\d|429)|http (5\d\d|429)|bad gateway|service unavailable|gateway timeout/.test(lower)) {
    classification = "research_service_error";
    transient = true;
  } else if (/econnrefused|econnreset|econnaborted|other side closed|headers timeout|fetch failed|socket hang up|network|aborted|abort/.test(lower)) {
    classification = "transient_infrastructure";
    transient = true;
  } else if (/strategy|unsupported/.test(lower)) {
    classification = "strategy_error";
  } else if (/insufficient historical candles|unable to load|no bar|not enough bars|missing candle|empty dataset|no data/.test(lower)) {
    classification = "data_error";
  } else if (/ohlc|invalid|must be|malformed|duplicate candle|cost assumption/.test(lower)) {
    classification = "validation_error";
  }
  return { message, classification, transient };
}

export async function postBacktest(base: string, body: unknown, onRetry?: RetryHandler): Promise<BacktestServiceResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(`${base}/backtests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600000)
      });
      const result = (await response.json().catch(() => ({}))) as { metrics?: Record<string, unknown>; assumptions?: Record<string, unknown>; detail?: string };
      if (!response.ok || !result.metrics) {
        const err = new Error(result.detail ?? `Research service HTTP ${response.status}`);
        if (response.status >= 500 && attempt < 2) {
          lastError = err;
          await retryNotice(onRetry, attempt, err);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        throw err;
      }
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      const { transient } = classifyFailure(error);
      if (!transient || attempt >= 2) throw markAttempts(error, attempt);
      await retryNotice(onRetry, attempt, error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw markAttempts(lastError ?? new Error("Backtest request failed"), 2);
}

export async function processBacktests() {
  const jobs = await claimQueuedBacktests(3);
  let completed = 0;
  let failed = 0;
  let stale = 0;
  const base = process.env.RESEARCH_SERVICE_URL ?? "http://localhost:8000";

  for (const job of jobs) {
    const claimToken = job.startedAt ?? undefined;
    try {
      const dataset = job.dataset as {
        bars?: unknown[];
        trendBars?: unknown[];
        setups?: unknown[];
        strategyParams?: Record<string, unknown>;
        start?: string;
        end?: string;
        trendTimeframe?: string;
        symbol?: string;
        market?: string;
      };
      const rawAssumptions = job.assumptions as Record<string, unknown>;
      const costs = validateExplicitCosts(rawAssumptions);
      let bars = dataset.bars;
      let trendBars = dataset.trendBars;
      if (!Array.isArray(bars) || !Array.isArray(trendBars)) {
        if (!job.instrumentId || !dataset.start || !dataset.end || !dataset.trendTimeframe) {
          throw new Error("Backtest requires stored candle range metadata or explicit bars and trendBars");
        }
        const loaded = await loadBacktestCandles(
          job.instrumentId,
          job.timeframe,
          dataset.trendTimeframe,
          new Date(dataset.start),
          new Date(dataset.end)
        );
        bars = loaded.bars;
        trendBars = loaded.trendBars;
      }
      if (!Array.isArray(bars) || !Array.isArray(trendBars)) throw new Error("Unable to load backtest candles");
      if (bars.length < 100 || trendBars.length < 50) throw new Error("Insufficient historical candles for a meaningful backtest");

      const body = {
        strategy_key: job.strategyKey,
        strategy_params: dataset.strategyParams ?? {},
        symbol: dataset.symbol ?? job.strategyKey,
        timeframe: job.timeframe,
        trading_style: TRADING_STYLE[job.timeframe] ?? null,
        expiry_bars: EXPIRY_BARS[job.timeframe] ?? null,
        evaluation_start: dataset.start ? Date.parse(dataset.start) : undefined,
        evaluation_end: dataset.end ? Date.parse(dataset.end) : undefined,
        bars,
        trend_bars: trendBars,
        setups: dataset.setups ?? null,
        costs
      };
      const onRetry: RetryHandler = async (attempt, error) => {
        const classified = classifyFailure(error);
        await updateBacktestProgress(
          job.id,
          {
            stage: "retry",
            attempts: attempt + 1,
            lastAttempt: attempt,
            classification: classified.classification,
            retryScheduledAt: new Date().toISOString()
          },
          claimToken
        );
      };
      const result = await postBacktest(base, body, onRetry);
      const effectiveAssumptions = validateEffectiveAssumptions(result, costs);
      const finished = await finishBacktest(
        job.id,
        { ...(result.metrics ?? {}), assumptions: effectiveAssumptions, progress: { stage: "completed", attempts: result.attempts } },
        "completed",
        effectiveAssumptions,
        claimToken
      );
      if (finished) completed += 1;
      else stale += 1;
    } catch (error) {
      const classified = classifyFailure(error);
      const jobAssumptions = (job.assumptions ?? {}) as Record<string, unknown>;
      const legacy = Object.keys(jobAssumptions).length === 0;
      const finished = await finishBacktest(
        job.id,
        {
          error: classified.message,
          failureClassification: classified.classification,
          transient: classified.transient,
          failedAt: new Date().toISOString(),
          legacyCostDataUnverified: legacy,
          progress: { stage: "failed", attempts: failureAttempts(error) }
        },
        "failed",
        legacy ? { legacyCostDataUnverified: true } : jobAssumptions,
        claimToken
      );
      if (finished) failed += 1;
      else stale += 1;
    }
  }
  return { claimed: jobs.length, completed, failed, stale };
}
