import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { listCandles, listInstruments } from "@signal-engine/database/repository";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

@Controller("instruments")
export class InstrumentsController {
  @Get()
  async list(@Query("market") market?: string, @Query("enabled") enabled?: string) {
    if (market !== undefined && !["crypto_perpetual", "forex"].includes(market)) throw new BadRequestException("Unsupported market");
    const enabledFilter = enabled === undefined ? undefined : enabled === "true" ? true : enabled === "false" ? false : undefined;
    if (enabled !== undefined && enabledFilter === undefined) throw new BadRequestException("enabled must be true or false");
    const data = await listInstruments({ market, enabled: enabledFilter });
    return { data, total: data.length };
  }

  @Get(":provider/:symbol/candles")
  async candles(@Param("provider") provider: string, @Param("symbol") symbol: string, @Query("timeframe") timeframe = "5m", @Query("limit") limit = "200", @Query("before") before?: string) {
    if (!["binance_usdm", "oanda_v20"].includes(provider)) throw new BadRequestException("Unsupported provider");
    if (!/^[A-Z0-9_]{5,20}$/.test(symbol)) throw new BadRequestException("Invalid symbol");
    if (!TIMEFRAMES.includes(timeframe)) throw new BadRequestException("Unsupported timeframe");
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) throw new BadRequestException("limit must be an integer from 1 to 500");
    const beforeDate = before === undefined ? undefined : new Date(before);
    if (beforeDate && !Number.isFinite(beforeDate.getTime())) throw new BadRequestException("before must be an ISO timestamp");
    const result = await listCandles({ provider, symbol, timeframe, limit: parsedLimit, before: beforeDate });
    if (!result) throw new NotFoundException("Instrument not found");
    return { instrument: result.instrument, timeframe, data: result.candles, total: result.candles.length };
  }
}
