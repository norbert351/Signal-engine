import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import {
  EventBacktestService,
  EventNormalizationService,
  PostEventMomentumService,
  PostEventReversalService,
  PreEventPositioningService,
  type Candle,
  type EventStrategyKey,
  type RawGlobalEventInput
} from "@signal-engine/core";
import {
  listEventBacktestRuns,
  listEventSignals,
  listEventStrategies,
  persistEventBacktestRun,
  persistEventSignal
} from "@signal-engine/database/intelligence-repository";
import { AdminGuard } from "./admin.guard.js";

const VALID_EVENT_STRATEGIES: EventStrategyKey[] = [
  "pre-event-positioning",
  "post-event-momentum",
  "post-event-reversal"
];

@Controller()
export class EventTradingController {
  @Get("event-signals")
  async listSignals(
    @Query("symbol") symbol?: string,
    @Query("strategyKey") strategyKey?: string,
    @Query("validationStatus") validationStatus?: string,
    @Query("outcomeStatus") outcomeStatus?: string,
    @Query("limit") limit = "50"
  ) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new BadRequestException("limit must be an integer from 1 to 200");
    }
    if (symbol !== undefined && !/^[A-Z0-9_]{5,20}$/.test(symbol)) {
      throw new BadRequestException("Invalid symbol");
    }
    const data = await listEventSignals({
      symbol,
      strategyKey,
      validationStatus,
      outcomeStatus,
      limit: parsedLimit
    });
    return { data, total: data.length };
  }

  @Get("event-strategies")
  async strategies() {
    const data = await listEventStrategies();
    return { data, total: data.length };
  }

  @Get("event-strategies/backtests")
  async backtests(@Query("limit") limit = "50") {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new BadRequestException("limit must be an integer from 1 to 200");
    }
    const data = await listEventBacktestRuns(parsedLimit);
    return { data, total: data.length };
  }

  @Post("event-signals/evaluate")
  @UseGuards(AdminGuard)
  async evaluateSetup(
    @Body()
    body: {
      strategyKey?: unknown;
      symbol?: unknown;
      market?: unknown;
      timeframe?: unknown;
      confirmationTimeframe?: unknown;
      event?: Partial<RawGlobalEventInput>;
      entryCandles?: Candle[];
      confirmationCandles?: Candle[];
      observedSpreadBps?: number;
    }
  ) {
    if (
      typeof body.strategyKey !== "string" ||
      !VALID_EVENT_STRATEGIES.includes(body.strategyKey as EventStrategyKey)
    ) {
      throw new BadRequestException("strategyKey must be pre-event-positioning, post-event-momentum, or post-event-reversal");
    }
    if (typeof body.symbol !== "string" || !/^[A-Z0-9_]{5,20}$/.test(body.symbol)) {
      throw new BadRequestException("Valid symbol is required");
    }
    if (!body.event || typeof body.event.eventName !== "string") {
      throw new BadRequestException("Valid event object is required");
    }
    if (!Array.isArray(body.entryCandles) || !Array.isArray(body.confirmationCandles)) {
      throw new BadRequestException("entryCandles and confirmationCandles arrays are required");
    }

    const normalizedEvent = EventNormalizationService.normalizeEvent({
      sourceKey: body.event.sourceKey ?? "official_central_bank_calendar",
      eventName: body.event.eventName,
      ...(body.event.country ? { country: body.event.country } : {}),
      ...(body.event.currency ? { currency: body.event.currency } : {}),
      ...(body.event.scheduledAt !== undefined ? { scheduledAt: body.event.scheduledAt } : {}),
      ...(body.event.publishedAt !== undefined ? { publishedAt: body.event.publishedAt } : {}),
      ...(body.event.previousValue !== undefined ? { previousValue: body.event.previousValue } : {}),
      ...(body.event.consensusValue !== undefined ? { consensusValue: body.event.consensusValue } : {}),
      ...(body.event.actualValue !== undefined ? { actualValue: body.event.actualValue } : {})
    });

    const market = body.market === "forex" || body.symbol.includes("_") ? ("forex" as const) : ("crypto_perpetual" as const);
    const timeframe = typeof body.timeframe === "string" ? body.timeframe : "15m";
    const confirmationTimeframe = typeof body.confirmationTimeframe === "string" ? body.confirmationTimeframe : "1h";

    const evalInput = {
      event: normalizedEvent,
      symbol: body.symbol,
      market,
      timeframe,
      confirmationTimeframe,
      entryCandles: body.entryCandles,
      confirmationCandles: body.confirmationCandles,
      instrumentAvailable: body.symbol !== "TONUSDT",
      ...(typeof body.observedSpreadBps === "number" ? { observedSpreadBps: body.observedSpreadBps } : {})
    };

    const evaluated =
      body.strategyKey === "pre-event-positioning"
        ? PreEventPositioningService.evaluate(evalInput)
        : body.strategyKey === "post-event-momentum"
          ? PostEventMomentumService.evaluate(evalInput)
          : PostEventReversalService.evaluate(evalInput);

    const saved = await persistEventSignal({
      dedupeKey: `api:${normalizedEvent.dedupeKey}:${body.symbol}:${timeframe}:${body.strategyKey}:${evaluated.triggerCloseTime}`,
      strategyKey: evaluated.strategyKey,
      strategyType: evaluated.strategyType,
      eventCategory: normalizedEvent.category,
      eventName: normalizedEvent.eventName,
      symbol: body.symbol,
      market,
      timeframe,
      confirmationTimeframe,
      direction: evaluated.direction,
      actionClassification: evaluated.actionClassification,
      entryPrice: evaluated.entryPrice,
      stopLoss: evaluated.stopLoss,
      targets: evaluated.targets,
      rewardRisk: evaluated.rewardRisk,
      eventImportance: normalizedEvent.importance,
      riskClassification: evaluated.riskClassification,
      scheduledEventAt: normalizedEvent.scheduledAt,
      actualEventAt: normalizedEvent.publishedAt,
      sourceReferences: normalizedEvent.verifiedEvidence.map((v) => v.sourceUrl),
      quantitativeEvidence: evaluated.quantitativeEvidence,
      scoreBreakdown: { rationale: evaluated.rationale, strategyEnabled: false, strategyApproved: false },
      validationStatus: evaluated.validationStatus,
      ...(evaluated.rejectionReason ? { rejectionReason: evaluated.rejectionReason } : {}),
      outcomeStatus: evaluated.outcomeStatus,
      estimatedSlippageBps: evaluated.estimatedSlippageBps,
      expiresAt: new Date(evaluated.expiresAtMs)
    });

    return { evaluated, signal: saved };
  }

  @Post("event-strategies/backtests")
  @UseGuards(AdminGuard)
  async runEventBacktest(
    @Body()
    body: {
      strategyKey?: unknown;
      symbol?: unknown;
      market?: unknown;
      timeframe?: unknown;
      confirmationTimeframe?: unknown;
      events?: Array<Partial<RawGlobalEventInput>>;
      entryCandles?: Candle[];
      confirmationCandles?: Candle[];
      costs?: { feeBpsPerSide?: number; spreadBps?: number; slippageBps?: number };
    }
  ) {
    if (
      typeof body.strategyKey !== "string" ||
      !VALID_EVENT_STRATEGIES.includes(body.strategyKey as EventStrategyKey)
    ) {
      throw new BadRequestException("Invalid event strategyKey");
    }
    if (typeof body.symbol !== "string" || !/^[A-Z0-9_]{5,20}$/.test(body.symbol)) {
      throw new BadRequestException("Valid symbol is required");
    }
    if (!Array.isArray(body.events) || !Array.isArray(body.entryCandles) || !Array.isArray(body.confirmationCandles)) {
      throw new BadRequestException("events, entryCandles, and confirmationCandles arrays are required");
    }
    if (
      !body.costs ||
      typeof body.costs.feeBpsPerSide !== "number" ||
      typeof body.costs.spreadBps !== "number" ||
      typeof body.costs.slippageBps !== "number"
    ) {
      throw new BadRequestException("Explicit costs (feeBpsPerSide, spreadBps, slippageBps) are required");
    }

    const normalizedEvents = body.events.map((e) =>
      EventNormalizationService.normalizeEvent({
        sourceKey: e.sourceKey ?? "official_central_bank_calendar",
        eventName: e.eventName ?? "Scheduled Event",
        ...(e.country ? { country: e.country } : {}),
        ...(e.currency ? { currency: e.currency } : {}),
        ...(e.scheduledAt !== undefined ? { scheduledAt: e.scheduledAt } : {}),
        ...(e.publishedAt !== undefined ? { publishedAt: e.publishedAt } : {}),
        ...(e.previousValue !== undefined ? { previousValue: e.previousValue } : {}),
        ...(e.consensusValue !== undefined ? { consensusValue: e.consensusValue } : {}),
        ...(e.actualValue !== undefined ? { actualValue: e.actualValue } : {})
      })
    );

    const market = body.market === "forex" || body.symbol.includes("_") ? ("forex" as const) : ("crypto_perpetual" as const);
    const timeframe = typeof body.timeframe === "string" ? body.timeframe : "15m";
    const confirmationTimeframe = typeof body.confirmationTimeframe === "string" ? body.confirmationTimeframe : "1h";

    const result = EventBacktestService.runBacktest({
      strategyKey: body.strategyKey as EventStrategyKey,
      symbol: body.symbol,
      market,
      timeframe,
      confirmationTimeframe,
      events: normalizedEvents,
      entryCandles: body.entryCandles,
      confirmationCandles: body.confirmationCandles,
      costs: {
        feeBpsPerSide: body.costs.feeBpsPerSide,
        spreadBps: body.costs.spreadBps,
        slippageBps: body.costs.slippageBps
      }
    });

    const saved = await persistEventBacktestRun({
      strategyKey: result.strategyKey,
      symbol: result.symbol,
      timeframe: result.timeframe,
      dataset: { eventsCount: normalizedEvents.length, entryBars: body.entryCandles.length },
      assumptions: { ...body.costs, explicit: true },
      parameters: {},
      metrics: {
        totalEvents: result.totalEvents,
        eligibleEvents: result.eligibleEvents,
        signalsGenerated: result.signalsGenerated,
        rejectedSetups: result.rejectedSetups,
        overall: result.overall,
        train: result.train,
        validation: result.validation,
        outOfSample: result.outOfSample,
        byCategory: result.byCategory,
        byVolatilityRegime: result.byVolatilityRegime,
        promotionClassification: result.promotionClassification
      },
      trades: result.trades
    });

    return { run: saved, result };
  }
}
