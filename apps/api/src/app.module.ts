import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { SignalsController } from "./signals.controller.js";
import { InstrumentsController } from "./instruments.controller.js";
import { StrategiesController } from "./strategies.controller.js";
import { BacktestsController } from "./backtests.controller.js";
@Module({ controllers: [HealthController, SignalsController, InstrumentsController, StrategiesController, BacktestsController] })
export class AppModule {}
