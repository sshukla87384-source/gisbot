import "reflect-metadata";
import { loadConfig, requireJwtSecret } from "@gis/config";
import { ensureDbObjects } from "@gis/database";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  requireJwtSecret(); // fail fast if missing
  await ensureDbObjects();

  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ["error", "warn", "log"] });
  app.setGlobalPrefix("api/v1");
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.ADMIN_PANEL_ORIGIN, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  if (config.NODE_ENV !== "production") {
    const swagger = new DocumentBuilder()
      .setTitle("Get It Sasta Admin API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swagger));
  }

  await app.listen(config.API_PORT);
  Logger.log(`API listening on :${config.API_PORT}`, "Bootstrap");
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("fatal", e);
  process.exit(1);
});
