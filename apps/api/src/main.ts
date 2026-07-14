import "reflect-metadata";
import { loadConfig, requireJwtSecret } from "@gis/config";
import { ensureDbObjects } from "@gis/database";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { DeveloperModule } from "./modules/developer.module.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  requireJwtSecret(); // fail fast if missing
  await ensureDbObjects();

  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ["error", "warn", "log"] });
  app.setGlobalPrefix("api/v1");
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.ADMIN_PANEL_ORIGIN, credentials: true });

  if (config.NODE_ENV !== "production") {
    const swagger = new DocumentBuilder()
      .setTitle("Get It Sasta Admin API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swagger));
  }

  // Public developer API docs — available in every environment.
  const devDoc = new DocumentBuilder()
    .setTitle("Get It Sasta — Developer API")
    .setDescription("Public, API-key authenticated. Send your key as the 'X-API-Key' header. Read-only v1.")
    .setVersion("1.0")
    .addApiKey({ type: "apiKey", name: "X-API-Key", in: "header" }, "apiKey")
    .build();
  SwaggerModule.setup("api/v1/developer/docs", app, SwaggerModule.createDocument(app, devDoc, { include: [DeveloperModule] }));

  await app.listen(config.API_PORT);
  Logger.log(`API listening on :${config.API_PORT}`, "Bootstrap");
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("fatal", e);
  process.exit(1);
});
