import { loadConfig } from "@gis/config";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { createBase58check } from "@scure/base";
import { deriveSecp, PATHS } from "../seed.js";
import type { ChainAdapter, GasInfo, SweepResult } from "../types.js";
import { fmtUnits, httpJson } from "../types.js";

/**
 * USDT-TRC20 on Tron, talked to directly over TronGrid's HTTP API — no
 * TronWeb: address = base58check(0x41 ‖ keccak(pubkey)[12:]), and a
 * transaction is signed by putting a recoverable secp256k1 signature of its
 * txID into `signature[]`.
 *
 * Sweeping on Tron is the expensive one: a TRC-20 transfer burns ~15–30 TRX of
 * energy unless the sender has staked. The main address (slot 0) forwards TRX
 * to the payment address first, then the payment address sends its USDT on.
 * That is why the default sweep minimum for this chain is higher.
 */
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const b58 = createBase58check(sha256);
const SUN = 1_000_000n;
/** Fallback TRX for one TRC-20 transfer when the dry run cannot price it. */
const GAS_TRX = 30n * SUN;
const LOW_TRX = 60n * SUN;
/** Worst-case energy price (sun per unit) — the chain's dynamic price tops out around here. */
const SUN_PER_ENERGY = 420n;

function grid(): string {
  return "https://api.trongrid.io";
}

function headers(): Record<string, string> {
  const key = loadConfig().TRONGRID_API_KEY;
  return { "content-type": "application/json", ...(key ? { "TRON-PRO-API-KEY": key } : {}) };
}

function addrFromPub(pub: Uint8Array): { base58: string; hex: string } {
  const uncompressed = pub.length === 65 ? pub : secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false);
  const h = keccak_256(uncompressed.slice(1));
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(h.slice(12), 1);
  return { base58: b58.encode(payload), hex: bytesToHex(payload) };
}

function toHexAddr(base58: string): string {
  return bytesToHex(b58.decode(base58));
}

/** ABI word for an address (20 bytes, no 0x41 prefix) or a uint. */
function abiAddress(base58: string): string {
  return toHexAddr(base58).slice(2).padStart(64, "0");
}
function abiUint(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

interface TronTx {
  txID: string;
  raw_data_hex: string;
  raw_data: unknown;
  visible?: boolean;
  signature?: string[];
}

function signTx(tx: TronTx, priv: Uint8Array): TronTx {
  const hash = sha256(hexToBytes(tx.raw_data_hex));
  const sig = secp256k1.sign(hash, priv);
  const v = (sig.recovery ?? 0) + 27;
  const hex = bytesToHex(sig.toCompactRawBytes()) + v.toString(16).padStart(2, "0");
  return { ...tx, signature: [hex] };
}

/** Wait for a broadcast transaction to be executed; throw if it failed or never showed. */
async function awaitReceipt(txid: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const info = await httpJson<{ id?: string; receipt?: { result?: string }; result?: string; resMessage?: string }>(`${grid()}/wallet/gettransactioninfobyid`, {
      method: "POST", headers: headers(), body: JSON.stringify({ value: txid }),
    }).catch(() => null);
    if (!info?.id) continue; // not yet in a block
    const res = info.receipt?.result ?? (info.result === "FAILED" ? "FAILED" : "SUCCESS");
    if (res === "SUCCESS") return;
    const msg = info.resMessage ? Buffer.from(info.resMessage, "hex").toString("utf8") : res;
    throw new Error(`tron tx ${txid} failed: ${msg}`);
  }
  throw new Error(`tron tx ${txid} not confirmed in time`);
}

async function broadcast(tx: TronTx): Promise<string> {
  const r = await httpJson<{ result?: boolean; txid?: string; code?: string; message?: string }>(`${grid()}/wallet/broadcasttransaction`, {
    method: "POST", headers: headers(), body: JSON.stringify(tx),
  });
  if (!r.result) {
    const msg = r.message ? Buffer.from(r.message, "hex").toString("utf8") : r.code ?? "broadcast failed";
    throw new Error(`tron broadcast: ${r.code ?? ""} ${msg}`.trim());
  }
  return r.txid ?? tx.txID;
}

export class TronUsdtAdapter implements ChainAdapter {
  readonly code = "usdttrc20";
  readonly asset = "USDT";
  readonly chainLabel = "Tron (TRC20)";
  readonly decimals = 6;
  readonly stable = true;
  readonly confirmations = 19;
  readonly quoteDecimals = 2;
  readonly defaultSweepMinUsd = 20;

  private async key(index: number) {
    const { privateKey, publicKey } = await deriveSecp(PATHS.tron(index));
    return { privateKey, ...addrFromPub(publicKey) };
  }

  async address(index: number): Promise<string> {
    return (await this.key(index)).base58;
  }

  validateAddress(addr: string): boolean {
    try {
      const bytes = b58.decode(addr);
      return bytes.length === 21 && bytes[0] === 0x41;
    } catch {
      return false;
    }
  }

