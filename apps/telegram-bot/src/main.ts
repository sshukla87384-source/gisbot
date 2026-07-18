import { createServer } from "node:http";
import { loadConfig } from "@gis/config";
import { ensureDbObjects, prisma } from "@gis/database";
import { getRedis } from "@gis/core";
import { webhookCallback } from "grammy";
import { createBot } from "./bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureDbObjects();

  const bot = createBot();
  await bot.api.setMyCommands([
    { command: "start", description: "Open Get It Sasta" },
    { command: "shop", description: "Browse products" },
    { command: "menu", description: "Main menu" },
    { command: "help", description: "Help & support" },
  ]);

  if (config.BOT_MODE === "webhook") {
    const path = `/webhooks/telegram/${config.WEBHOOK_SECRET_PATH}`;
    const handler = webhookCallback(bot, "http", { secretToken: config.TELEGRAM_SECRET_TOKEN });

    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === path) {
        void handler(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(config.PORT, async () => {
      await bot.init();
      await bot.api.setWebhook(`${config.WEBHOOK_DOMAIN}${path}`, {
        secret_token: config.TELEGRAM_SECRET_TOKEN,
        drop_pending_updates: false,
        allowed_updates: ["message", "callback_query"],
      });
      // eslint-disable-next-line no-console
      console.log(`bot: webhook mode on :${config.PORT}`);
    });
  } else {
    // eslint-disable-next-line no-console
    console.log("bot: long-polling mode (development)");
    await bot.start({ allowed_updates: ["message", "callback_query"] });
  }

  const shutdown = async (): Promise<void> => {
    await bot.stop().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    getRedis().disconnect();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("fatal", e);
  process.exit(1);
});
