import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { HealthController } from "./health.controller.js";
import { SignalsController } from "./signals.controller.js";
import { InstrumentsController } from "./instruments.controller.js";
import { StrategiesController } from "./strategies.controller.js";
import { BacktestsController } from "./backtests.controller.js";
import { PaperTradesController } from "./paper-trades.controller.js";
import { SystemController } from "./system.controller.js";
import { DocsController } from "./docs.controller.js";
import { RateLimitGuard } from "./rate-limit.guard.js";

@Module({
  controllers: [
    HealthController,
    SignalsController,
    InstrumentsController,
    StrategiesController,
    BacktestsController,
    PaperTradesController,
    SystemController,
    DocsController
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }]
})
export class AppModule {}
