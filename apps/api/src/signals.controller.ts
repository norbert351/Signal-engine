import { Controller, Get, Query } from "@nestjs/common";
@Controller("signals")
export class SignalsController {
 @Get()
 list(@Query("market") market?: string, @Query("symbol") symbol?: string, @Query("status") status?: string) {
  return { data: [], filters: { market: market ?? null, symbol: symbol ?? null, status: status ?? null }, total: 0, state: "scaffold" };
 }
}
