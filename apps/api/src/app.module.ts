import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { SignalsController } from "./signals.controller.js";
import { InstrumentsController } from "./instruments.controller.js";
@Module({ controllers: [HealthController, SignalsController, InstrumentsController] })
export class AppModule {}