  private async usdtBalance(base58: string): Promise<bigint> {
    const r = await httpJson<{ constant_result?: string[] }>(`${grid()}/wallet/triggerconstantcontract`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({ owner_address: base58, contract_address: USDT, function_selector: "balanceOf(address)", parameter: abiAddress(base58), visible: true }),
    });
    const hex = r.constant_result?.[0];
    return hex ? BigInt(`0x${hex}`) : 0n;
  }

  private async trxBalance(base58: string): Promise<bigint> {
    const r = await httpJson<{ balance?: number }>(`${grid()}/wallet/getaccount`, {
      method: "POST", headers: headers(), body: JSON.stringify({ address: base58, visible: true }),
    });
    return BigInt(r.balance ?? 0);
  }

  async scan(address: string): Promise<{ confirmed: bigint; pending: bigint; txids: string[] }> {
    type Row = { transaction_id: string; value: string; to: string; type?: string };
    const q = (extra: string) =>
      httpJson<{ data?: Row[] }>(
        `${grid()}/v1/accounts/${address}/transactions/trc20?only_to=true&contract_address=${USDT}&limit=50&${extra}`,
        { headers: headers() },
      );
    const [conf, unconf] = await Promise.all([q("only_confirmed=true"), q("only_unconfirmed=true").catch(() => ({ data: [] as Row[] }))]);
    // The endpoint also lists Approval events, where `to` is the spender and
    // `value` the allowance — anyone could approve a payment address for a
    // million USDT for a few TRX and have it counted as money received. Only
    // actual transfers count.
    const transfers = (rows: Row[] | undefined): Row[] => (rows ?? []).filter((r) => r.type === "Transfer" && r.to === address);
    const confRows = transfers(conf.data);
    const sum = (rows: Row[]) => rows.reduce((s, r) => s + BigInt(r.value || "0"), 0n);
    const confirmedIds = new Set(confRows.map((r) => r.transaction_id));
    const pendingRows = transfers(unconf.data).filter((r) => !confirmedIds.has(r.transaction_id));
    return { confirmed: sum(confRows), pending: sum(pendingRows), txids: [...confirmedIds] };
  }

  async sweep(index: number, payout: string, minUnits: bigint): Promise<SweepResult> {
    const payer = await this.key(index);
    const balance = await this.usdtBalance(payer.base58);
    if (balance === 0n) return { kind: "skipped", note: "nothing to sweep" };
    if (balance < minUnits) return { kind: "skipped", note: `below sweep minimum (${fmtUnits(balance, 6, 2)} USDT)` };

    // Price the transfer with a dry run: energy differs a lot depending on
    // whether the payout wallet already holds USDT, and a flat budget that
    // comes up short burns every TRX of it on a failed transfer.
    let gasNeeded = GAS_TRX;
    try {
      const dry = await httpJson<{ energy_used?: number; result?: { result?: boolean } }>(`${grid()}/wallet/triggerconstantcontract`, {
        method: "POST", headers: headers(),
        body: JSON.stringify({ owner_address: payer.base58, contract_address: USDT, function_selector: "transfer(address,uint256)", parameter: abiAddress(payout) + abiUint(balance), visible: true }),
      });
      if (dry.energy_used && dry.energy_used > 0) {
        gasNeeded = (BigInt(dry.energy_used) * SUN_PER_ENERGY * 13n) / 10n + 2n * SUN; // +30 % and bandwidth
      }
    } catch { /* fall back to the flat budget */ }
    const trx = await this.trxBalance(payer.base58);
    if (trx < gasNeeded) {
      const main = await this.key(0);
      const mainTrx = await this.trxBalance(main.base58);
      const need = gasNeeded - trx;
      if (mainTrx < need + 2n * SUN) {
        return { kind: "pending", note: `main address ${main.base58} needs TRX for energy (has ${fmtUnits(mainTrx, 6, 2)}, needs ≥ ${fmtUnits(need + 2n * SUN, 6, 2)})` };
      }
      const created = await httpJson<TronTx & { Error?: string }>(`${grid()}/wallet/createtransaction`, {
        method: "POST", headers: headers(),
        body: JSON.stringify({ owner_address: main.base58, to_address: payer.base58, amount: Number(need), visible: true }),
      });
      if (!created.txID) throw new Error(`tron createtransaction: ${created.Error ?? "no txID"}`);
      const txid = await broadcast(signTx(created, main.privateKey));
      return { kind: "pending", note: `TRX sent for energy (${txid}) — transfer on next tick` };
    }
    const trig = await httpJson<{ result?: { result?: boolean; message?: string }; transaction?: TronTx }>(`${grid()}/wallet/triggersmartcontract`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({
        owner_address: payer.base58, contract_address: USDT, function_selector: "transfer(address,uint256)",
        parameter: abiAddress(payout) + abiUint(balance), fee_limit: Number(gasNeeded), call_value: 0, visible: true,
      }),
    });
    if (!trig.result?.result || !trig.transaction) {
      const msg = trig.result?.message ? Buffer.from(trig.result.message, "hex").toString("utf8") : "trigger failed";
      throw new Error(`tron triggersmartcontract: ${msg}`);
    }
    const txid = await broadcast(signTx(trig.transaction, payer.privateKey));
    // "Broadcast accepted" is not "executed": an OUT_OF_ENERGY transfer would
    // otherwise be recorded as swept while the USDT sits where it was.
    await awaitReceipt(txid);
    return { kind: "done", txid, amount: balance };
  }

  async gas(): Promise<GasInfo | null> {
    const main = await this.key(0);
    const bal = await this.trxBalance(main.base58);
    return {
      address: main.base58,
      symbol: "TRX",
      balance: fmtUnits(bal, 6, 2),
      low: bal < LOW_TRX,
      hint: `Keep TRX here; every USDT sweep forwards ≈ ${fmtUnits(GAS_TRX, 6, 0)} TRX of energy to the payment address (priced per transfer by a dry run). Staking TRX for energy on this address makes sweeps nearly free.`,
    };
  }
}
