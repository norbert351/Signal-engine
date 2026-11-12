import { claimQueuedBacktests, finishBacktest, loadBacktestCandles } from "@signal-engine/database/backtest-repository";
import { errorText } from "./format.js";

const EXPIRY_BARS: Record<string, number> = { "1m": 15, "5m": 6, "15m": 12, "1h": 12, "4h": 12, "1d": 6 };
const TRADING_STYLE: Record<string, string> = { "1m": "scalping", "5m": "scalping", "15m": "intraday", "1h": "intraday", "4h": "swing", "1d": "swing" };
const REQUIRED_COST_FIELDS = ["fee_bps_per_side", "spread_bps", "slippage_bps", "funding_bps_per_8h"] as const;

function validateExplicitCosts(assumptions: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of REQUIRED_COST_FIELDS) {
    const value = assumptions[key];
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(num) || num < 0) throw new Error(`Missing or invalid explicit cost assumption: ${key}`);
    out[key] = num;
  }
  return out;
}

function classifyFailure(error: unknown): { message: string; classification: string; transient: boolean } {
  const message = errorText(error, "Backtest failed");
  const lower = message.toLowerCase();
  const transient = ["timeout", "aborted", "econnrefused", "econnreset", "headers timeout", "fetch failed", "socket hang up", "network", "503", "502", "429"].some((p) => lower.includes(p));
  let classification = "invalid_request_or_data";
  if (transient) classification = "transient_infrastructure";
  else if (lower.includes("insufficient historical candles") || lower.includes("unable to load") || lower.includes("no bar") || lower.includes("ohlc") || lower.includes("not enough bars") || lower.includes("invalid")) classification = "data_or_validation";
  else if (lower.includes("research service http 5")) classification = "research_service_error";
  return { message, classification, transient };
}

async function postBacktest(base: string, body: unknown): Promise<{ metrics?: Record<string, unknown>; assumptions?: Record<string, unknown>; detail?: string }> {
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
        if (response.status >= 500 && attempt < 2) { lastError = err; await new Promise((r) => setTimeout(r, 1000)); continue; }
        throw err;
      }
      return result;
    } catch (error) {
      lastError = error;
      const { transient } = classifyFailure(error);
      if (!transient || attempt >= 2) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastError ?? new Error("Backtest request failed");
}

export async function processBacktests() {
  const jobs = await claimQueuedBacktests(3);
  let completed = 0;
  let failed = 0;
  const base = process.env.RESEARCH_SERVICE_URL ?? "http://localhost:8000";

  for (const job of jobs) {
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
      const result = await postBacktest(base, body);
      const effectiveAssumptions = result.assumptions ?? { ...costs, explicit: true, version: "legacy-unspecified" };
      await finishBacktest(job.id, { ...(result.metrics ?? {}), assumptions: effectiveAssumptions, progress: { stage: "completed", attempts: 1 } }, "completed", effectiveAssumptions);
      completed += 1;
    } catch (error) {
      const classified = classifyFailure(error);
      const jobAssumptions = (job.assumptions ?? {}) as Record<string, unknown>;
      const legacy = Object.keys(jobAssumptions).length === 0;
      await finishBacktest(
        job.id,
        {
          error: classified.message,
          failureClassification: classified.classification,
          transient: classified.transient,
          failedAt: new Date().toISOString(),
          legacyCostDataUnverified: legacy,
          progress: { stage: "failed" }
        },
        "failed",
        legacy ? { legacyCostDataUnverified: true } : jobAssumptions
      );
      failed += 1;
    }
  }
  return { claimed: jobs.length, completed, failed };
}
