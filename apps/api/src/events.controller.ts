import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { EventNormalizationService, type RawGlobalEventInput } from "@signal-engine/core";
import {
  listEconomicEvents,
  listEventAssetMappings,
  persistNormalizedGlobalEvent
} from "@signal-engine/database/intelligence-repository";
import { AdminGuard } from "./admin.guard.js";

@Controller("events")
export class EventsController {
  @Get()
  async list(
    @Query("category") category?: string,
    @Query("importance") importance?: string,
    @Query("status") status?: string,
    @Query("country") country?: string,
    @Query("limit") limit = "50"
  ) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new BadRequestException("limit must be an integer from 1 to 200");
    }
    const data = await listEconomicEvents({ category, importance, status, country, limit: parsedLimit });
    return { data, total: data.length };
  }

  @Get("calendar")
  async calendar(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("importance") importance?: string,
    @Query("country") country?: string,
    @Query("limit") limit = "100"
  ) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new BadRequestException("limit must be an integer from 1 to 200");
    }
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    if (fromDate && !Number.isFinite(fromDate.getTime())) throw new BadRequestException("from must be a valid ISO date");
    if (toDate && !Number.isFinite(toDate.getTime())) throw new BadRequestException("to must be a valid ISO date");
    const data = await listEconomicEvents({ from: fromDate, to: toDate, importance, country, limit: parsedLimit });
    return { data, total: data.length };
  }

  @Get("impact")
  async impact(@Query("symbol") symbol?: string, @Query("category") category?: string) {
    if (symbol !== undefined && !/^[A-Z0-9_]{5,20}$/.test(symbol)) {
      throw new BadRequestException("Invalid symbol");
    }
    const mappings = await listEventAssetMappings(symbol, category);
    return { data: mappings, total: mappings.length };
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Body() body: Partial<RawGlobalEventInput>) {
    if (typeof body.sourceKey !== "string" || typeof body.eventName !== "string") {
      throw new BadRequestException("sourceKey and eventName are required");
    }
    let normalized;
    try {
      normalized = EventNormalizationService.normalizeEvent({
        sourceKey: body.sourceKey,
        eventName: body.eventName,
        ...(typeof body.country === "string" ? { country: body.country } : {}),
        ...(typeof body.currency === "string" ? { currency: body.currency } : {}),
        ...(body.scheduledAt !== undefined ? { scheduledAt: body.scheduledAt } : {}),
        ...(body.publishedAt !== undefined ? { publishedAt: body.publishedAt } : {}),
        ...(body.previousValue !== undefined ? { previousValue: body.previousValue } : {}),
        ...(body.revisedPreviousValue !== undefined ? { revisedPreviousValue: body.revisedPreviousValue } : {}),
        ...(body.consensusValue !== undefined ? { consensusValue: body.consensusValue } : {}),
        ...(body.actualValue !== undefined ? { actualValue: body.actualValue } : {}),
        ...(typeof body.unit === "string" ? { unit: body.unit } : {}),
        ...(body.isScheduled !== undefined ? { isScheduled: body.isScheduled } : {}),
        ...(Array.isArray(body.verifiedEvidence) ? { verifiedEvidence: body.verifiedEvidence } : {})
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid event payload");
    }

    const saved = await persistNormalizedGlobalEvent({
      ...normalized,
      verifiedEvidence: normalized.verifiedEvidence as unknown as Array<Record<string, unknown>>
    });
    return {
      event: saved,
      surprise: normalized.surprise,
      affectedAssets: normalized.affectedAssets
    };
  }
}
