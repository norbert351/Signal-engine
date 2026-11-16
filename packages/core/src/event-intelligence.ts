import { ALL_UNIVERSE_SYMBOLS, type ImportanceLevel, type NewsCategory } from "./news-intelligence.js";

export type GlobalEventType = "scheduled_economic" | "unscheduled_global" | "crypto_specific";
export type EventLifecycleStatus =
  | "scheduled"
  | "awaiting_release"
  | "released"
  | "monitoring_reaction"
  | "completed"
  | "revised"
  | "cancelled";

export type RawGlobalEventInput = {
  sourceKey: string;
  eventType?: GlobalEventType;
  category?: NewsCategory;
  eventName: string;
  country?: string;
  currency?: string;
  scheduledAt?: string | number | Date | null;
  publishedAt?: string | number | Date | null;
  collectedAt?: string | number | Date;
  timezone?: string;
  previousValue?: number | null;
  revisedPreviousValue?: number | null;
  consensusValue?: number | null;
  actualValue?: number | null;
  unit?: string;
  importance?: ImportanceLevel;
  isScheduled?: boolean;
  verifiedEvidence?: Array<{ sourceUrl: string; headline: string; verifiedAt: string }>;
  metadata?: Record<string, unknown>;
};

export type EventAssetCandidate = {
  symbol: string;
  market: "crypto_perpetual" | "forex";
  sensitivity: "low" | "medium" | "high";
  relationshipType: "macro_driver" | "direct_catalyst" | "safe_haven" | "sector_spillover";
  tradable: boolean;
  notes: string;
};

export type NormalizedGlobalEvent = {
  dedupeKey: string;
  sourceKey: string;
  eventType: GlobalEventType;
  category: NewsCategory;
  eventName: string;
  country: string;
  currency: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  collectedAt: Date;
  timezone: string;
  previousValue: number | null;
  revisedPreviousValue: number | null;
  consensusValue: number | null;
  actualValue: number | null;
  unit: string | null;
  importance: ImportanceLevel;
  status: EventLifecycleStatus;
  isScheduled: boolean;
  surprise: {
    hasActualAndConsensus: boolean;
    surpriseValue: number | null;
    surprisePct: number | null;
    direction: "above_consensus" | "below_consensus" | "inline" | "unknown";
  };
  affectedAssets: EventAssetCandidate[];
  verifiedEvidence: Array<{ sourceUrl: string; headline: string; verifiedAt: string }>;
  metadata: Record<string, unknown>;
};

export class EventClassificationService {
  static classifyEvent(eventName: string, explicitType?: GlobalEventType, explicitCategory?: NewsCategory): {
    eventType: GlobalEventType;
    category: NewsCategory;
    importance: ImportanceLevel;
    patternKey: string;
  } {
    const lower = eventName.toLowerCase();

    if (/\b(?:fomc|federal reserve interest rate|fed rate decision)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "central_bank_decisions", importance: "critical", patternKey: "FOMC" };
    }
    if (/\b(?:ecb|european central bank)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "central_bank_decisions", importance: "high", patternKey: "ECB" };
    }
    if (/\b(?:boj|bank of japan)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "central_bank_decisions", importance: "high", patternKey: "BOJ" };
    }
    if (/\b(?:boe|bank of england)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "central_bank_decisions", importance: "high", patternKey: "BOE" };
    }
    if (/\b(?:core cpi|cpi|consumer price index|pce|ppi)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "inflation_announcements", importance: "high", patternKey: "US_CPI" };
    }
    if (/\b(?:non-farm payrolls|nonfarm payrolls|nfp|unemployment rate)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "employment_reports", importance: "high", patternKey: "US_NFP" };
    }
    if (/\b(?:gdp|gross domestic product)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "gdp_releases", importance: "high", patternKey: "GDP" };
    }
    if (/\b(?:retail sales)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "retail_sales", importance: "medium", patternKey: "RETAIL_SALES" };
    }
    if (/\b(?:pmi|ism manufacturing|ism services)\b/.test(lower)) {
      return { eventType: "scheduled_economic", category: "manufacturing_services_pmi", importance: "medium", patternKey: "PMI" };
    }
    if (/\b(?:token unlock|vesting release)\b/.test(lower)) {
      return { eventType: "crypto_specific", category: "token_unlocks", importance: "medium", patternKey: "TOKEN_UNLOCK" };
    }
    if (/\b(?:bitcoin etf|spot btc etf)\b/.test(lower)) {
      return { eventType: "crypto_specific", category: "etf_announcements", importance: "high", patternKey: "BTC_ETF" };
    }
    if (/\b(?:ethereum etf|spot eth etf)\b/.test(lower)) {
      return { eventType: "crypto_specific", category: "etf_announcements", importance: "high", patternKey: "ETH_ETF" };
    }
    if (/\b(?:ethereum upgrade|hard fork|mainnet launch|protocol upgrade)\b/.test(lower)) {
      return { eventType: "crypto_specific", category: "crypto_protocol_upgrades", importance: "high", patternKey: "ETH_UPGRADE" };
    }
    if (/\b(?:exploit|hack|bridge drain|exchange failure|insolvency)\b/.test(lower)) {
      return { eventType: "unscheduled_global", category: "blockchain_exploits", importance: "critical", patternKey: "CRYPTO_EXPLOIT" };
    }
    if (/\b(?:war|military|sanctions|airstrike|escalation)\b/.test(lower)) {
      return { eventType: "unscheduled_global", category: "wars_and_sanctions", importance: "high", patternKey: "GEOPOLITICAL_ESCALATION" };
    }

    return {
      eventType: explicitType ?? "scheduled_economic",
      category: explicitCategory ?? "monetary_policy",
      importance: "medium",
      patternKey: "GENERAL_MACRO"
    };
  }
}

