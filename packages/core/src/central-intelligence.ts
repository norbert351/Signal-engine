import type { Direction } from "./index.js";
import type { NormalizedNewsArticle } from "./news-intelligence.js";
import type { NormalizedGlobalEvent } from "./event-intelligence.js";
import type { EventSignalEvaluationOutput } from "./event-trading.js";

/**
 * Part 10: Seven separated evidence dimensions.
 * Never conflates source credibility, event risk, and technical setup quality into a
 * single uncalibrated "AI confidence percentage".
 */
export type EvidenceDimensions = {
  sourceCredibility: number;      // 0..100 (weighted credibility of underlying news/event sources)
  eventImportance: number;        // 0..100 (low=25, medium=55, high=85, critical=100)
  newsRelevance: number;          // 0..100 (direct asset match vs macro spillover)
  directionalEvidence: number;    // -100 (bearish) .. 0 (neutral/conflicting) .. +100 (bullish)
  technicalSetupQuality: number;  // 0..100 (from deterministic scoreOpportunity quality-v1)
  marketConfirmation: number;     // 0..100 (closed-candle displacement, HTF trend, volume & spread check)
  eventRisk: number;              // 0..100 (higher = greater blackout, spread, volatility, or contradiction risk)
  formulaVersion: "evidence-7d-v1";
  calibrationNote: string;
};

export const EVIDENCE_FORMULA_SPEC = {
  version: "evidence-7d-v1",
  calibrationStatus: "uncalibrated_heuristic_index",
  disclaimer:
    "Each dimension is a bounded deterministic index derived from explicit observable inputs. None of these dimensions is a calibrated statistical probability of profit."
} as const;

const IMPORTANCE_SCORE: Record<string, number> = {
  low: 25,
  medium: 55,
  high: 85,
  critical: 100
};

export type TechnicalSignalSnapshot = {
  id?: string;
  symbol: string;
  market: "crypto_perpetual" | "forex";
  timeframe: string;
  strategyKey: string;
  strategyVersion: number;
  direction: Direction;
  entry: number;
  stopLoss: number;
  targets: number[];
  rewardRisk: number;
  qualityScore: number;
  quantitativeValid: boolean;
  publishedAtMs: number;
};

export type SignalFusionContext = {
  symbol: string;
  timeframe: string;
  originalStrategyKey: string;
  originalStrategyVersion: number;
  /** Immutable copy of quantitative prices; central intelligence never alters them. */
  preservedPrices: {
    entry: number;
    stopLoss: number;
    targets: number[];
    rewardRisk: number;
  };
  quantitativeAuthorityApproved: boolean;
  alignmentStatus: "aligned" | "conflicting" | "neutral" | "event_blackout_risk";
  eventRiskLevel: "low" | "moderate" | "elevated" | "extreme";
  recommendation:
    | "ALIGNED_EVIDENCE"
    | "PROCEED_QUANTITATIVE_ONLY"
    | "FLAG_CONFLICTING_EVIDENCE"
    | "RECOMMEND_ADDITIONAL_OBSERVATION"
    | "REJECT_DETERMINISTIC_EVENT_BLACKOUT";
  dimensions: EvidenceDimensions;
  nearbyEventKeys: string[];
  relatedArticleHashes: string[];
  rationale: string[];
};

