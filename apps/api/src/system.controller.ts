import { BadRequestException, Body, ConflictException, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { requestBackfill, resetBackfill } from "@signal-engine/database/admin-repository";
import {
  applyRetention,
  backfillSummary,
  candleFreshness,
  listAlerts,
  listHealth,
  notificationBacklog
} from "@signal-engine/database/system-repository";
import { AdminGuard } from "./admin.guard.js";

const STALE_MS = Number(process.env.SYSTEM_STALE_SECONDS ?? "900") * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("system")
export class SystemController {
  @Get("health")
  async health() {
    const rows = await listHealth();
    const now = Date.now();
    const components = rows.map((row) => ({
      ...row,
      ageSeconds: Math.round((now - row.checkedAt.getTime()) / 1000),
      effectiveStatus: now - row.checkedAt.getTime() > STALE_MS ? "stale" : row.status
    }));
    const healthy = components.length > 0 && components.every((row) => row.effectiveStatus === "ok");
    return {
      status: healthy ? "ok" : "degraded",
      api: "ok",
      staleAfterSeconds: STALE_MS / 1000,
      components,
      checkedAt: new Date(now).toISOString()
    };
  }

  @Get("alerts")
  async alerts(@Query("includeResolved") includeResolved?: string, @Query("limit") limit = "100") {
    if (includeResolved !== undefined && !["true", "false"].includes(includeResolved)) throw new BadRequestException("includeResolved must be true or false");
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) throw new BadRequestException("limit must be an integer from 1 to 500");
    const data = await listAlerts(parsedLimit, includeResolved === "true");
    return { data, total: data.length };
  }

  @Get("candles")
  async candles() {
    const data = await candleFreshness();
    return { data, total: data.length };
  }

  @Get("notifications")
  async notifications() {
    return { data: await notificationBacklog() };
  }

  @Get("backfills")
  async backfills(@Query("limit") limit = "50") {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) throw new BadRequestException("limit must be an integer from 1 to 500");
    return backfillSummary(parsedLimit);
  }

  @Post("backfills")
  @UseGuards(AdminGuard)
  async createBackfill(
    @Body() body: { provider?: unknown; symbol?: unknown; timeframe?: unknown; start?: unknown; end?: unknown }
  ) {
    if (typeof body.provider !== "string" || typeof body.symbol !== "string" || typeof body.timeframe !== "string") {
      throw new BadRequestException("provider, symbol and timeframe are required");
    }
    if (!/^[A-Z0-9_]{5,20}$/.test(body.symbol)) throw new BadRequestException("Invalid symbol");
    if (typeof body.start !== "string" || typeof body.end !== "string") throw new BadRequestException("start and end ISO timestamps are required");
    const start = new Date(body.start);
    const end = new Date(body.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new BadRequestException("start must be before end");
    if (end.getTime() > Date.now() + 60_000) throw new BadRequestException("end must not be in the future");
    try {
      const row = await requestBackfill({ provider: body.provider, symbol: body.symbol, timeframe: body.timeframe, startTime: start, endTime: end });
      return row;
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : "Unable to request backfill");
    }
  }

  @Post("backfills/:id/reset")
  @UseGuards(AdminGuard)
  async resetBackfillJob(@Param("id") id: string) {
    if (!UUID.test(id)) throw new BadRequestException("Invalid backfill id");
    const row = await resetBackfill(id);
    if (!row) throw new ConflictException("Backfill job not found");
    return row;
  }

  @Post("retention")
  @UseGuards(AdminGuard)
  async retention(@Body() body: { deliveredNotificationDays?: unknown; resolvedAlertDays?: unknown }) {
    const delivered = body.deliveredNotificationDays === undefined ? undefined : Number(body.deliveredNotificationDays);
    const resolved = body.resolvedAlertDays === undefined ? undefined : Number(body.resolvedAlertDays);
    if (delivered !== undefined && (!Number.isInteger(delivered) || delivered < 1 || delivered > 3650)) throw new BadRequestException("deliveredNotificationDays must be 1..3650");
    if (resolved !== undefined && (!Number.isInteger(resolved) || resolved < 1 || resolved > 3650)) throw new BadRequestException("resolvedAlertDays must be 1..3650");
    return applyRetention({
      ...(delivered !== undefined ? { deliveredNotificationDays: delivered } : {}),
      ...(resolved !== undefined ? { resolvedAlertDays: resolved } : {})
    });
  }
}
