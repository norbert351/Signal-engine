import { Controller,Get } from "@nestjs/common";
import { db,systemHealth } from "@signal-engine/database";
@Controller("system")
export class SystemController {
 @Get("health") async health(){const rows=await db.select().from(systemHealth);const now=Date.now();const components=rows.map(row=>({...row,effectiveStatus:now-row.checkedAt.getTime()>120_000?"stale":row.status}));const healthy=components.length>0&&components.every(row=>row.effectiveStatus==="ok");return {status:healthy?"ok":"degraded",api:"ok",components,checkedAt:new Date(now).toISOString()};}
}
