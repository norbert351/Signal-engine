import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module.js";
async function bootstrap() {
 const app = await NestFactory.create(AppModule);
 app.setGlobalPrefix("api/v1");
 app.enableShutdownHooks();
 app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
 const port = Number(process.env.API_PORT ?? 4000);
 await app.listen(port, "0.0.0.0");
 console.log("Signal Engine API listening on :" + port);
}
void bootstrap();
