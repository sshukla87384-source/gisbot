import { API_SCOPES, createApiKey, listApiKeys, revokeApiKey } from "@gis/core";
import { Body, Controller, Get, Module, Param, Post, Req } from "@nestjs/common";
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
  async list() {
    return listApiKeys();
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
  @Post(":id/revoke")
  async revoke(@Param("id") id: string, @Req() req: ApiRequest) {
    await revokeApiKey(id);
    await writeAudit(req, "apikey.revoke", "ApiKey", id);
    return { ok: true };
  }
}

@Module({ controllers: [ApiKeysController] })
export class ApiKeysModule {}
