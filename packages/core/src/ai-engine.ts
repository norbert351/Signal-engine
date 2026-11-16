import { createHash } from "node:crypto";
import type { Candle } from "./index.js";
import { atr, emaSeries, relativeVolume } from "./indicators.js";
import {
  ALL_UNIVERSE_SYMBOLS,
  sanitizeUntrustedArticleText,
  type DirectionBias,
  type ImportanceLevel,
  type NormalizedNewsArticle
} from "./news-intelligence.js";
import type { NormalizedGlobalEvent } from "./event-intelligence.js";

export type AiTaskLayer = "layer1_fast" | "layer2_reasoning";

export type AiProviderStatus = {
  key: string;
  name: string;
  enabled: boolean;
  requiresCredentials: boolean;
  credentialEnvVar?: string;
  configured: boolean;
  healthStatus: "ok" | "awaiting_credentials" | "degraded" | "error";
};

export type AiLayer1Output = {
  schemaVersion: "news-l1-v1";
  category: string;
  importance: ImportanceLevel;
  relevanceScore: number;
  eligibleForLayer2: boolean;
  skipLayer2Reason?: string;
  entities: Array<{ type: string; code: string; role: string }>;
  extractedFacts: Array<{ statement: string; sourceUrl: string; verifiedNumeric: boolean }>;
  affectedSymbols: string[];
};

export type AiScenario = {
  scenario: "bullish_continuation" | "bearish_continuation" | "mean_reversion" | "volatility_whipsaw";
  condition: string;
  affectedSymbols: string[];
  riskNote: string;
};

export type AiLayer2Output = {
  schemaVersion: "news-l2-v1";
  observedFacts: Array<{ statement: string; sourceUrl: string; timestampIso: string }>;
  interpretations: Array<{ thesis: string; directionBias: DirectionBias; affectedSymbols: string[] }>;
  possibleScenarios: AiScenario[];
  contradictionsDetected: boolean;
  contradictionSummary?: string;
  eventRiskLevel: "low" | "moderate" | "elevated" | "extreme";
  macroContextSummary: string;
};

export type AiValidationResult = {
  valid: boolean;
  status: "validated" | "downgraded" | "rejected";
  checksPassed: string[];
  checksFailed: string[];
  downgraded: boolean;
  notes: string;
};

export type AiRunRecord = {
  providerKey: string;
  modelName: string;
  taskLayer: AiTaskLayer;
  taskKey: string;
  promptVersion: string;
  inputSnapshot: Record<string, unknown>;
  outputPayload: Record<string, unknown>;
  validation: AiValidationResult;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  usedFallback: boolean;
  errorMessage?: string;
};

