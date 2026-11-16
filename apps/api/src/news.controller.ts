import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { AiProviderRegistry, FastProcessingLayer, NewsIntelligenceService, type RawNewsArticleInput } from "@signal-engine/core";
import {
  listNewsArticles,
  listNewsEvents,
  listNewsSources,
  persistAiAnalysisRun,
  persistNormalizedNewsArticle
} from "@signal-engine/database/intelligence-repository";
import { AdminGuard } from "./admin.guard.js";

const newsService = new NewsIntelligenceService();

@Controller("news")
export class NewsController {
  @Get()
  async listArticles(
    @Query("category") category?: string,
    @Query("importance") importance?: string,
    @Query("limit") limit = "50"
  ) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new BadRequestException("limit must be an integer from 1 to 200");
    }
    if (importance !== undefined && !["low", "medium", "high", "critical"].includes(importance)) {
      throw new BadRequestException("Unsupported importance filter");
    }
    const data = await listNewsArticles({ category, importance, limit: parsedLimit });
    return { data, total: data.length, filters: { category: category ?? null, importance: importance ?? null } };
  }

  @Get("sources")
  async sources() {
    const data = await listNewsSources();
    return { data, total: data.length };
  }

  @Get("events")
  async events(
    @Query("category") category?: string,
    @Query("importance") importance?: string,
    @Query("symbol") symbol?: string,
    @Query("limit") limit = "50"
  ) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new BadRequestException("limit must be an integer from 1 to 200");
    }
    if (symbol !== undefined && !/^[A-Z0-9_]{5,20}$/.test(symbol)) {
      throw new BadRequestException("Invalid symbol");
    }
    const data = await listNewsEvents({ category, importance, symbol, limit: parsedLimit });
    return { data, total: data.length };
  }

  @Post()
  @UseGuards(AdminGuard)
  async ingest(@Body() body: Partial<RawNewsArticleInput>) {
    if (typeof body.sourceKey !== "string" || typeof body.url !== "string" || typeof body.title !== "string") {
      throw new BadRequestException("sourceKey, url, and title are required");
    }
    let normalized;
    try {
      normalized = newsService.normalizeArticle({
        sourceKey: body.sourceKey,
        url: body.url,
        title: body.title,
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
        ...(typeof body.contentSnippet === "string" ? { contentSnippet: body.contentSnippet } : {}),
        ...(typeof body.author === "string" ? { author: body.author } : {}),
        publishedAt: body.publishedAt ?? new Date().toISOString()
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid article payload");
    }

    const persisted = await persistNormalizedNewsArticle({
      ...normalized,
      entities: normalized.entities,
      facts: normalized.facts as unknown as Array<Record<string, unknown>>,
      affectedInstruments: normalized.affectedInstruments
    });

    const layer1 = FastProcessingLayer.processArticle(normalized, persisted.isDuplicate);
    let aiValidationStatus: string | null = null;
    if (layer1.eligibleForLayer2) {
      const { output, runRecord } = await AiProviderRegistry.runLayer2Analysis([normalized]);
      await persistAiAnalysisRun({
        articleId: persisted.article.id,
        ...(persisted.newsEvent ? { newsEventId: persisted.newsEvent.id } : {}),
        providerKey: runRecord.providerKey,
        modelName: runRecord.modelName,
        taskLayer: runRecord.taskLayer,
        taskKey: runRecord.taskKey,
        promptVersion: runRecord.promptVersion,
        inputSnapshot: runRecord.inputSnapshot,
        outputPayload: runRecord.outputPayload,
        validation: runRecord.validation,
        durationMs: runRecord.durationMs,
        inputTokens: runRecord.inputTokens,
        outputTokens: runRecord.outputTokens,
        estimatedCostUsd: runRecord.estimatedCostUsd,
        structuredFacts: output.observedFacts as unknown as Array<Record<string, unknown>>,
        interpretations: output.interpretations as unknown as Array<Record<string, unknown>>,
        scenarios: output.possibleScenarios as unknown as Array<Record<string, unknown>>,
        affectedAssets: normalized.affectedInstruments as unknown as Array<Record<string, unknown>>
      });
      aiValidationStatus = runRecord.validation.status;
    }

    return {
      article: persisted.article,
      isDuplicate: persisted.isDuplicate,
      isStoryUpdate: persisted.isUpdate,
      newsEvent: persisted.newsEvent,
      layer1,
      aiValidationStatus
    };
  }
}
