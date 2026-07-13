import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * App-layer AES-256-GCM encryption (Security doc §4).
 * Format: v1:<keyId>:<nonceB64>:<ciphertextB64>:<tagB64>
 * keyId enables zero-downtime key rotation.
 */
const VERSION = "v1";
const DEFAULT_KEY_ID = "k1";
const NONCE_BYTES = 12;

function keyFromHex(masterKeyHex: string): Buffer {
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== 32) throw new Error("Master key must be 32 bytes");
  return key;
}

export function encryptSecret(plaintext: string, masterKeyHex: string, keyId = DEFAULT_KEY_ID): string {
  const key = keyFromHex(masterKeyHex);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyId, nonce.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(":");
}

export function decryptSecret(payload: string, masterKeyHex: string): string {
  const parts = payload.split(":");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error("Unsupported ciphertext format");
  const [, , nonceB64, ctB64, tagB64] = parts;
  const key = keyFromHex(masterKeyHex);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceB64!, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, "base64")), decipher.final()]).toString("utf8");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Normalization used for license-key duplicate detection (schema doc §3.2). */
export function normalizeLicenseKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