export class DeterministicValidationLayer {
  static validateLayer2Output(
    output: Partial<AiLayer2Output>,
    options: {
      evaluationTimeMs?: number;
      maxArticleAgeMs?: number;
      rawInputText?: string;
    } = {}
  ): AiValidationResult {
    const checksPassed: string[] = [];
    const checksFailed: string[] = [];
    const nowMs = options.evaluationTimeMs ?? Date.now();
    const maxAgeMs = options.maxArticleAgeMs ?? 48 * 3600_000;

    if (options.rawInputText) {
      const sanitized = sanitizeUntrustedArticleText(options.rawInputText);
      if (sanitized.sanitized) {
        checksFailed.push("untrusted_prompt_injection_detected");
      } else {
        checksPassed.push("prompt_injection_clean");
      }
    }

    if (output.schemaVersion === "news-l2-v1") {
      checksPassed.push("schema_version_valid");
    } else {
      checksFailed.push("invalid_schema_version");
    }

    if (Array.isArray(output.observedFacts) && output.observedFacts.length > 0) {
      const allHaveSources = output.observedFacts.every(
        (fact) =>
          typeof fact.statement === "string" &&
          fact.statement.trim().length > 0 &&
          typeof fact.sourceUrl === "string" &&
          /^https?:\/\//i.test(fact.sourceUrl)
      );
      if (allHaveSources) checksPassed.push("source_references_present");
      else checksFailed.push("missing_or_invalid_source_references");

      const timestampsValid = output.observedFacts.every((fact) => {
        const ts = Date.parse(fact.timestampIso);
        return Number.isFinite(ts) && ts <= nowMs + 60_000 && nowMs - ts <= maxAgeMs;
      });
      if (timestampsValid) checksPassed.push("timestamp_consistency_and_freshness");
      else checksFailed.push("stale_or_future_fact_timestamp");
    } else {
      checksFailed.push("missing_observed_facts");
    }

    if (Array.isArray(output.interpretations) && Array.isArray(output.possibleScenarios)) {
      checksPassed.push("fact_vs_interpretation_separated");
      const allSymbolsValid = [
        ...output.interpretations.flatMap((i) => i.affectedSymbols ?? []),
        ...output.possibleScenarios.flatMap((s) => s.affectedSymbols ?? [])
      ].every((sym) => ALL_UNIVERSE_SYMBOLS.has(sym));
      if (allSymbolsValid) checksPassed.push("asset_mappings_valid");
      else checksFailed.push("invalid_market_symbol_reference");
    } else {
      checksFailed.push("missing_interpretations_or_scenarios");
    }

    if (
      output.eventRiskLevel &&
      ["low", "moderate", "elevated", "extreme"].includes(output.eventRiskLevel) &&
      typeof output.macroContextSummary === "string" &&
      output.macroContextSummary.trim().length > 0
    ) {
      checksPassed.push("required_fields_complete");
    } else {
      checksFailed.push("missing_required_risk_or_summary_fields");
    }

    if (checksFailed.length === 0) {
      return {
        valid: true,
        status: "validated",
        checksPassed,
        checksFailed: [],
        downgraded: false,
        notes: "All deterministic schema, source, timestamp, and asset checks passed."
      };
    }

    const hardRejectReasons = new Set([
      "invalid_schema_version",
      "missing_observed_facts",
      "missing_or_invalid_source_references",
      "invalid_market_symbol_reference"
    ]);
    const isRejected = checksFailed.some((reason) => hardRejectReasons.has(reason));

    return {
      valid: false,
      status: isRejected ? "rejected" : "downgraded",
      checksPassed,
      checksFailed,
      downgraded: !isRejected,
      notes: isRejected
        ? `Rejected due to deterministic validation failure: ${checksFailed.join(", ")}`
        : `Downgraded to caution-only due to: ${checksFailed.join(", ")}`
    };
  }
}

export class FastProcessingLayer {
  /**
   * Layer 1: Efficient classification, entity & fact extraction, and relevance gating
   * so low-relevance or duplicate articles never trigger expensive Layer 2 reasoning calls.
   */
  static processArticle(article: NormalizedNewsArticle, isDuplicate = false): AiLayer1Output {
    const affectedSymbols = article.affectedInstruments.map((a) => a.symbol);
    let eligibleForLayer2 = true;
    let skipLayer2Reason: string | undefined;

    if (isDuplicate) {
      eligibleForLayer2 = false;
      skipLayer2Reason = "duplicate_article";
    } else if (article.relevanceScore < 50 && article.importance === "low") {
      eligibleForLayer2 = false;
      skipLayer2Reason = "below_relevance_threshold";
    } else if (affectedSymbols.length === 0) {
      eligibleForLayer2 = false;
      skipLayer2Reason = "no_mapped_universe_instruments";
    }

    return {
      schemaVersion: "news-l1-v1",
      category: article.category,
      importance: article.importance,
      relevanceScore: article.relevanceScore,
      eligibleForLayer2,
      ...(skipLayer2Reason ? { skipLayer2Reason } : {}),
      entities: article.entities.map((e) => ({ type: e.entityType, code: e.code, role: e.role })),
      extractedFacts: article.facts.map((f) => ({
        statement: f.statement,
        sourceUrl: f.sourceUrl,
        verifiedNumeric: f.exactQuantityVerified
      })),
      affectedSymbols
    };
  }
}

