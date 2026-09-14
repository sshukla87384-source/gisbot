import { createServer, type Server } from "node:http";
import { enqueueFulfillment } from "@gis/core";
import { prisma, type PaymentProvider as PaymentProviderEnum } from "@gis/database";
import { getProvider } from "@gis/payments";

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

const PROVIDER_ENUM: Record<string, PaymentProviderEnum> = {
  razorpay: "RAZORPAY",
  nowpayments: "NOWPAYMENTS",
};

const RETURN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Get It Sasta</title>
<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
div{text-align:center}h1{font-size:1.4rem}</style></head><body><div>
<h1>✅ Payment step complete</h1><p>Return to Telegram — your order status and delivery arrive there within seconds.</p>
</div></body></html>`;

/**
 * Payment webhook receiver (PRD §6.1: confirmation ONLY via verified webhook).
 * Lives in the worker so webhook receipt and fulfillment are co-located; nginx
 * routes /webhooks/payments/* here. Fast path: verify signature → persist
 * WebhookEvent (unique provider+eventId = idempotency) → enqueue → 200.
 */
export function startWebhookServer(port: number): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "";

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && url.startsWith("/webhooks/payments/return")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(RETURN_PAGE);
      return;
    }

    const match = /^\/webhooks\/payments\/([a-z]+)$/.exec(url);
    if (req.method !== "POST" || !match) {
      res.writeHead(404);
      res.end();
      return;
    }

    const providerName = match[1]!;
    const chunks: Buffer[] = [];
    let size = 0;
    // Set once the request is finished with, so a late `data` chunk cannot write
    // a second set of headers and a still-arriving `end` cannot run the handler.
    let done = false;
    // A client that vanishes mid-upload (ECONNRESET) emits `error` on the
    // request stream. With no listener that is an UNHANDLED 'error' event, which
    // takes the whole worker — queues, cron and all — down with it.
    req.on("error", () => {
      done = true;
    });
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      void (async () => {
        const provider = getProvider(providerName);
        const providerEnum = PROVIDER_ENUM[providerName];
        if (!provider || !providerEnum) {
          res.writeHead(404);
          res.end();
          return;
        }
        const rawBody = Buffer.concat(chunks);
        const events = provider.verifyAndParseWebhook(rawBody, req.headers);
        if (events === null) {
          // Invalid signature — logged for the security channel, no details leaked.
          // eslint-disable-next-line no-console
          console.warn("webhook signature verification failed", { provider: providerName });
          res.writeHead(400);
          res.end();
          return;
        }
        for (const event of events) {
          try {
            const row = await prisma.webhookEvent.create({
              data: {
                provider: providerEnum,
                eventId: event.eventId,
                eventType: event.type,
                rawBody: { normalized: event } as never,
              },
            });
            await enqueueFulfillment(row.id);
          } catch (e) {
            // P2002 = duplicate (provider,eventId).
            if (!(e instanceof Error && "code" in e && (e as { code?: string }).code === "P2002")) throw e;
            // NOT a plain no-op: the row can exist while the enqueue that should
            // have followed it never happened (Redis down, worker killed between
            // the two writes), and the gateway's redelivery is the only chance
            // left to notice. Treating it as "already handled" is how a PAID
            // order is never fulfilled. Re-enqueue instead — the job id is
            // derived from the event, so a genuine duplicate is still a no-op.
            const existing = await prisma.webhookEvent.findUnique({
              where: { provider_eventId: { provider: providerEnum, eventId: event.eventId } },
              select: { id: true, processedAt: true },
            });
            if (existing && !existing.processedAt) await enqueueFulfillment(existing.id);
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      })().catch((e) => {
        // eslint-disable-next-line no-console
        console.error("webhook handling error", { error: String(e) });
        if (!res.headersSent) res.writeHead(500);
        // The 200 may already have gone out (a throw from a later event in the
        // batch); ending a finished response throws ERR_STREAM_ALREADY_FINISHED.
        if (!res.writableEnded) res.end();
      });
    });
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`worker: payment webhook server on :${port}`);
  });
  return server;
}
