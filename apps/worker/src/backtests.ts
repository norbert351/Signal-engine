import { claimQueuedBacktests, finishBacktest, loadBacktestCandles } from "@signal-engine/database/backtest-repository";

const EXPIRY_BARS: Record<string, number> = { "1m": 15, "5m": 6, "15m": 12, "1h": 12, "4h": 12, "1d": 6 };
const TRADING_STYLE: Record<string, string> = { "1m": "scalping", "5m": "scalping", "15m": "intraday", "1h": "intraday", "4h": "swing", "1d": "swing" };

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
      const assumptions = job.assumptions as Record<string, unknown>;
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

      const response = await fetch(`${base}/backtests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
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
          costs: assumptions
        }),
        signal: AbortSignal.timeout(120000)
      });
      const result = (await response.json()) as { metrics?: Record<string, unknown>; detail?: string };
      if (!response.ok || !result.metrics) throw new Error(result.detail ?? `Research service HTTP ${response.status}`);
      await finishBacktest(job.id, result.metrics, "completed");
      completed += 1;
    } catch (error) {
      await finishBacktest(job.id, { error: error instanceof Error ? error.message : "Backtest failed" }, "failed");
      failed += 1;
    }
  }
  return { claimed: jobs.length, completed, failed };
}