export class AdvancedReasoningLayer {
  /**
   * Layer 2: Synthesizes multi-source articles and/or scheduled events, detects contradictions,
   * separates observed facts from interpretations and scenarios, and assesses event risk.
   */
  static synthesize(
    articles: NormalizedNewsArticle[],
    relatedEvent?: NormalizedGlobalEvent
  ): AiLayer2Output {
    if (articles.length === 0 && !relatedEvent) {
      throw new Error("AdvancedReasoningLayer requires at least one article or event");
    }

    const biases = new Set(articles.map((a) => a.directionBias).filter((b) => b !== "neutral"));
    const contradictionsDetected =
      biases.has("bullish") && biases.has("bearish") ||
      articles.some((a) => a.directionBias === "conflicting");

    const affectedSymbols = [
      ...new Set([
        ...articles.flatMap((a) => a.affectedInstruments.map((i) => i.symbol)),
        ...(relatedEvent ? relatedEvent.affectedAssets.map((a) => a.symbol) : [])
      ])
    ].filter((sym) => ALL_UNIVERSE_SYMBOLS.has(sym));

    const observedFacts = [
      ...articles.map((a) => ({
        statement: a.title,
        sourceUrl: a.url,
        timestampIso: a.publishedAt.toISOString()
      })),
      ...(relatedEvent && relatedEvent.verifiedEvidence.length > 0
        ? relatedEvent.verifiedEvidence.map((ev) => ({
            statement: `${relatedEvent.eventName}: ${ev.headline}`,
            sourceUrl: ev.sourceUrl,
            timestampIso: ev.verifiedAt
          }))
        : [])
    ];

    const primaryBias: DirectionBias = contradictionsDetected
      ? "conflicting"
      : biases.has("bullish")
        ? "bullish"
        : biases.has("bearish")
          ? "bearish"
          : "neutral";

    const highImpact =
      articles.some((a) => a.importance === "critical" || a.importance === "high") ||
      (relatedEvent && (relatedEvent.importance === "critical" || relatedEvent.importance === "high"));

    const eventRiskLevel: AiLayer2Output["eventRiskLevel"] = contradictionsDetected
      ? "elevated"
      : articles.some((a) => a.importance === "critical") || relatedEvent?.importance === "critical"
        ? "extreme"
        : highImpact
          ? "elevated"
          : "moderate";

    const interpretations: AiLayer2Output["interpretations"] = [
      {
        thesis: contradictionsDetected
          ? "Conflicting directional reports detected across sources; directional conviction is suppressed until official clarification."
          : relatedEvent?.surprise.hasActualAndConsensus
            ? `${relatedEvent.eventName} printed ${relatedEvent.surprise.direction} (${relatedEvent.surprise.surprisePct}% surprise vs consensus), shifting short-term macro pressure.`
            : `Market impact assessment for ${articles[0]?.category ?? relatedEvent?.category ?? "macro"} development (${primaryBias} bias).`,
        directionBias: primaryBias,
        affectedSymbols: affectedSymbols.slice(0, 8)
      }
    ];

    const possibleScenarios: AiScenario[] = [
      {
        scenario: primaryBias === "bearish" ? "bearish_continuation" : "bullish_continuation",
        condition: "Requires closed-candle confirmation, volume expansion >= 1.2x, and spread normalization on entry and confirmation timeframes.",
        affectedSymbols: affectedSymbols.slice(0, 6),
        riskNote: "Invalidate immediately if price reclaims the pre-event structural boundary."
      },
      {
        scenario: "volatility_whipsaw",
        condition: "Initial post-announcement spike fails to hold beyond structural boundary or occurs during wide spread conditions.",
        affectedSymbols: affectedSymbols.slice(0, 6),
        riskNote: "Stand aside (NO_TRADE) during initial liquidity vacuum."
      }
    ];

    return {
      schemaVersion: "news-l2-v1",
      observedFacts,
      interpretations,
      possibleScenarios,
      contradictionsDetected,
      ...(contradictionsDetected ? { contradictionSummary: "Opposing directional claims across ingested reports." } : {}),
      eventRiskLevel,
      macroContextSummary: interpretations[0]!.thesis
    };
  }
}

