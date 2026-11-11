import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { decodeCursor, getSignalDetail, listSignalsPage } from "@signal-engine/database/repository";

const STATUSES = ["PENDING", "ACTIVE", "PARTIALLY_FILLED", "TARGET_1_HIT", "TARGET_2_HIT", "STOP_LOSS_HIT", "EXPIRED", "INVALIDATED", "CLOSED"];
const DIRECTIONS = ["LONG", "SHORT"];
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

function parseDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new BadRequestException(`${name} must be an ISO timestamp`);
  return parsed;
}

@Controller("signals")
export class SignalsController {
  @Get()
  async list(
    @Query("market") market?: string,
    @Query("symbol") symbol?: string,
    @Query("status") status?: string,
    @Query("direction") direction?: string,
    @Query("strategyKey") strategyKey?: string,
    @Query("timeframe") timeframe?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string
  ) {
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) throw new BadRequestException("limit must be an integer from 1 to 100");
    if (status !== undefined && !STATUSES.includes(status)) throw new BadRequestException("Unsupported status");
    if (direction !== undefined && !DIRECTIONS.includes(direction)) throw new BadRequestException("Unsupported direction");
    if (timeframe !== undefined && !TIMEFRAMES.includes(timeframe)) throw new BadRequestException("Unsupported timeframe");
    if (symbol !== undefined && !/^[A-Z0-9_]{5,20}$/.test(symbol)) throw new BadRequestException("Invalid symbol");
    const fromDate = parseDate(from, "from");
    const toDate = parseDate(to, "to");
    if (fromDate && toDate && fromDate > toDate) throw new BadRequestException("from must be before to");
    let decoded;
    try { decoded = cursor === undefined ? undefined : decodeCursor(cursor); } catch { throw new BadRequestException("Invalid cursor"); }
    const page = await listSignalsPage({ market, symbol, status, direction, strategyKey, timeframe, from: fromDate, to: toDate, cursor: decoded, limit: parsedLimit });
    return { data: page.data, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null, filters: { market: market ?? null, symbol: symbol ?? null, status: status ?? null, direction: direction ?? null, strategyKey: strategyKey ?? null, timeframe: timeframe ?? null, from: fromDate?.toISOString() ?? null, to: toDate?.toISOString() ?? null } };
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException("Invalid signal id");
    const detail = await getSignalDetail(id);
    if (!detail) throw new NotFoundException("Signal not found");
    return detail;
  }
}
