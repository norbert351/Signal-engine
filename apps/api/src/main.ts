import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  const express = app.getHttpAdapter().getInstance() as { set?: (key: string, value: unknown) => void };
  express.set?.("trust proxy", 1);
  const port = Number(process.env.API_PORT ?? 4400);
  const host = process.env.API_HOST ?? "127.0.0.1";
  await app.listen(port, host);
  console.log(`Signal Engine API listening on ${host}:${port}. Signal-only; no trading execution endpoints.`);
}
void bootstrap();