export class MarketCorrelationLayer {
  /**
   * Layer 4: Correlates verified news/events with actual OHLCV market candles, ATR volatility,
   * and relative volume, distinguishing observed market reaction from interpretation.
   */
  static correlateWithCandles(
    symbol: string,
    candles: Candle[],
    eventTimestampMs: number
  ): {
    symbol: string;
    observedFacts: {
      barsAvailableAfterEvent: number;
      reaction1BarPct: number | null;
      reaction4BarPct: number | null;
      volatilityRatio: number | null;
      volumeRatio: number | null;
    };
    marketRegime: "trending_expansion" | "volatile_chop" | "normal" | "insufficient_data";
  } {
    const closed = candles.filter((c) => c.complete).sort((a, b) => a.closeTime - b.closeTime);
    if (closed.length < 25) {
      return {
        symbol,
        observedFacts: {
          barsAvailableAfterEvent: 0,
          reaction1BarPct: null,
          reaction4BarPct: null,
          volatilityRatio: null,
          volumeRatio: null
        },
        marketRegime: "insufficient_data"
      };
    }

    const beforeIdx = closed.findIndex((c) => c.closeTime >= eventTimestampMs);
    const pivotIdx = beforeIdx >= 1 ? beforeIdx - 1 : closed.length - 2;
    const basePrice = closed[pivotIdx]!.close;
    const postBars = closed.slice(pivotIdx + 1);
    const bar1 = postBars[0];
    const bar4 = postBars[3];

    const reaction1BarPct = bar1 ? Number((((bar1.close - basePrice) / basePrice) * 100).toFixed(4)) : null;
    const reaction4BarPct = bar4 ? Number((((bar4.close - basePrice) / basePrice) * 100).toFixed(4)) : null;

    const atrs = atr(closed, 14);
    const currentAtr = atrs.at(-1) ?? 0;
    const priorAtrs = atrs.slice(-15, -1);
    const avgAtr = priorAtrs.length > 0 ? priorAtrs.reduce((s, v) => s + v, 0) / priorAtrs.length : currentAtr;
    const volatilityRatio = avgAtr > 0 ? Number((currentAtr / avgAtr).toFixed(3)) : null;

    const volRatioRaw = relativeVolume(closed, 20);
    const volumeRatio = volRatioRaw !== null && Number.isFinite(volRatioRaw) ? Number(volRatioRaw.toFixed(3)) : null;

    const emasFast = emaSeries(closed.map((c) => c.close), 10);
    const emasSlow = emaSeries(closed.map((c) => c.close), 20);
    const aligned =
      emasFast.length > 0 &&
      emasSlow.length > 0 &&
      Math.abs(emasFast.at(-1)! - emasSlow.at(-1)!) > currentAtr * 0.3;

    const marketRegime =
      volatilityRatio !== null && volatilityRatio >= 1.4
        ? aligned
          ? "trending_expansion"
          : "volatile_chop"
        : "normal";

    return {
      symbol,
      observedFacts: {
        barsAvailableAfterEvent: postBars.length,
        reaction1BarPct,
        reaction4BarPct,
        volatilityRatio,
        volumeRatio
      },
      marketRegime
    };
  }
}

export class AiProviderRegistry {
  static listProviders(): AiProviderStatus[] {
    const defs: Array<{ key: string; name: string; requiresCredentials: boolean; credentialEnvVar?: string }> = [
      { key: "deterministic_fallback", name: "Deterministic Rule & Schema Fallback Engine", requiresCredentials: false },
      { key: "openai", name: "OpenAI Structured Reasoning Provider", requiresCredentials: true, credentialEnvVar: "OPENAI_API_KEY" },
      { key: "gemini", name: "Google Gemini Structured Intelligence Provider", requiresCredentials: true, credentialEnvVar: "GEMINI_API_KEY" },
      { key: "anthropic", name: "Anthropic Claude Reasoning Provider", requiresCredentials: true, credentialEnvVar: "ANTHROPIC_API_KEY" }
    ];
    return defs.map((d) => {
      const configured = !d.requiresCredentials || Boolean(d.credentialEnvVar && process.env[d.credentialEnvVar]?.trim());
      return {
        ...d,
        enabled: true,
        configured,
        healthStatus: configured ? "ok" : "awaiting_credentials"
      };
    });
  }

