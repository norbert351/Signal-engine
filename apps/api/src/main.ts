import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { securityHeadersMiddleware } from "./security.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  app.use(securityHeadersMiddleware);
  const express = app.getHttpAdapter().getInstance() as {
    set?: (key: string, value: unknown) => void;
    disable?: (key: string) => void;
  };
  express.set?.("trust proxy", 1);
  express.disable?.("x-powered-by");
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  if (corsOrigin) {
    app.enableCors({
      origin: corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean),
      methods: ["GET", "POST", "PATCH"],
      allowedHeaders: ["content-type", "x-admin-api-key"]
    });
  }
  const port = Number(process.env.API_PORT ?? 4400);
  const host = process.env.API_HOST ?? "127.0.0.1";
  await app.listen(port, host);
  console.log(`Signal Engine API listening on ${host}:${port}. Signal-only; no trading execution endpoints.`);
}
void bootstrap();
