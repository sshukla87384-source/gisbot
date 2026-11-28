import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { loadConfig } from "@gis/config";

/**
 * A minimal SMTP client (no extra package): enough to send one HTML email
 * through Gmail, Zoho, Hostinger, Brevo… with a login.
 *
 *   port 465 → TLS from the start;  port 587 / 25 → STARTTLS.
 *
 * Used by the worker when SMTP_HOST is set (Resend otherwise).
 */

export interface SmtpMail {
  to: string;
  subject: string;
  html: string;
}

/** Is any way of sending email configured (Resend or SMTP)? */
export function emailSendingConfigured(): boolean {
  const c = loadConfig();
  if (!c.EMAIL_FROM?.trim()) return false;
  return Boolean(c.RESEND_API_KEY?.trim() || (c.SMTP_HOST?.trim() && c.SMTP_USER?.trim() && c.SMTP_PASS));
}

export function smtpConfigured(): boolean {
  const c = loadConfig();
  return Boolean(c.SMTP_HOST?.trim() && c.SMTP_USER?.trim() && c.SMTP_PASS && c.EMAIL_FROM?.trim());
}

const noCrlf = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();
const addrOf = (s: string): string => (s.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? s).trim();
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const wrap76 = (s: string): string => s.replace(/.{1,76}/g, "$&\r\n");
const encodeHeader = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

function encodeFrom(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/);
  if (!m) return noCrlf(from);
  const name = (m[1] ?? "").trim();
  return name ? `${encodeHeader(name)} <${m[2]}>` : `<${m[2]}>`;
}

/** Talks SMTP over one socket: send a line, wait for the reply code. */
class Conn {
  private buf = "";
  private waiters: Array<(line: string) => void> = [];
  private lines: string[] = [];
  private err: Error | null = null;

  sock: net.Socket | tls.TLSSocket;

  constructor(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    this.attach(sock);
  }

  attach(sock: net.Socket | tls.TLSSocket): void {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (d: Buffer | string) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line); else this.lines.push(line);
      }
    });
    sock.on("error", (e) => { this.err = e; for (const w of this.waiters.splice(0)) w(`599 ${e.message}`); });
    sock.on("close", () => { for (const w of this.waiters.splice(0)) w("599 connection closed"); });
  }

  private nextLine(): Promise<string> {
    if (this.err) return Promise.resolve(`599 ${this.err.message}`);
    const l = this.lines.shift();
    if (l !== undefined) return Promise.resolve(l);
    return new Promise((res) => this.waiters.push(res));
  }

  /** One full (possibly multi-line) reply. */
  async reply(): Promise<{ code: number; text: string }> {
    let text = "";
    for (;;) {
      const line = await this.nextLine();
      text += `${line}\n`;
      if (!/^\d{3}-/.test(line)) return { code: Number(line.slice(0, 3)) || 599, text: text.trim() };
    }
  }

  async cmd(line: string, expect: number[], hideInError = false): Promise<string> {
    this.sock.write(`${line}\r\n`);
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${hideInError ? "AUTH" : line.split(" ")[0]} failed: ${r.text.slice(0, 200)}`);
    return r.text;
  }
}

export async function sendSmtpMail(mail: SmtpMail): Promise<void> {
  const c = loadConfig();
  const host = (c.SMTP_HOST ?? "").trim();
  const port = Number(c.SMTP_PORT) || 465;
  const user = (c.SMTP_USER ?? "").trim();
  const pass = c.SMTP_PASS ?? "";
  const from = (c.EMAIL_FROM ?? user).trim();
  if (!host || !user || !pass || !from) throw new Error("SMTP is not configured");
  const to = noCrlf(mail.to);
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(to)) throw new Error("bad recipient");

  const secure = port === 465;
  const sock: net.Socket | tls.TLSSocket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  sock.setTimeout(30_000, () => sock.destroy(new Error("SMTP timeout")));
  const conn = new Conn(sock);
  try {
    const hello = await conn.reply();
    if (hello.code !== 220) throw new Error(`SMTP greeting: ${hello.text.slice(0, 200)}`);
    const me = "localhost";
    let ehlo = await conn.cmd(`EHLO ${me}`, [250]);
    if (!secure) {
      if (!/STARTTLS/i.test(ehlo)) throw new Error("SMTP server does not offer STARTTLS — use port 465");
      await conn.cmd("STARTTLS", [220]);
      const raw = conn.sock as net.Socket;
      // The plain socket's reader must stop: from here on its bytes are TLS.
      raw.removeAllListeners("data");
      raw.removeAllListeners("close");
      raw.setTimeout(0);
      const up = tls.connect({ socket: raw, servername: host });
      await new Promise<void>((res, rej) => { up.once("secureConnect", () => res()); up.once("error", rej); });
      up.setTimeout(30_000, () => up.destroy(new Error("SMTP timeout")));
      conn.attach(up);
      ehlo = await conn.cmd(`EHLO ${me}`, [250]);
    }
    if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo)) {
      await conn.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64")}`, [235], true);
    } else {
      await conn.cmd("AUTH LOGIN", [334]);
      await conn.cmd(b64(user), [334], true);
      await conn.cmd(b64(pass), [235], true);
    }
    await conn.cmd(`MAIL FROM:<${addrOf(from)}>`, [250]);
    await conn.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await conn.cmd("DATA", [354]);
    const domain = addrOf(from).split("@")[1] ?? "localhost";
    const headers = [
      `From: ${encodeFrom(from)}`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(noCrlf(mail.subject))}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ].join("\r\n");
    // base64 body: no line can start with "." — no dot-stuffing needed.
    await conn.cmd(`${headers}\r\n\r\n${wrap76(b64(mail.html))}.`, [250]);
    await conn.cmd("QUIT", [221]).catch(() => undefined);
  } finally {
    conn.sock.end();
  }
}