  /**
   * Executes Layer 2 analysis with timeout, validation, token/cost accounting, and automatic
   * fallback to the deterministic engine if no external AI provider credentials are set or if
   * an external call times out or fails. Never blocks technical scanning.
   */
  static async runLayer2Analysis(
    articles: NormalizedNewsArticle[],
    relatedEvent?: NormalizedGlobalEvent,
    options: {
      preferredProvider?: string;
      timeoutMs?: number;
      evaluationTimeMs?: number;
      customInvoker?: (providerKey: string, payload: unknown) => Promise<AiLayer2Output>;
    } = {}
  ): Promise<{ output: AiLayer2Output; runRecord: AiRunRecord }> {
    const started = Date.now();
    const providers = this.listProviders();
    const preferred = options.preferredProvider ?? process.env.AI_PROVIDER ?? "deterministic_fallback";
    const providerObj = providers.find((p) => p.key === preferred && p.configured) ?? providers[0]!;
    const usedFallback = providerObj.key === "deterministic_fallback" && preferred !== "deterministic_fallback";

    const inputSnapshot = {
      articleCount: articles.length,
      articleHashes: articles.map((a) => a.contentHash),
      eventKey: relatedEvent?.dedupeKey ?? null
    };
    const rawCombinedText = articles.map((a) => `${a.title} ${a.summary}`).join(" ");
    const inputTokens = Math.max(1, Math.ceil(rawCombinedText.length / 4));

    let output: AiLayer2Output;
    let errorMessage: string | undefined;
    let finalProviderKey = providerObj.key;
    let finalModelName = providerObj.key === "deterministic_fallback" ? "deterministic-reasoning-v1" : `${providerObj.key}-reasoning`;

    try {
      if (options.customInvoker && providerObj.key !== "deterministic_fallback") {
        const timeoutMs = options.timeoutMs ?? 12_000;
        output = await Promise.race([
          options.customInvoker(providerObj.key, inputSnapshot),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI provider timeout")), timeoutMs))
        ]);
      } else {
        output = AdvancedReasoningLayer.synthesize(articles, relatedEvent);
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message.slice(0, 200) : "AI invocation failed";
      finalProviderKey = "deterministic_fallback";
      finalModelName = "deterministic-reasoning-v1";
      output = AdvancedReasoningLayer.synthesize(articles, relatedEvent);
    }

    const validation = DeterministicValidationLayer.validateLayer2Output(output, {
      ...(options.evaluationTimeMs !== undefined ? { evaluationTimeMs: options.evaluationTimeMs } : {}),
      rawInputText: rawCombinedText
    });

    const outputJson = JSON.stringify(output);
    const outputTokens = Math.max(1, Math.ceil(outputJson.length / 4));
    const estimatedCostUsd =
      finalProviderKey === "deterministic_fallback"
        ? 0
        : Number(((inputTokens * 0.00125 + outputTokens * 0.005) / 1000).toFixed(6));

    const promptVersionHash = createHash("sha256").update("news_layer2_reasoning:v1").digest("hex").slice(0, 12);

    return {
      output,
      runRecord: {
        providerKey: finalProviderKey,
        modelName: finalModelName,
        taskLayer: "layer2_reasoning",
        taskKey: "news_layer2_reasoning",
        promptVersion: `v1-${promptVersionHash}`,
        inputSnapshot,
        outputPayload: output as unknown as Record<string, unknown>,
        validation,
        durationMs: Math.max(1, Date.now() - started),
        inputTokens,
        outputTokens,
        estimatedCostUsd,
        usedFallback: usedFallback || Boolean(errorMessage),
        ...(errorMessage ? { errorMessage } : {})
      }
    };
  }
}
