import { Controller,Get } from "@nestjs/common";
import { db,systemHealth } from "@signal-engine/database";
@Controller("system")
export class SystemController {
 @Get("health") async health(){const components=await db.select().from(systemHealth);return {api:"ok",components,checkedAt:new Date().toISOString()};}
}