export class CentralIntelligenceService {
  static computeEvidenceDimensions(input: {
    symbol?: string;
    articles?: NormalizedNewsArticle[];
    events?: NormalizedGlobalEvent[];
    technicalQualityScore?: number;
    marketConfirmationScore?: number;
    evaluationTimeMs?: number;
  }): EvidenceDimensions {
    const articles = input.articles ?? [];
    const events = input.events ?? [];
    const nowMs = input.evaluationTimeMs ?? Date.now();

    const sourceCredibility =
      articles.length > 0
        ? Math.round(articles.reduce((s, a) => s + a.credibilityScore, 0) / articles.length)
        : events.length > 0
          ? 90
          : 0;

    const maxEventImp = events.reduce((m, e) => Math.max(m, IMPORTANCE_SCORE[e.importance] ?? 50), 0);
    const maxNewsImp = articles.reduce((m, a) => Math.max(m, IMPORTANCE_SCORE[a.importance] ?? 35), 0);
    const eventImportance = Math.max(maxEventImp, maxNewsImp);

    const newsRelevance =
      articles.length > 0
        ? Math.round(Math.max(...articles.map((a) => a.relevanceScore)))
        : events.length > 0
          ? 85
          : 0;

    let dirSum = 0;
    let dirCount = 0;
    let hasConflict = false;
    let seenBullish = false;
    let seenBearish = false;

    for (const a of articles) {
      const mapped = input.symbol ? a.affectedInstruments.find((inst) => inst.symbol === input.symbol) : undefined;
      const bias = mapped ? mapped.directionHypothesis : a.directionBias;
      if (bias === "conflicting") hasConflict = true;
      else if (bias === "bullish") {
        seenBullish = true;
        dirSum += 75;
        dirCount += 1;
      } else if (bias === "bearish") {
        seenBearish = true;
        dirSum -= 75;
        dirCount += 1;
      }
    }
    for (const ev of events) {
      if (ev.surprise.hasActualAndConsensus) {
        const isUsdHawkishPrint =
          ev.currency === "USD" &&
          (ev.category === "inflation_announcements" || ev.category === "central_bank_decisions");
        const usdIsQuote =
          input.symbol !== undefined &&
          (input.symbol === "EUR_USD" ||
            input.symbol === "GBP_USD" ||
            input.symbol === "XAU_USD" ||
            input.symbol.endsWith("USDT"));
        const invertForSymbol = isUsdHawkishPrint && usdIsQuote;

        if (ev.surprise.direction === "above_consensus") {
          const score = invertForSymbol ? -80 : 80;
          if (score > 0) seenBullish = true;
          else seenBearish = true;
          dirSum += score;
          dirCount += 1;
        } else if (ev.surprise.direction === "below_consensus") {
          const score = invertForSymbol ? 80 : -80;
          if (score > 0) seenBullish = true;
          else seenBearish = true;
          dirSum += score;
          dirCount += 1;
        }
      }
    }
    if (seenBullish && seenBearish) {
      hasConflict = true;
    }
    const directionalEvidence = hasConflict ? 0 : dirCount > 0 ? Math.max(-100, Math.min(100, Math.round(dirSum / dirCount))) : 0;

    let eventRisk = 15;
    for (const ev of events) {
      if (ev.scheduledAt) {
        const diffMin = Math.abs(ev.scheduledAt.getTime() - nowMs) / 60_000;
        if (diffMin <= 15 && (ev.importance === "high" || ev.importance === "critical")) {
          eventRisk = Math.max(eventRisk, 95);
        } else if (diffMin <= 60 && (ev.importance === "high" || ev.importance === "critical")) {
          eventRisk = Math.max(eventRisk, 75);
        }
      }
    }
    if (hasConflict) eventRisk = Math.max(eventRisk, 80);
    if (articles.some((a) => a.importance === "critical")) eventRisk = Math.max(eventRisk, 90);

    return {
      sourceCredibility,
      eventImportance,
      newsRelevance,
      directionalEvidence,
      technicalSetupQuality: Math.max(0, Math.min(100, Math.round(input.technicalQualityScore ?? 0))),
      marketConfirmation: Math.max(0, Math.min(100, Math.round(input.marketConfirmationScore ?? 0))),
      eventRisk,
      formulaVersion: "evidence-7d-v1",
      calibrationNote: EVIDENCE_FORMULA_SPEC.disclaimer
    };
  }

