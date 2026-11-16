import { Module, OnApplicationShutdown } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { sql } from "@signal-engine/database";
import { HealthController } from "./health.controller.js";
import { SignalsController } from "./signals.controller.js";
import { InstrumentsController } from "./instruments.controller.js";
import { StrategiesController } from "./strategies.controller.js";
import { BacktestsController } from "./backtests.controller.js";
import { PaperTradesController } from "./paper-trades.controller.js";
import { SystemController } from "./system.controller.js";
import { DocsController } from "./docs.controller.js";
import { NewsController } from "./news.controller.js";
import { EventsController } from "./events.controller.js";
import { EventTradingController } from "./event-trading.controller.js";
import { IntelligenceController } from "./intelligence.controller.js";
import { RateLimitGuard } from "./rate-limit.guard.js";
import { SafeExceptionFilter } from "./security.js";

@Module({
  controllers: [
    HealthController,
    SignalsController,
    InstrumentsController,
    StrategiesController,
    BacktestsController,
    PaperTradesController,
    SystemController,
    DocsController,
    NewsController,
    EventsController,
    EventTradingController,
    IntelligenceController
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: SafeExceptionFilter }
  ]
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}
