import { loadConfig } from "@gis/config";
import { prisma } from "@gis/database";
import { decryptSecret, encryptSecret } from "@gis/shared";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * The terminal's one secret: a 12-word BIP-39 phrase, exactly like a Trust
 * Wallet recovery phrase. Every payment address on every chain is derived from
 * it, so the phrase alone restores every address and every coin ever received.
 *
 * Stored encrypted (ENCRYPTION_MASTER_KEY, same as inventory secrets) in the
 * Setting table; decrypted into process memory on first use. This is a HOT
 * wallet by design — it has to sign sweeps unattended — which is why the
 * recommended setup is a dedicated phrase whose funds are swept straight on to
 * a cold payout wallet, never the operator's own Trust Wallet phrase.
 */
const KEY = "terminal.seed";

let cached: { mnemonic: string; seed: Uint8Array; at: number } | null = null;

export async function hasTerminalSeed(): Promise<boolean> {
  return (await loadMnemonic()) !== null;
}

async function loadMnemonic(): Promise<string | null> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.mnemonic;
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const v = row?.value as { enc?: string } | null | undefined;
  if (!v?.enc) { cached = null; return null; }
  const mnemonic = decryptSecret(v.enc, loadConfig().ENCRYPTION_MASTER_KEY);
  cached = { mnemonic, seed: mnemonicToSeedSync(mnemonic), at: Date.now() };
  return mnemonic;
}

async function loadSeed(): Promise<Uint8Array> {
  const m = await loadMnemonic();
  if (!m || !cached) throw new Error("terminal seed not set");
  return cached.seed;
}

/** Create a fresh 12-word phrase and store it. Returns the words ONCE for backup. */
export async function createTerminalSeed(): Promise<string> {
  if (await hasTerminalSeed()) throw new Error("A terminal seed already exists — remove it first");
  const mnemonic = generateMnemonic(wordlist, 128);
  await storeMnemonic(mnemonic);
  return mnemonic;
}

/** Import an existing 12/24-word phrase (spaces/case/newlines tolerated). */
export async function importTerminalSeed(raw: string): Promise<{ words: number; fingerprint: string }> {
  const mnemonic = raw.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("That is not a valid recovery phrase (check spelling and word count: 12 or 24 words)");
  await storeMnemonic(mnemonic);
  return { words: mnemonic.split(" ").length, fingerprint: await terminalFingerprint() };
}

async function storeMnemonic(mnemonic: string): Promise<void> {
  const value = { enc: encryptSecret(mnemonic, loadConfig().ENCRYPTION_MASTER_KEY), createdAt: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  cached = { mnemonic, seed: mnemonicToSeedSync(mnemonic), at: Date.now() };
}

export async function removeTerminalSeed(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: KEY } });
  cached = null;
}

/** Short id of the phrase so the admin can tell which seed is loaded, without revealing it. */
export async function terminalFingerprint(): Promise<string> {
  const m = await loadMnemonic();
  if (!m) return "";
  return bytesToHex(sha256(new TextEncoder().encode(m))).slice(0, 8);
}

// ── Derivation ───────────────────────────────────────────────────────────────

/** secp256k1 key at a BIP-32 path (EVM, Tron, Litecoin). */
export async function deriveSecp(path: string): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const root = HDKey.fromMasterSeed(await loadSeed());
  const node = root.derive(path);
  if (!node.privateKey || !node.publicKey) throw new Error(`no key at ${path}`);
  return { privateKey: node.privateKey, publicKey: node.publicKey };
}

/**
 * SLIP-0010 ed25519 derivation (Solana, TON). Only hardened steps exist for
 * ed25519, so every path segment is treated as hardened.
 */
export async function deriveEd25519Seed(path: string): Promise<Uint8Array> {
  const seed = await loadSeed();
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  const segments = path.replace(/^m\//, "").split("/").filter(Boolean);
  for (const seg of segments) {
    const n = Number.parseInt(seg.replace("'", ""), 10);
    if (!Number.isFinite(n)) throw new Error(`bad path segment ${seg}`);
    const index = (n + 0x80000000) >>> 0;
    const data = new Uint8Array(1 + 32 + 4);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

export const PATHS = {
  evm: (i: number) => `m/44'/60'/0'/0/${i}`,
  tron: (i: number) => `m/44'/195'/0'/0/${i}`,
  ltc: (i: number) => `m/84'/2'/0'/0/${i}`,
  sol: (i: number) => `m/44'/501'/${i}'/0'`,
  ton: (i: number) => `m/44'/607'/${i}'`,
};
