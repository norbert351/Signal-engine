import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "@signal-engine/database";

@Controller("health")
export class HealthController {
  @Get()
  async getHealth() {
    const started = Date.now();
    try {
      await sql`select 1`;
    } catch {
      throw new ServiceUnavailableException({
        status: "error",
        service: "signal-engine-api",
        database: "unavailable",
        tradingExecution: false,
        timestamp: new Date().toISOString()
      });
    }
    return {
      status: "ok",
      service: "signal-engine-api",
      timestamp: new Date().toISOString(),
      database: "ok",
      databaseLatencyMs: Date.now() - started,
      uptimeSeconds: Math.round(process.uptime()),
      tradingExecution: false
    };
  }
}
