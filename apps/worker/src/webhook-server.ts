import { createServer, type Server } from "node:http";
import { enqueueFulfillment } from "@gis/core";
import { prisma, type PaymentProvider as PaymentProviderEnum } from "@gis/database";
import { getProvider } from "@gis/payments";

const MAX_BODY_BYTES = 1_048_576; // 1 MiB
/** A whole request (headers + body) must arrive inside this window. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Headers alone are far quicker than that — a slowloris never gets further. */
const HEADERS_TIMEOUT_MS = 15_000;
/** …and a socket that goes quiet mid-request is dropped rather than held open. */
const SOCKET_IDLE_MS = 20_000;
/**
 * Cap on webhook bodies being buffered at once. Every in-flight request holds
 * up to MAX_BODY_BYTES in `chunks`, so without a cap a few hundred slow POSTs
 * are hundreds of megabytes of heap in a 1 GB container — the worker is OOM
 * killed and takes fulfillment, the outbox and cron with it.
 */
const MAX_CONCURRENT_BODIES = 64;
let inFlightBodies = 0;

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

    if (inFlightBodies >= MAX_CONCURRENT_BODIES) {
      // Shed load rather than buffer without bound. 503 + Retry-After is what
      // every gateway here treats as "come back", so nothing is lost.
      res.writeHead(503, { "retry-after": "5" });
      res.end();
      req.resume(); // drain, so the socket can be closed cleanly
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    // Set once the request is finished with, so a late `data` chunk cannot write
    // a second set of headers and a still-arriving `end` cannot run the handler.
    let done = false;
    inFlightBodies++;
    // Released exactly once, however the request ends (handled, aborted, timed
    // out) — a leak here permanently lowers the ceiling above.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlightBodies--;
    };
    res.on("close", release);
    // A socket that stops sending mid-body holds a slot and a buffer for as long
    // as the peer likes; Node applies no idle timeout of its own here.
    req.setTimeout(SOCKET_IDLE_MS, () => {
      if (done) return;
      done = true;
      if (!res.headersSent) res.writeHead(408);
      if (!res.writableEnded) res.end();
      req.destroy();
    });
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
          // null is the providers' single "do not trust this request" answer:
          // a bad/absent signature, an unparseable body, or a payload missing
          // the field that identifies the payment. Logged for the security
          // channel, no details leaked.
          // eslint-disable-next-line no-console
          console.warn("webhook rejected as invalid", { provider: providerName });
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
            //
            // The processedAt read below is only a cheap filter, NOT the
            // safety property: processedAt can be stamped between this SELECT
            // and the enqueue. Two things make that harmless. The job id is
            // derived from the row (`wh:<webhookEventId>`), so re-adding it is
            // a no-op for as long as BullMQ still holds the job; and if it has
            // been evicted, processWebhookEvent re-reads the row and returns
            // immediately on a non-null processedAt. The enqueue is therefore
            // idempotent on the event, not on the timing of this check.
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

  // Node's defaults leave a half-open request alive far longer than any payment
  // gateway needs; a handful of them is enough to sit on sockets and buffers.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  // A server 'error' (EADDRINUSE, an accept failure) with no listener is thrown
  // as an uncaught exception, which ends the worker process.
  server.on("error", (e) => {
    // eslint-disable-next-line no-console
    console.error("webhook server error", { error: String(e) });
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`worker: payment webhook server on :${port}`);
  });
  return server;
}
