import "reflect-metadata";
import { loadConfig, requireJwtSecret } from "@gis/config";
import { ensureDbObjects } from "@gis/database";
import { primeFxRate } from "@gis/core";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { DeveloperModule } from "./modules/developer.module.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  requireJwtSecret(); // fail fast if missing
  await ensureDbObjects();
  // Load + keep fresh the admin-set INR<->USDT rate.
  await primeFxRate().catch(() => undefined);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ["error", "warn", "log"],
  });
  // nginx fronts this service (exactly one hop). Without it every req.ip is the
  // proxy's, so AuditLog.ip is useless and the login throttle degrades from
  // per-IP+email to global-per-email.
  app.set("trust proxy", 1);
  // Express defaults to a 100 KB JSON body, but POST /inventory/keys accepts up
  // to 5000 keys — a legitimate import 413s without this.
  app.useBodyParser("json", { limit: "2mb" });
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

  app.enableShutdownHooks(); // SIGTERM/SIGINT → drain in-flight requests before exit
  await app.listen(config.API_PORT);
  Logger.log(`API listening on :${config.API_PORT}`, "Bootstrap");
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("fatal", e);
  process.exit(1);
});
