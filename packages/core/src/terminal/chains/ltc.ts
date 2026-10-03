import { loadConfig } from "@gis/config";
import * as btc from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { deriveSecp, PATHS } from "../seed.js";
import type { ChainAdapter, GasInfo, SweepResult } from "../types.js";
import { fmtUnits, httpJson } from "../types.js";

/**
 * Litecoin, native-segwit (ltc1…) addresses at m/84'/2'/0'/0/i — the same
 * scheme Trust Wallet and Ledger use, so the phrase restores them anywhere.
 * Watched through a mempool-style HTTP API (litecoinspace.org by default) and
 * swept by spending every UTXO of the slot to the payout address in one
 * transaction, fee taken from the amount itself.
 */
const LTC = { bech32: "ltc", pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
const DUST = 5_460n; // litoshi

function api(): string {
  return (loadConfig().LTC_API_URL ?? "https://litecoinspace.org").replace(/\/+$/, "");
}

interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export class LitecoinAdapter implements ChainAdapter {
  readonly code = "ltc";
  readonly asset = "LTC";
  readonly chainLabel = "Litecoin";
  readonly decimals = 8;
  readonly stable = false;
  readonly confirmations = 2;
  readonly priceId = "litecoin";
  readonly quoteDecimals = 6;
  readonly defaultSweepMinUsd = 2;

  private async key(index: number) {
    const { privateKey, publicKey } = await deriveSecp(PATHS.ltc(index));
    const p2 = btc.p2wpkh(publicKey, LTC);
    if (!p2.address) throw new Error("could not derive LTC address");
    return { privateKey, address: p2.address, script: p2.script };
  }

  async address(index: number): Promise<string> {
    return (await this.key(index)).address;
  }

  validateAddress(addr: string): boolean {
    try {
      btc.Address(LTC).decode(addr);
      return true;
    } catch {
      return false;
    }
  }

  private async utxos(address: string): Promise<Utxo[]> {
    return httpJson<Utxo[]>(`${api()}/api/address/${address}/utxo`);
  }

  private async tipHeight(): Promise<number> {
    const res = await fetch(`${api()}/api/blocks/tip/height`, { signal: AbortSignal.timeout(10_000) });
    return Number.parseInt(await res.text(), 10);
  }

  async scan(address: string): Promise<{ confirmed: bigint; pending: bigint; txids: string[] }> {
    const [utxos, tip] = await Promise.all([this.utxos(address), this.tipHeight()]);
    let confirmed = 0n;
    let pending = 0n;
    const txids: string[] = [];
    for (const u of utxos) {
      const v = BigInt(u.value);
      const depth = u.status.confirmed && u.status.block_height ? tip - u.status.block_height + 1 : 0;
      if (depth >= this.confirmations) { confirmed += v; txids.push(u.txid); } else pending += v;
    }
    return { confirmed, pending, txids };
  }

  private async feeRate(): Promise<bigint> {
    try {
      const r = await httpJson<{ fastestFee?: number; halfHourFee?: number }>(`${api()}/api/v1/fees/recommended`, { timeoutMs: 8_000 });
      const f = Math.ceil(r.halfHourFee ?? r.fastestFee ?? 5);
      return BigInt(Math.min(Math.max(f, 2), 200));
    } catch {
      return 5n;
    }
  }

  async sweep(index: number, payout: string, minUnits: bigint): Promise<SweepResult> {
    const k = await this.key(index);
    const utxos = (await this.utxos(k.address)).filter((u) => u.status.confirmed);
    const total = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
    if (utxos.length === 0 || total <= DUST) return { kind: "skipped", note: "nothing to sweep" };
    if (total < minUnits) return { kind: "skipped", note: `below sweep minimum (${fmtUnits(total, 8, 6)} LTC)` };
    const rate = await this.feeRate();
    const vbytes = BigInt(11 + 68 * utxos.length + 31);
    const fee = vbytes * rate;
    const amount = total - fee;
    if (amount <= DUST) return { kind: "skipped", note: "balance would not cover the network fee" };

    const tx = new btc.Transaction();
    for (const u of utxos) {
      tx.addInput({ txid: hexToBytes(u.txid), index: u.vout, witnessUtxo: { script: k.script, amount: BigInt(u.value) } });
    }
    tx.addOutputAddress(payout, amount, LTC);
    tx.sign(k.privateKey);
    tx.finalize();
    const hex = bytesToHex(tx.extract());
    const res = await fetch(`${api()}/api/tx`, { method: "POST", body: hex, headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`ltc broadcast: ${body.slice(0, 200)}`);
    return { kind: "done", txid: body.trim(), amount };
  }

  async gas(): Promise<GasInfo | null> {
    return null; // fee comes out of the swept amount
  }
}
