import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { listPaperTrades, paperTradeSummary } from "@signal-engine/database/paper-trade-repository";

@Controller("paper-trades")
export class PaperTradesController {
  @Get("summary")
  async summary() {
    return paperTradeSummary();
  }

  @Get()
  async list(@Query("status") status?: string, @Query("symbol") symbol?: string, @Query("limit") limit = "50", @Query("offset") offset = "0") {
    const parsedLimit = Number(limit);
    const parsedOffset = Number(offset);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) throw new BadRequestException("limit must be an integer from 1 to 200");
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) throw new BadRequestException("offset must be a non-negative integer");
    if (status !== undefined && !["OPEN", "PARTIALLY_FILLED", "CLOSED"].includes(status)) throw new BadRequestException("Unsupported status");
    if (symbol !== undefined && !/^[A-Z0-9_]{5,20}$/.test(symbol)) throw new BadRequestException("Invalid symbol");
    const data = await listPaperTrades({ status, symbol, limit: parsedLimit, offset: parsedOffset });
    return { data, total: data.length, limit: parsedLimit, offset: parsedOffset };
  }
}
