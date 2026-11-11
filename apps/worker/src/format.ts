import { formatPrice } from "@signal-engine/core";

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export type SignalMessageInput = {
  symbol: string;
  market: string;
  direction: string;
  timeframe: string;
  tradingStyle?: string | null;
  confirmationTimeframe?: string | null;
  strategyName?: string | null;
  entry: number;
  stop: number;
  targets: Array<{ price: string; allocationPct?: number }>;
  rewardRisk: string;
  qualityScore?: string | null;
  rationale: string[];
  invalidation?: string[] | undefined;
  expiresAt: Date;
};

export function formatSignalMessage(signal: SignalMessageInput): string {
  const lines = [
    `<b>${escapeHtml(signal.market.toUpperCase())} ${escapeHtml(signal.symbol)} ${escapeHtml(signal.direction)}</b>`,
    `Timeframe: ${escapeHtml(signal.timeframe)}${signal.confirmationTimeframe ? ` (confirmation ${escapeHtml(signal.confirmationTimeframe)})` : ""}`,
    ...(signal.tradingStyle ? [`Style: ${escapeHtml(signal.tradingStyle)}`] : []),
    ...(signal.strategyName ? [`Strategy: ${escapeHtml(signal.strategyName)}`] : []),
    `Entry: ${formatPrice(signal.symbol, signal.entry)}`,
    `Stop loss: ${formatPrice(signal.symbol, signal.stop)}`,
    ...signal.targets.map((target, index) => `TP${index + 1}: ${formatPrice(signal.symbol, Number(target.price))}${target.allocationPct !== undefined ? ` (${target.allocationPct}% allocation)` : ""}`),
    `Reward/risk: ${signal.rewardRisk}`,
    ...(signal.qualityScore ? [`Quality score: ${signal.qualityScore}/100`] : []),
    `Reason: ${signal.rationale.map(escapeHtml).join("; ")}`,
    ...(signal.invalidation?.length ? [`Invalidation: ${signal.invalidation.map(escapeHtml).join("; ")}`] : []),
    `Expires: ${signal.expiresAt.toISOString()}`,
    "Signal only. No trade has been placed."
  ];
  return lines.join("\n");
}

export function formatLifecycleMessage(
  signal: { symbol: string; market: string; direction: string; timeframe: string; strategyKey?: string | null },
  eventType: string,
  details: { price?: number; targetIndex?: number; remainingPct?: number; netReturn?: number; reason?: string }
): string {
  const label = eventType.replaceAll("_", " ");
  const lines = [
    `<b>${escapeHtml(signal.market.toUpperCase())} ${escapeHtml(signal.symbol)} ${escapeHtml(signal.direction)} — ${escapeHtml(label)}</b>`,
    `Timeframe: ${escapeHtml(signal.timeframe)}`,
    ...(signal.strategyKey ? [`Strategy: ${escapeHtml(signal.strategyKey)}`] : []),
    ...(details.targetIndex !== undefined ? [`Target: TP${details.targetIndex}`] : []),
    ...(details.price !== undefined ? [`Price: ${formatPrice(signal.symbol, details.price)}`] : []),
    ...(details.remainingPct !== undefined ? [`Remaining: ${details.remainingPct}%`] : []),
    ...(details.netReturn !== undefined ? [`Net paper return: ${(details.netReturn * 100).toFixed(2)}%`] : []),
    ...(details.reason ? [`Reason: ${escapeHtml(details.reason)}`] : []),
    "Signal only. No trade has been placed."
  ];
  return lines.join("\n");
}