  /**
   * Part 9: Correlates a Technical Signal with News & Global Events without ever altering
   * the technical strategy's entry, stop-loss, or take-profit prices, and never approving
   * a signal that failed quantitative validation.
   */
  static correlateTechnicalSignal(
    signal: TechnicalSignalSnapshot,
    articles: NormalizedNewsArticle[],
    events: NormalizedGlobalEvent[],
    evaluationTimeMs = signal.publishedAtMs
  ): SignalFusionContext {
    const symbolArticles = articles.filter((a) =>
      a.affectedInstruments.some((inst) => inst.symbol === signal.symbol)
    );
    const symbolEvents = events.filter((e) =>
      e.affectedAssets.some((asset) => asset.symbol === signal.symbol)
    );

    const dimensions = this.computeEvidenceDimensions({
      symbol: signal.symbol,
      articles: symbolArticles,
      events: symbolEvents,
      technicalQualityScore: signal.qualityScore,
      marketConfirmationScore: signal.quantitativeValid ? 80 : 0,
      evaluationTimeMs
    });

    const rationale: string[] = [];
    let alignmentStatus: SignalFusionContext["alignmentStatus"] = "neutral";
    let recommendation: SignalFusionContext["recommendation"] = "PROCEED_QUANTITATIVE_ONLY";

    // Hard rule: AI/intelligence layer can NEVER approve a signal that failed quantitative validation
    if (!signal.quantitativeValid) {
      return {
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        originalStrategyKey: signal.strategyKey,
        originalStrategyVersion: signal.strategyVersion,
        preservedPrices: {
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          targets: [...signal.targets],
          rewardRisk: signal.rewardRisk
        },
        quantitativeAuthorityApproved: false,
        alignmentStatus: "conflicting",
        eventRiskLevel: "extreme",
        recommendation: "REJECT_DETERMINISTIC_EVENT_BLACKOUT",
        dimensions,
        nearbyEventKeys: symbolEvents.map((e) => e.dedupeKey),
        relatedArticleHashes: symbolArticles.map((a) => a.contentHash),
        rationale: ["Quantitative validation failed; central intelligence cannot override quantitative rejection."]
      };
    }

    // Check deterministic pre-event blackout window (within 15m of high/critical scheduled event)
    const blackoutEvent = symbolEvents.find((ev) => {
      if (!ev.scheduledAt || (ev.importance !== "high" && ev.importance !== "critical")) return false;
      const minutesToRelease = (ev.scheduledAt.getTime() - evaluationTimeMs) / 60_000;
      return minutesToRelease >= -5 && minutesToRelease <= 15;
    });

    if (blackoutEvent) {
      alignmentStatus = "event_blackout_risk";
      recommendation = "REJECT_DETERMINISTIC_EVENT_BLACKOUT";
      rationale.push(
        `High-impact event (${blackoutEvent.eventName}) is within the 15-minute blackout window for ${signal.symbol}.`
      );
    } else if (
      (signal.direction === "LONG" && dimensions.directionalEvidence <= -40) ||
      (signal.direction === "SHORT" && dimensions.directionalEvidence >= 40)
    ) {
      alignmentStatus = "conflicting";
      recommendation = "FLAG_CONFLICTING_EVIDENCE";
      rationale.push(
        `Technical ${signal.direction} setup on ${signal.symbol} conflicts with opposing news/event directional evidence (${dimensions.directionalEvidence}).`
      );
    } else if (dimensions.eventRisk >= 75) {
      alignmentStatus = "neutral";
      recommendation = "RECOMMEND_ADDITIONAL_OBSERVATION";
      rationale.push(`Elevated event/news risk (${dimensions.eventRisk}/100) surrounding ${signal.symbol}; additional observation advised.`);
    } else if (
      (signal.direction === "LONG" && dimensions.directionalEvidence >= 40) ||
      (signal.direction === "SHORT" && dimensions.directionalEvidence <= -40)
    ) {
      alignmentStatus = "aligned";
      recommendation = "ALIGNED_EVIDENCE";
      rationale.push(
        `Independent news/event directional evidence (${dimensions.directionalEvidence}) aligns with technical ${signal.direction} setup.`
      );
    } else {
      rationale.push("No conflicting high-impact event or news detected; quantitative setup stands on technical merit.");
    }

    const eventRiskLevel: SignalFusionContext["eventRiskLevel"] =
      dimensions.eventRisk >= 85
        ? "extreme"
        : dimensions.eventRisk >= 65
          ? "elevated"
          : dimensions.eventRisk >= 35
            ? "moderate"
            : "low";

    return {
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      originalStrategyKey: signal.strategyKey,
      originalStrategyVersion: signal.strategyVersion,
      preservedPrices: {
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        targets: [...signal.targets],
        rewardRisk: signal.rewardRisk
      },
      quantitativeAuthorityApproved: true,
      alignmentStatus,
      eventRiskLevel,
      recommendation,
      dimensions,
      nearbyEventKeys: symbolEvents.map((e) => e.dedupeKey),
      relatedArticleHashes: symbolArticles.map((a) => a.contentHash),
      rationale
    };
  }

