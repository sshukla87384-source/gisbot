import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { AuthGuard } from "./common/auth.guard.js";
import { EnvelopeInterceptor } from "./common/envelope.interceptor.js";
import { AllExceptionsFilter } from "./common/exception.filter.js";
import { PermissionsGuard } from "./common/permissions.guard.js";
import type { ApiRequest, ApiResponse } from "./common/types.js";
import { AnalyticsModule } from "./modules/analytics.module.js";
import { AuthModule } from "./modules/auth.module.js";
import { BroadcastsModule } from "./modules/broadcasts.module.js";
import { CatalogModule } from "./modules/catalog.module.js";
import { CouponsModule } from "./modules/coupons.module.js";
import { InventoryModule } from "./modules/inventory.module.js";
import { OrdersModule } from "./modules/orders.module.js";
import { PlatformModule } from "./modules/platform.module.js";
import { TicketsModule } from "./modules/tickets.module.js";
import { UsersModule } from "./modules/users.module.js";
import { WalletsModule } from "./modules/wallets.module.js";

@Module({
  imports: [
    AuthModule,
    BroadcastsModule,
    AnalyticsModule,
    CatalogModule,
    InventoryModule,
    OrdersModule,
    UsersModule,
    WalletsModule,
    CouponsModule,
    TicketsModule,
    PlatformModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    // Order matters: authenticate before checking permissions.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((req: ApiRequest, res: ApiResponse, next: () => void) => {
        const incoming = req.headers["x-request-id"];
        req.id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
        res.setHeader("x-request-id", req.id);
        next();
      })
      .forRoutes("*");
  }
}
