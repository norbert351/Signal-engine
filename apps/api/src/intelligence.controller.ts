import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import {
  AiProviderRegistry,
  CentralIntelligenceService,
  EVIDENCE_FORMULA_SPEC,
  EventNormalizationService,
  NewsIntelligenceService,
  type TechnicalSignalSnapshot
} from "@signal-engine/core";
import {
  listAiAnalyses,
  listEconomicEvents,
  listEventSignals,
  listIntelligenceReports,
  listNewsArticles,
  listNewsEvents,
  listSignalContextRecords,
  persistIntelligenceReportRecord,
  persistSignalContextRecord
} from "@signal-engine/database/intelligence-repository";
import { AdminGuard } from "./admin.guard.js";

const newsService = new NewsIntelligenceService();

@Controller()
export class IntelligenceController {
  @Get("ai/analyses")
  async aiAnalyses(@Query("limit") limit = "50") {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new BadRequestException("limit must be an integer from 1 to 200");
    }
    const dbData = await listAiAnalyses(parsedLimit);
    return {
      ...dbData,
      providers: AiProviderRegistry.listProviders()
    };
  }

  @Get("intelligence")
  async overview(@Query("symbol") symbol?: string) {
    if (symbol !== undefined && !/^[A-Z0-9_]{5,20}$/.test(symbol)) {
      throw new BadRequestException("Invalid symbol");
    }
    const [newsEvs, econEvs, evSignals, contexts, reports] = await Promise.all([
      listNewsEvents({ symbol, limit: 20 }),
      listEconomicEvents({ limit: 20 }),
      listEventSignals({ symbol, limit: 20 }),
      listSignalContextRecords(symbol, 20),
      listIntelligenceReports(10)
    ]);

    return {
      evidenceFormulaSpec: EVIDENCE_FORMULA_SPEC,
      aiProviders: AiProviderRegistry.listProviders(),
      newsEvents: newsEvs,
      economicEvents: econEvs,
      eventSignals: evSignals,
      signalContexts: contexts,
      latestReports: reports
    };
  }

  @Get("intelligence/reports")
  async reports(@Query("limit") limit = "30") {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new BadRequestException("limit must be an integer from 1 to 100");
    }
    const data = await listIntelligenceReports(parsedLimit);
    return { data, total: data.length };
  }

  @Post("intelligence/correlate")
  @UseGuards(AdminGuard)
  async correlateSignal(@Body() body: { signal?: Partial<TechnicalSignalSnapshot> }) {
    const sig = body.signal;
    if (
      !sig ||
      typeof sig.symbol !== "string" ||
      typeof sig.timeframe !== "string" ||
      typeof sig.strategyKey !== "string" ||
      (sig.direction !== "LONG" && sig.direction !== "SHORT") ||
      typeof sig.entry !== "number" ||
      typeof sig.stopLoss !== "number" ||
      !Array.isArray(sig.targets)
    ) {
      throw new BadRequestException("Valid technical signal snapshot is required");
    }

    const [articlesRaw, eventsRaw] = await Promise.all([
      listNewsArticles({ limit: 30 }),
      listEconomicEvents({ limit: 30 })
    ]);

    const normalizedArticles = articlesRaw.map((a) =>
      newsService.normalizeArticle({
        sourceKey: "federal_reserve_rss",
        url: a.url,
        title: a.title,
        summary: a.summary ?? "",
        publishedAt: a.publishedAt,
        collectedAt: a.collectedAt
      })
    );
    const normalizedEvents = eventsRaw
      .filter((e) => e.scheduledAt !== null)
      .map((e) =>
        EventNormalizationService.normalizeEvent({
          sourceKey: "official_central_bank_calendar",
          eventName: e.eventName,
          country: e.country,
          currency: e.currency,
          scheduledAt: e.scheduledAt,
          publishedAt: e.publishedAt,
          previousValue: e.previousValue !== null ? Number(e.previousValue) : null,
          consensusValue: e.consensusValue !== null ? Number(e.consensusValue) : null,
          actualValue: e.actualValue !== null ? Number(e.actualValue) : null
        })
      );

    const fused = CentralIntelligenceService.correlateTechnicalSignal(
      {
        ...(sig.id ? { id: sig.id } : {}),
        symbol: sig.symbol,
        market: sig.symbol.includes("_") ? "forex" : "crypto_perpetual",
        timeframe: sig.timeframe,
        strategyKey: sig.strategyKey,
        strategyVersion: sig.strategyVersion ?? 1,
        direction: sig.direction,
        entry: sig.entry,
        stopLoss: sig.stopLoss,
        targets: sig.targets,
        rewardRisk: sig.rewardRisk ?? 2.0,
        qualityScore: sig.qualityScore ?? 75,
        quantitativeValid: sig.quantitativeValid ?? true,
        publishedAtMs: sig.publishedAtMs ?? Date.now()
      },
      normalizedArticles,
      normalizedEvents
    );

    const saved = await persistSignalContextRecord({
      ...(sig.id ? { technicalSignalId: sig.id } : {}),
      symbol: fused.symbol,
      timeframe: fused.timeframe,
      alignmentStatus: fused.alignmentStatus,
      eventRiskLevel: fused.eventRiskLevel,
      recommendation: fused.recommendation,
      evidenceDimensions: fused.dimensions as unknown as Record<string, unknown>,
      nearbyEventIds: fused.nearbyEventKeys,
      relatedNewsIds: fused.relatedArticleHashes,
      rationale: fused.rationale
    });

    return { context: fused, record: saved };
  }

  @Post("intelligence/reports")
  @UseGuards(AdminGuard)
  async generateReport(@Body() body: { reportType?: "daily_summary" | "event_risk_brief" | "cross_asset_intelligence" }) {
    const reportType = body.reportType ?? "daily_summary";
    if (!["daily_summary", "event_risk_brief", "cross_asset_intelligence"].includes(reportType)) {
      throw new BadRequestException("Unsupported reportType");
    }

    const [articlesRaw, eventsRaw] = await Promise.all([
      listNewsArticles({ limit: 25 }),
      listEconomicEvents({ limit: 25 })
    ]);

    const normalizedArticles = articlesRaw.map((a) =>
      newsService.normalizeArticle({
        sourceKey: "federal_reserve_rss",
        url: a.url,
        title: a.title,
        summary: a.summary ?? "",
        publishedAt: a.publishedAt,
        collectedAt: a.collectedAt
      })
    );
    const normalizedEvents = eventsRaw
      .filter((e) => e.scheduledAt !== null)
      .map((e) =>
        EventNormalizationService.normalizeEvent({
          sourceKey: "official_central_bank_calendar",
          eventName: e.eventName,
          country: e.country,
          currency: e.currency,
          scheduledAt: e.scheduledAt,
          publishedAt: e.publishedAt,
          previousValue: e.previousValue !== null ? Number(e.previousValue) : null,
          consensusValue: e.consensusValue !== null ? Number(e.consensusValue) : null,
          actualValue: e.actualValue !== null ? Number(e.actualValue) : null
        })
      );

    const draft = CentralIntelligenceService.generateIntelligenceReport({
      reportType,
      articles: normalizedArticles,
      events: normalizedEvents
    });

    const saved = await persistIntelligenceReportRecord({
      reportKey: draft.reportKey,
      reportType: draft.reportType,
      title: draft.title,
      summary: draft.summary,
      marketRegime: draft.marketRegime,
      sections: draft.sections as Array<Record<string, unknown>>,
      evidenceRefs: draft.evidenceRefs,
      riskWarnings: draft.riskWarnings
    });

    return saved;
  }
}