  static generateIntelligenceReport(input: {
    reportType: "daily_summary" | "event_risk_brief" | "cross_asset_intelligence";
    articles: NormalizedNewsArticle[];
    events: NormalizedGlobalEvent[];
    eventSignals?: EventSignalEvaluationOutput[];
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const dateKey = now.toISOString().slice(0, 13);
    const highImpactEvents = input.events.filter((e) => e.importance === "high" || e.importance === "critical");
    const criticalNews = input.articles.filter((a) => a.importance === "high" || a.importance === "critical");

    const riskWarnings: string[] = [];
    if (highImpactEvents.length > 0) {
      riskWarnings.push(
        `${highImpactEvents.length} high/critical scheduled event(s) active or upcoming: ${highImpactEvents.map((e) => e.eventName).join(", ")}.`
      );
    }
    if (input.articles.some((a) => a.directionBias === "conflicting")) {
      riskWarnings.push("Conflicting media reports detected in current news window; verify primary official releases.");
    }

    const marketRegime =
      highImpactEvents.some((e) => e.status === "awaiting_release" || e.status === "monitoring_reaction")
        ? "event_driven_volatility"
        : criticalNews.length > 0
          ? "news_sensitive"
          : "technical_dominant";

    return {
      reportKey: `${input.reportType}:${dateKey}`,
      reportType: input.reportType,
      title: `Signal Engine Market & Event Intelligence (${input.reportType.replaceAll("_", " ")})`,
      summary: `Processed ${input.articles.length} verified news item(s) and ${input.events.length} global/economic event(s). Current regime: ${marketRegime}.`,
      marketRegime,
      sections: [
        {
          heading: "Major News Developments",
          items: input.articles.slice(0, 10).map((a) => ({
            title: a.title,
            category: a.category,
            importance: a.importance,
            credibilityScore: a.credibilityScore,
            affectedSymbols: a.affectedInstruments.map((i) => i.symbol)
          }))
        },
        {
          heading: "Global & Economic Events",
          items: input.events.slice(0, 10).map((e) => ({
            eventName: e.eventName,
            category: e.category,
            importance: e.importance,
            status: e.status,
            scheduledAt: e.scheduledAt?.toISOString() ?? null,
            surprise: e.surprise,
            affectedSymbols: e.affectedAssets.map((a) => a.symbol)
          }))
        },
        {
          heading: "Event Trading Setups Evaluated",
          items: (input.eventSignals ?? []).slice(0, 10).map((s) => ({
            strategyKey: s.strategyKey,
            symbol: s.symbol,
            actionClassification: s.actionClassification,
            validationStatus: s.validationStatus,
            riskClassification: s.riskClassification,
            rejectionReason: s.rejectionReason ?? null
          }))
        }
      ],
      evidenceRefs: [
        ...input.articles.slice(0, 10).map((a) => ({ type: "news_article", ref: a.contentHash, url: a.url })),
        ...input.events.slice(0, 10).map((e) => ({ type: "economic_event", ref: e.dedupeKey }))
      ],
      riskWarnings,
      generatedAt: now
    };
  }
}