export class EventExpectationService {
  /**
   * Computes standardized surprise only when both actual and consensus values are explicitly provided.
   * Never fabricates or imputes missing consensus or actual numbers.
   */
  static evaluateSurprise(actualValue: number | null | undefined, consensusValue: number | null | undefined) {
    if (
      actualValue === null ||
      actualValue === undefined ||
      consensusValue === null ||
      consensusValue === undefined ||
      !Number.isFinite(actualValue) ||
      !Number.isFinite(consensusValue)
    ) {
      return {
        hasActualAndConsensus: false,
        surpriseValue: null,
        surprisePct: null,
        direction: "unknown" as const
      };
    }
    const diff = Number((actualValue - consensusValue).toFixed(8));
    const denom = Math.abs(consensusValue) > 1e-9 ? Math.abs(consensusValue) : 1;
    const pct = Number(((diff / denom) * 100).toFixed(4));
    const direction =
      Math.abs(diff) <= 1e-9
        ? ("inline" as const)
        : diff > 0
          ? ("above_consensus" as const)
          : ("below_consensus" as const);
    return {
      hasActualAndConsensus: true,
      surpriseValue: diff,
      surprisePct: pct,
      direction
    };
  }
}

export class EventAssetMappingService {
  static mapEventToAssets(eventName: string, currency: string, patternKey: string, category: NewsCategory): EventAssetCandidate[] {
    const out = new Map<string, EventAssetCandidate>();
    const add = (
      symbol: string,
      market: "crypto_perpetual" | "forex",
      sensitivity: "low" | "medium" | "high",
      relationshipType: EventAssetCandidate["relationshipType"],
      notes: string
    ) => {
      if (!ALL_UNIVERSE_SYMBOLS.has(symbol)) return;
      out.set(symbol, {
        symbol,
        market,
        sensitivity,
        relationshipType,
        tradable: symbol !== "TONUSDT",
        notes
      });
    };

    const cur = currency.toUpperCase();
    if (patternKey === "FOMC" || patternKey === "US_CPI" || patternKey === "US_NFP" || cur === "USD") {
      add("EUR_USD", "forex", "high", "macro_driver", `${eventName} impacts USD yield & rate differential vs EUR`);
      add("GBP_USD", "forex", "high", "macro_driver", `${eventName} impacts USD yield & rate differential vs GBP`);
      add("USD_JPY", "forex", "high", "macro_driver", `${eventName} impacts US Treasury yields & USD/JPY`);
      add("XAU_USD", "forex", "high", "macro_driver", `${eventName} impacts USD real yields and gold`);
      add("BTCUSDT", "crypto_perpetual", "high", "macro_driver", `${eventName} impacts macro liquidity & crypto risk appetite`);
      add("ETHUSDT", "crypto_perpetual", "medium", "macro_driver", `${eventName} impacts macro liquidity`);
    }
    if (patternKey === "ECB" || cur === "EUR") {
      add("EUR_USD", "forex", "high", "macro_driver", `${eventName} impacts EUR monetary policy outlook`);
      add("EUR_JPY", "forex", "high", "macro_driver", `${eventName} impacts EUR cross rates`);
    }
    if (patternKey === "BOJ" || cur === "JPY") {
      add("USD_JPY", "forex", "high", "macro_driver", `${eventName} impacts JPY monetary policy outlook`);
      add("EUR_JPY", "forex", "high", "macro_driver", `${eventName} impacts JPY cross rates`);
    }
    if (patternKey === "BOE" || cur === "GBP") {
      add("GBP_USD", "forex", "high", "macro_driver", `${eventName} impacts GBP monetary policy outlook`);
    }
    if (patternKey === "BTC_ETF") {
      add("BTCUSDT", "crypto_perpetual", "high", "direct_catalyst", "Direct Bitcoin ETF catalyst");
      add("ETHUSDT", "crypto_perpetual", "medium", "sector_spillover", "Crypto ETF spillover");
    }
    if (patternKey === "ETH_ETF" || patternKey === "ETH_UPGRADE") {
      add("ETHUSDT", "crypto_perpetual", "high", "direct_catalyst", "Direct Ethereum catalyst");
    }
    if (category === "wars_and_sanctions" || patternKey === "GEOPOLITICAL_ESCALATION") {
      add("XAU_USD", "forex", "high", "safe_haven", "Geopolitical safe-haven sensitivity");
      add("BTCUSDT", "crypto_perpetual", "medium", "macro_driver", "24/7 geopolitical risk proxy");
    }

    // Check explicit crypto symbol mention in event name
    for (const sym of ALL_UNIVERSE_SYMBOLS) {
      const base = sym.replace(/USDT$/, "");
      if (sym.endsWith("USDT") && new RegExp(`\\b(?:${base}|${sym})\\b`, "i").test(eventName)) {
        add(sym, "crypto_perpetual", "high", "direct_catalyst", `Explicit ${sym} event`);
      }
    }

    return [...out.values()];
  }
}

