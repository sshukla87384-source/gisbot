import {
  CRYPTO_NETWORKS,
  TERMINAL_CHAINS,
  addFaq,
  getAlwaysAdminHandle,
  getAlwaysAdminId,
  getBackupConfig,
  getComboConfig,
  getEnabledCryptoNetworks,
  getHideSoldOut,
  getMiniAppConfig,
  getNowPaymentsCreds,
  getPaymentRails,
  getRenewalConfig,
  getRiskConfig,
  getTerminalConfig,
  hasTerminalSeed,
  listAgents,
  listFaq,
  miniAppUrl,
  removeFaq,
  setAgents,
  setAlwaysAdmin,
  setBackupDaily,
  setComboConfig,
  setEnabledCryptoNetworks,
  setHideSoldOut,
  setMiniAppEnabled,
  setPaymentRails,
  setRenewalConfig,
  setRiskConfig,
  setTerminalConfig,
  setTerminalPayout,
} from "@gis/core";
import { Body, Controller, Get, Module, Param, Patch, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { writeAudit } from "../common/audit.js";
import { ApiError } from "../common/errors.js";
import { RequirePermission } from "../common/permissions.decorator.js";
import { validate } from "../common/zod-body.pipe.js";
import type { ApiRequest } from "../common/types.js";

/**
 * Typed read/write for every "store feature" the bot admin can toggle, so the
 * web portal edits the same rows through the same setters (same validation,
 * same caches) instead of raw JSON. Secrets (seed, API keys) are never
 * returned here — only whether they are configured.
 */
const bodies = {
  rails: z.object({
    upiEnabled: z.boolean().optional(),
    binanceEnabled: z.boolean().optional(),
    /** Major units in INR; null/0 = no cap. */
    upiMaxInr: z.number().min(0).max(10_000_000).nullable().optional(),
  }),
  risk: z.object({
    newUserMaxUsd: z.number().min(0).max(100_000).optional(),
    newUserHours: z.number().int().min(1).max(720).optional(),
    maxOrdersPerDay: z.number().int().min(0).max(10_000).optional(),
  }),
  renewal: z.object({ enabled: z.boolean().optional(), daysBefore: z.number().int().min(0).max(60).optional(), pct: z.number().int().min(0).max(90).optional() }),
  combo: z.object({ enabled: z.boolean().optional(), pct: z.number().int().min(0).max(90).optional(), minProducts: z.number().int().min(2).max(20).optional() }),
  miniapp: z.object({ enabled: z.boolean() }),
  shop: z.object({ hideSoldOut: z.boolean() }),
  backup: z.object({ daily: z.boolean() }),
  agents: z.object({ ids: z.array(z.string().regex(/^\d{5,20}$/)).max(50) }),
  alwaysAdmin: z.object({ idOrHandle: z.string().max(64).nullable() }),
  faq: z.object({
    add: z.object({ q: z.string().min(3).max(200), a: z.string().min(1).max(2000) }).optional(),
    remove: z.string().max(64).optional(),
  }),
  crypto: z.object({ networks: z.array(z.string().max(24)).max(40) }),
  terminal: z.object({
    enabled: z.array(z.string().max(24)).max(20).optional(),
    payout: z.record(z.string().max(24), z.string().max(128)).optional(),
    sweepMinUsd: z.record(z.string().max(24), z.number().min(0).max(100_000)).optional(),
    toleranceStablePct: z.number().min(0).max(20).optional(),
    toleranceVolatilePct: z.number().min(0).max(20).optional(),
  }),
} as const;

type FeatureName = keyof typeof bodies;

async function snapshot() {
  const [rails, risk, renewal, combo, miniapp, hideSoldOut, backup, agents, alwaysId, alwaysHandle, faq, cryptoNets, np, terminal, seed] = await Promise.all([
    getPaymentRails(), getRiskConfig(), getRenewalConfig(), getComboConfig(), getMiniAppConfig(), getHideSoldOut(), getBackupConfig(),
    listAgents(), getAlwaysAdminId(), getAlwaysAdminHandle(), listFaq(), getEnabledCryptoNetworks(), getNowPaymentsCreds(), getTerminalConfig(), hasTerminalSeed(),
  ]);
  return {
    rails: { upiEnabled: rails.upiEnabled, binanceEnabled: rails.binanceEnabled, upiMaxInr: rails.upiMaxMinor === null ? null : rails.upiMaxMinor / 100 },
    risk,
    renewal,
    combo,
    miniapp: { enabled: miniapp.enabled, url: miniAppUrl() },
    shop: { hideSoldOut },
    backup,
    agents: { ids: agents },
    alwaysAdmin: { telegramId: alwaysId, handle: alwaysHandle },
    faq,
    crypto: {
      configured: np !== null,
      networks: cryptoNets,
      catalogue: CRYPTO_NETWORKS.map((n) => ({ code: n.code, label: n.label, stable: n.stable })),
    },
    terminal: {
      seedConfigured: seed,
      enabled: terminal.enabled,
      payout: terminal.payout,
      sweepMinUsd: terminal.sweepMinUsd,
      toleranceStablePct: terminal.toleranceStablePct,
      toleranceVolatilePct: terminal.toleranceVolatilePct,
      chains: TERMINAL_CHAINS.map((c) => ({ code: c.code, label: `${c.asset} · ${c.chainLabel}`, defaultSweepMinUsd: c.defaultSweepMinUsd })),
    },
  };
}

@ApiBearerAuth()
@ApiTags("features")
@Controller("features")
export class FeaturesController {
  @RequirePermission("analytics.read")
  @Get()
  all() {
    return snapshot();
  }

  @RequirePermission("settings.write")
  @Patch(":name")
  async patch(@Param("name") name: string, @Body() body: unknown, @Req() req: ApiRequest) {
    if (!(name in bodies)) throw new ApiError(404, "NOT_FOUND", `Unknown feature "${name}"`);
    const feature = name as FeatureName;
    const before = await snapshot();
    switch (feature) {
      case "rails": {
        const b = validate(bodies.rails, body);
        await setPaymentRails({
          ...(b.upiEnabled !== undefined ? { upiEnabled: b.upiEnabled } : {}),
          ...(b.binanceEnabled !== undefined ? { binanceEnabled: b.binanceEnabled } : {}),
          ...(b.upiMaxInr !== undefined ? { upiMaxMinor: b.upiMaxInr && b.upiMaxInr > 0 ? Math.round(b.upiMaxInr * 100) : null } : {}),
        });
        break;
      }
      case "risk": await setRiskConfig(validate(bodies.risk, body)); break;
      case "renewal": await setRenewalConfig(validate(bodies.renewal, body)); break;
      case "combo": await setComboConfig(validate(bodies.combo, body)); break;
      case "miniapp": await setMiniAppEnabled(validate(bodies.miniapp, body).enabled); break;
      case "shop": await setHideSoldOut(validate(bodies.shop, body).hideSoldOut); break;
      case "backup": await setBackupDaily(validate(bodies.backup, body).daily); break;
      case "agents": await setAgents(validate(bodies.agents, body).ids); break;
      case "alwaysAdmin": {
        const b = validate(bodies.alwaysAdmin, body);
        try {
          await setAlwaysAdmin(b.idOrHandle);
        } catch (e) {
          throw new ApiError(400, "VALIDATION", e instanceof Error ? e.message : String(e));
        }
        break;
      }
      case "faq": {
        const b = validate(bodies.faq, body);
        if (b.add) await addFaq(b.add.q, b.add.a);
        if (b.remove) await removeFaq(b.remove);
        break;
      }
      case "crypto": {
        const b = validate(bodies.crypto, body);
        const known = new Set(CRYPTO_NETWORKS.map((n) => n.code));
        await setEnabledCryptoNetworks(b.networks.filter((c) => known.has(c)));
        break;
      }
      case "terminal": {
        const b = validate(bodies.terminal, body);
        const known = new Set(TERMINAL_CHAINS.map((c) => c.code));
        if (b.payout) {
          // Validated per chain so a mistyped address is refused, not stored.
          for (const [code, addr] of Object.entries(b.payout)) {
            if (!known.has(code)) continue;
            if (addr.trim() === "") {
              const cur = await getTerminalConfig();
              const payout = { ...cur.payout };
              delete payout[code];
              await setTerminalConfig({ payout });
            } else {
              try {
                await setTerminalPayout(code, addr);
              } catch (e) {
                throw new ApiError(400, "VALIDATION", e instanceof Error ? e.message : String(e));
              }
            }
          }
        }
        const patch: Parameters<typeof setTerminalConfig>[0] = {};
        if (b.enabled) patch.enabled = b.enabled.filter((c) => known.has(c));
        if (b.sweepMinUsd) patch.sweepMinUsd = Object.fromEntries(Object.entries(b.sweepMinUsd).filter(([c]) => known.has(c)));
        if (b.toleranceStablePct !== undefined) patch.toleranceStablePct = b.toleranceStablePct;
        if (b.toleranceVolatilePct !== undefined) patch.toleranceVolatilePct = b.toleranceVolatilePct;
        if (Object.keys(patch).length) await setTerminalConfig(patch);
        break;
      }
    }
    const after = await snapshot();
    await writeAudit(req, `feature.${feature}`, "Setting", feature, before[feature], after[feature]);
    return after;
  }
}

@Module({ controllers: [FeaturesController] })
export class FeaturesModule {}
