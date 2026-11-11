import { and, desc, eq } from "drizzle-orm";
import { db, sql } from "./index.js";
import { paperTrades, signals } from "./schema.js";

export async function listPaperTrades(filters: { status?: string | undefined; symbol?: string | undefined; limit: number; offset: number }) {
  const conditions = [];
  if (filters.status) conditions.push(eq(paperTrades.status, filters.status));
  if (filters.symbol) conditions.push(eq(signals.symbol, filters.symbol));
  return db
    .select({ trade: paperTrades, signal: signals })
    .from(paperTrades)
    .innerJoin(signals, eq(paperTrades.signalId, signals.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(paperTrades.entryTime))
    .limit(filters.limit)
    .offset(filters.offset);
}

export async function getPaperTrade(id: string) {
  const [row] = await db
    .select({ trade: paperTrades, signal: signals })
    .from(paperTrades)
    .innerJoin(signals, eq(paperTrades.signalId, signals.id))
    .where(eq(paperTrades.id, id))
    .limit(1);
  return row ?? null;
}

type SummaryRow = {
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  gross_win: string | null;
  gross_loss: string | null;
  total_return: string | null;
  max_return: string | null;
  min_return: string | null;
};

function groupSummary(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => ({
    key: row.key,
    total: Number(row.total),
    wins: Number(row.wins),
    losses: Number(row.losses),
    winRate: Number(row.closed) ? Number(row.wins) / Number(row.closed) : null,
    netReturn: row.total_return === null ? null : Number(row.total_return)
  }));
}

export async function paperTradeSummary() {
  const [overall] = await sql<SummaryRow[]>`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status <> 'CLOSED')::int AS open,
      count(*) FILTER (WHERE status = 'CLOSED')::int AS closed,
      count(*) FILTER (WHERE status = 'CLOSED' AND net_return > 0)::int AS wins,
      count(*) FILTER (WHERE status = 'CLOSED' AND net_return < 0)::int AS losses,
      sum(net_return) FILTER (WHERE status = 'CLOSED' AND net_return > 0)::text AS gross_win,
      abs(sum(net_return) FILTER (WHERE status = 'CLOSED' AND net_return < 0))::text AS gross_loss,
      sum(net_return) FILTER (WHERE status = 'CLOSED')::text AS total_return,
      max(net_return) FILTER (WHERE status = 'CLOSED')::text AS max_return,
      min(net_return) FILTER (WHERE status = 'CLOSED')::text AS min_return
    FROM paper_trade_records
  `;
  const returns = await sql<Array<{ net_return: string }>>`
    SELECT net_return FROM paper_trade_records WHERE status = 'CLOSED' ORDER BY exit_time ASC, created_at ASC
  `;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let consecutiveLosses = 0;
  let worstLossStreak = 0;
  for (const row of returns) {
    const value = Number(row.net_return ?? 0);
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    if (value < 0) {
      consecutiveLosses += 1;
      worstLossStreak = Math.max(worstLossStreak, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }
  const closed = Number(overall?.closed ?? 0);
  const wins = Number(overall?.wins ?? 0);
  const losses = Number(overall?.losses ?? 0);
  const grossWin = Number(overall?.gross_win ?? 0);
  const grossLoss = Number(overall?.gross_loss ?? 0);

  const byStrategy = groupSummary(
    await sql<Array<Record<string, unknown>>>`
      SELECT coalesce(s.strategy_key, 'unknown') AS key,
             count(*)::int AS total,
             count(*) FILTER (WHERE p.status = 'CLOSED' AND p.net_return > 0)::int AS wins,
             count(*) FILTER (WHERE p.status = 'CLOSED' AND p.net_return < 0)::int AS losses,
             count(*) FILTER (WHERE p.status = 'CLOSED')::int AS closed,
             sum(p.net_return) FILTER (WHERE p.status = 'CLOSED')::text AS total_return
      FROM paper_trade_records p JOIN signal_records s ON s.id = p.signal_id
      GROUP BY coalesce(s.strategy_key, 'unknown') ORDER BY key
    `
  );
  const byTimeframe = groupSummary(
    await sql<Array<Record<string, unknown>>>`
      SELECT s.timeframe AS key,
             count(*)::int AS total,
             count(*) FILTER (WHERE p.status = 'CLOSED' AND p.net_return > 0)::int AS wins,
             count(*) FILTER (WHERE p.status = 'CLOSED' AND p.net_return < 0)::int AS losses,
             count(*) FILTER (WHERE p.status = 'CLOSED')::int AS closed,
             sum(p.net_return) FILTER (WHERE p.status = 'CLOSED')::text AS total_return
      FROM paper_trade_records p JOIN signal_records s ON s.id = p.signal_id
      GROUP BY s.timeframe ORDER BY key
    `
  );
  const byTradingStyle = groupSummary(
    await sql<Array<Record<string, unknown>>>`
      SELECT coalesce(s.trading_style, 'unknown') AS key,
             count(*)::int AS total,
             count(*) FILTER (WHERE p.status = 'CLOSED' AND p.net_return > 0)::int AS wins,
             count(*) FILTER (WHERE p.status = 'CLOSED' AND p.net_return < 0)::int AS losses,
             count(*) FILTER (WHERE p.status = 'CLOSED')::int AS closed,
             sum(p.net_return) FILTER (WHERE p.status = 'CLOSED')::text AS total_return
      FROM paper_trade_records p JOIN signal_records s ON s.id = p.signal_id
      GROUP BY coalesce(s.trading_style, 'unknown') ORDER BY key
    `
  );
  const byMarket = groupSummary(
    await sql<Array<Record<string, unknown>>>`
      SELECT s.market AS key,
             count(*)::int AS total,
             count(*) FILTER (WHERE p.status = 'CLOSED' AND p.net_return > 0)::int AS wins,
             count(*) FILTER (WHERE p.status = 'CLOSED' AND p.net_return < 0)::int AS losses,
             count(*) FILTER (WHERE p.status = 'CLOSED')::int AS closed,
             sum(p.net_return) FILTER (WHERE p.status = 'CLOSED')::text AS total_return
      FROM paper_trade_records p JOIN signal_records s ON s.id = p.signal_id
      GROUP BY s.market ORDER BY key
    `
  );

  return {
    total: Number(overall?.total ?? 0),
    open: Number(overall?.open ?? 0),
    closed,
    wins,
    losses,
    winRate: closed ? wins / closed : null,
    averageNetReturn: closed ? Number(overall?.total_return ?? 0) / closed : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdown: closed ? maxDrawdown : null,
    cumulativeReturn: closed ? equity - 1 : null,
    worstLossStreak: closed ? worstLossStreak : null,
    bestTrade: closed ? Number(overall?.max_return ?? 0) : null,
    worstTrade: closed ? Number(overall?.min_return ?? 0) : null,
    byStrategy,
    byTimeframe,
    byTradingStyle,
    byMarket,
    assumptions: {
      roundTripCostBps: Number(process.env.PAPER_ROUND_TRIP_COST_BPS ?? "12"),
      fundingBpsPer8h: Number(process.env.PAPER_FUNDING_BPS_PER_8H ?? "0")
    }
  };
}