export class EventLifecycleService {
  static resolveStatus(
    input: {
      isScheduled: boolean;
      scheduledAt: Date | null;
      publishedAt: Date | null;
      actualValue: number | null;
      revisedPreviousValue: number | null;
    },
    now = new Date()
  ): EventLifecycleStatus {
    if (input.revisedPreviousValue !== null && input.actualValue !== null) {
      return "revised";
    }
    if (input.actualValue !== null || (input.publishedAt && input.publishedAt.getTime() <= now.getTime())) {
      const refMs = (input.publishedAt ?? input.scheduledAt ?? now).getTime();
      const ageMinutes = (now.getTime() - refMs) / 60_000;
      return ageMinutes <= 180 ? "monitoring_reaction" : "released";
    }
    if (input.isScheduled && input.scheduledAt) {
      const diffMinutes = (input.scheduledAt.getTime() - now.getTime()) / 60_000;
      if (diffMinutes <= 60 && diffMinutes >= -30) return "awaiting_release";
      return "scheduled";
    }
    return "released";
  }
}

export class EventNormalizationService {
  static normalizeEvent(raw: RawGlobalEventInput, now = new Date()): NormalizedGlobalEvent {
    if (!raw.eventName || !raw.eventName.trim()) {
      throw new Error("Event name is required");
    }
    const classified = EventClassificationService.classifyEvent(raw.eventName, raw.eventType, raw.category);
    const isScheduled = raw.isScheduled ?? classified.eventType === "scheduled_economic";

    if (!isScheduled && (!raw.verifiedEvidence || raw.verifiedEvidence.length === 0)) {
      throw new Error("Unscheduled events require verified source evidence");
    }

    const parseOptDate = (val: string | number | Date | null | undefined): Date | null => {
      if (val === null || val === undefined) return null;
      const d = new Date(val);
      if (!Number.isFinite(d.getTime())) throw new Error("Invalid event timestamp");
      return d;
    };

    const scheduledAt = parseOptDate(raw.scheduledAt);
    const publishedAt = parseOptDate(raw.publishedAt);
    const collectedAt = parseOptDate(raw.collectedAt) ?? now;

    if (isScheduled && !scheduledAt) {
      throw new Error("Scheduled events require a scheduledAt timestamp");
    }

    const toOptNum = (v: number | null | undefined): number | null =>
      v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;

    const previousValue = toOptNum(raw.previousValue);
    const revisedPreviousValue = toOptNum(raw.revisedPreviousValue);
    const consensusValue = toOptNum(raw.consensusValue);
    const actualValue = toOptNum(raw.actualValue);

    const country = (raw.country ?? "US").toUpperCase();
    const currency = (raw.currency ?? "USD").toUpperCase();
    const surprise = EventExpectationService.evaluateSurprise(actualValue, consensusValue);
    const affectedAssets = EventAssetMappingService.mapEventToAssets(
      raw.eventName,
      currency,
      classified.patternKey,
      classified.category
    );
    const status = EventLifecycleService.resolveStatus(
      { isScheduled, scheduledAt, publishedAt, actualValue, revisedPreviousValue },
      now
    );

    const anchorIso = (scheduledAt ?? publishedAt ?? collectedAt).toISOString().slice(0, 16);
    const slug = raw.eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
    const dedupeKey = `${country}:${currency}:${slug}:${anchorIso}`;

    return {
      dedupeKey,
      sourceKey: raw.sourceKey,
      eventType: classified.eventType,
      category: classified.category,
      eventName: raw.eventName.trim(),
      country,
      currency,
      scheduledAt,
      publishedAt,
      collectedAt,
      timezone: raw.timezone ?? "UTC",
      previousValue,
      revisedPreviousValue,
      consensusValue,
      actualValue,
      unit: raw.unit ?? null,
      importance: raw.importance ?? classified.importance,
      status,
      isScheduled,
      surprise,
      affectedAssets,
      verifiedEvidence: raw.verifiedEvidence ?? [],
      metadata: raw.metadata ?? {}
    };
  }
}
