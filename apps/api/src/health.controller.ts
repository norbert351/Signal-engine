import { Controller, Get } from "@nestjs/common";
import { sql } from "@signal-engine/database";
@Controller("health")
export class HealthController {
 @Get()
 async getHealth(){await sql`select 1`;return {status:"ok",service:"signal-engine-api",timestamp:new Date().toISOString(),database:"ok",tradingExecution:false};}
}
