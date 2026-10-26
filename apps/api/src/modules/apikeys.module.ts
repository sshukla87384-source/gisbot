import { API_SCOPES, createApiKey, listApiKeys, reactivateApiKey, revokeApiKey, setApiKeyScopes } from "@gis/core";
import { Body, Controller, Get, Module, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

const createBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  rateLimitPerMin: z.number().int().min(10).max(6000).optional(),
  expiresAt: z.string().datetime().optional(),
});

const scopesBody = z.object({ scopes: z.array(z.enum(API_SCOPES)).min(1) });

@ApiBearerAuth()
@ApiTags("apikeys")
@Controller("apikeys")
export class ApiKeysController {
  @RequirePermission("apikeys.manage")
  @Get("scopes")
  scopes() {
    return { scopes: API_SCOPES };
  }

  @RequirePermission("apikeys.manage")
  @Get()
  async list(@Query("search") search?: string) {
    // Each key comes with its owner (the reseller's @handle / name).
    return listApiKeys(search ? { search: String(search).slice(0, 40) } : {});
  }

  @RequirePermission("apikeys.manage")
  @Post()
  async create(@Body() body: unknown, @Req() req: ApiRequest) {
    const data = validate(createBody, body);
    const created = await createApiKey({
      name: data.name,
      scopes: data.scopes,
      rateLimitPerMin: data.rateLimitPerMin,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      ownerUserId: req.user?.id,
    });
    await writeAudit(req, "apikey.create", "ApiKey", created.id, undefined, { name: data.name, scopes: data.scopes });
    // apiKey (the secret) is returned ONCE — never stored in plaintext.
    return created;
  }

  @RequirePermission("apikeys.manage")
  @Post(":id/reactivate")
  async reactivate(@Param("id") id: string, @Req() req: ApiRequest) {
    const r = await reactivateApiKey(id);
    if (r.ok) await writeAudit(req, "apikey.reactivate", "ApiKey", id);
    return r;
  }

  @RequirePermission("apikeys.manage")
  @Post(":id/scopes")
  async setScopes(@Param("id") id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const data = validate(scopesBody, body);
    await setApiKeyScopes(id, data.scopes);
    await writeAudit(req, "apikey.scopes", "ApiKey", id, undefined, { scopes: data.scopes });
    return { ok: true };
  }

  @RequirePermission("apikeys.manage")
  @Post(":id/revoke")
  async revoke(@Param("id") id: string, @Req() req: ApiRequest) {
    await revokeApiKey(id);
    await writeAudit(req, "apikey.revoke", "ApiKey", id);
    return { ok: true };
  }
}

@Module({ controllers: [ApiKeysController] })
export class ApiKeysModule {}
