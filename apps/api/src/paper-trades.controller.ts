import { Controller,Get,Query } from "@nestjs/common";
import { and,desc,eq } from "drizzle-orm";
import { db,paperTrades,signals } from "@signal-engine/database";
@Controller("paper-trades")
export class PaperTradesController {
 @Get() async list(@Query("status") status?:string){const rows=await db.select({trade:paperTrades,signal:signals}).from(paperTrades).innerJoin(signals,eq(paperTrades.signalId,signals.id)).where(status?eq(paperTrades.status,status):undefined).orderBy(desc(paperTrades.entryTime)).limit(200);return {data:rows,total:rows.length};}
}
