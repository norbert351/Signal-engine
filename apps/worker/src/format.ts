import { formatPrice } from "@signal-engine/core";

export function redactSecretsFromText(value: string): string {
  let out = value
    .replace(/bot\d+:[A-Za-z0-9_-]{10,}/gi, "bot[redacted]")
    .replace(/([?&](?:apikey|api_key|token|password|secret|x-admin-api-key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/((?:postgres(?:ql)?|redis|rediss):\/\/[^:\s/@]+:)[^@\s"']+(@)/gi, "$1[redacted]$2");
  const envSecrets = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TWELVE_DATA_API_KEY,
    process.env.ADMIN_API_KEY,
    process.env.POSTGRES_PASSWORD,
    process.env.OPENAI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.CRYPTOPANIC_API_KEY,
    process.env.NEWS_API_KEY
  ];
  for (const secret of envSecrets) {
    if (secret && secret.trim().length >= 4 && secret !== "replace-with-a-strong-password") {
      out = out.replaceAll(secret, "[redacted]");
    }
  }
  return out;
}

export function errorText(error: unknown, fallback = "unknown error"): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  const raw = cause ?? (error instanceof Error ? error.message : fallback);
  return redactSecretsFromText((raw.split("\n")[0] ?? "").slice(0, 300));
}

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

export function formatEventAlertMessage(input: {
  eventName: string;
  category: string;
  importance: string;
  scheduledTimeIso: string;
  affectedInstruments: string[];
  previousValue?: number | string | null;
  consensusValue?: number | string | null;
  status: string;
  risks?: string[];
}): string {
  const risks = input.risks?.length
    ? input.risks
    : ["Increased volatility", "Wider spreads", "Uncertain directional reaction"];
  const lines = [
    "<b>SIGNAL ENGINE | EVENT ALERT</b>",
    "",
    `Event: ${escapeHtml(input.eventName)}`,
    `Category: ${escapeHtml(input.category)}`,
    `Importance: ${escapeHtml(input.importance)}`,
    `Scheduled time: ${escapeHtml(input.scheduledTimeIso)}`,
    "",
    "Affected instruments:",
    escapeHtml(input.affectedInstruments.join(", ") || "None"),
    "",
    `Previous: ${input.previousValue !== null && input.previousValue !== undefined ? escapeHtml(String(input.previousValue)) : "Unavailable"}`,
    `Consensus: ${input.consensusValue !== null && input.consensusValue !== undefined ? escapeHtml(String(input.consensusValue)) : "Unavailable"}`,
    "",
    `Status: ${escapeHtml(input.status)}`,
    "",
    "Potential market risks:",
    ...risks.map((r) => `- ${escapeHtml(r)}`)
  ];
  return lines.join("\n");
}

export function formatEventTradeMessage(input: {
  strategyName: string;
  eventName: string;
  symbol: string;
  direction: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rewardRisk: number | string;
  evidence: string[];
  riskClassification: string;
}): string {
  const lines = [
    "<b>SIGNAL ENGINE | EVENT TRADE</b>",
    "",
    `Strategy: ${escapeHtml(input.strategyName)}`,
    `Event: ${escapeHtml(input.eventName)}`,
    `Instrument: ${escapeHtml(input.symbol)}`,
    `Direction: ${escapeHtml(input.direction)}`,
    "",
    `Entry: ${formatPrice(input.symbol, input.entry)}`,
    `Stop-loss: ${formatPrice(input.symbol, input.stopLoss)}`,
    `Take-profit: ${formatPrice(input.symbol, input.takeProfit)}`,
    `Risk/reward: ${escapeHtml(String(input.rewardRisk))}`,
    "",
    "Event evidence:",
    ...input.evidence.map((item) => `- ${escapeHtml(item)}`),
    "",
    `Risk classification: ${escapeHtml(input.riskClassification)}`,
    "Signal only. No trade has been placed."
  ];
  return lines.join("\n");
}

export function formatBreakingNewsMessage(input: {
  headline: string;
  sourceName: string;
  category: string;
  importance: string;
  credibilityScore: number;
  affectedSymbols: string[];
  publishedAtIso: string;
}): string {
  return [
    "<b>SIGNAL ENGINE | BREAKING NEWS</b>",
    "",
    `Headline: ${escapeHtml(input.headline)}`,
    `Source: ${escapeHtml(input.sourceName)} (Credibility: ${input.credibilityScore}/100)`,
    `Category: ${escapeHtml(input.category)} | Importance: ${escapeHtml(input.importance)}`,
    `Published: ${escapeHtml(input.publishedAtIso)}`,
    `Affected instruments: ${escapeHtml(input.affectedSymbols.join(", ") || "None")}`,
    "Information only. No trade has been placed."
  ].join("\n");
}

export function formatEventRiskWarningMessage(input: {
  symbol: string;
  eventName: string;
  riskLevel: string;
  reasons: string[];
}): string {
  return [
    "<b>SIGNAL ENGINE | ELEVATED EVENT RISK</b>",
    "",
    `Instrument: ${escapeHtml(input.symbol)}`,
    `Event: ${escapeHtml(input.eventName)}`,
    `Risk level: ${escapeHtml(input.riskLevel)}`,
    "Reasons:",
    ...input.reasons.map((r) => `- ${escapeHtml(r)}`)
  ].join("\n");
}

export function formatDailyIntelligenceSummaryMessage(input: {
  title: string;
  marketRegime: string;
  summary: string;
  riskWarnings: string[];
}): string {
  return [
    "<b>SIGNAL ENGINE | DAILY INTELLIGENCE SUMMARY</b>",
    "",
    `Title: ${escapeHtml(input.title)}`,
    `Market regime: ${escapeHtml(input.marketRegime)}`,
    `Summary: ${escapeHtml(input.summary)}`,
    ...(input.riskWarnings.length
      ? ["", "Risk warnings:", ...input.riskWarnings.map((w) => `- ${escapeHtml(w)}`)]
      : [])
  ].join("\n");
}
