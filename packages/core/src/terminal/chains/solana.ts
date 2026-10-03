import { loadConfig } from "@gis/config";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { deriveEd25519Seed, PATHS } from "../seed.js";
import type { ChainAdapter, GasInfo, SweepResult } from "../types.js";
import { fmtUnits } from "../types.js";

/**
 * Native SOL. Each payment slot is a Phantom-compatible derivation
 * (m/44'/501'/i'/0'), so the same 12 words restore every address in Phantom
 * if the operator ever needs to. Settlement = finalized balance. Sweeping
 * sends the whole balance minus the 5 000-lamport fee, which leaves the
 * account at zero and lets the runtime reclaim it — no rent to think about.
 */
const FEE = 5_000n;
const MIN_SWEEP_LAMPORTS = 10_000n;

export class SolanaAdapter implements ChainAdapter {
  readonly code = "sol";
  readonly asset = "SOL";
  readonly chainLabel = "Solana";
  readonly decimals = 9;
  readonly stable = false;
  readonly confirmations = 1;
  readonly priceId = "solana";
  readonly quoteDecimals = 6;
  readonly defaultSweepMinUsd = 0.5;
  private conn: Connection | null = null;

  private connection(): Connection {
    if (!this.conn) this.conn = new Connection(loadConfig().SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed" });
    return this.conn;
  }

  private async keypair(index: number): Promise<Keypair> {
    return Keypair.fromSeed(await deriveEd25519Seed(PATHS.sol(index)));
  }

  async address(index: number): Promise<string> {
    return (await this.keypair(index)).publicKey.toBase58();
  }

  validateAddress(addr: string): boolean {
    try {
      return PublicKey.isOnCurve(new PublicKey(addr).toBytes());
    } catch {
      return false;
    }
  }

  async scan(address: string): Promise<{ confirmed: bigint; pending: bigint; txids: string[] }> {
    const pk = new PublicKey(address);
    const [finalized, processed] = await Promise.all([
      this.connection().getBalance(pk, "finalized"),
      this.connection().getBalance(pk, "processed"),
    ]);
    const confirmed = BigInt(finalized);
    const seen = BigInt(Math.max(processed, finalized));
    return { confirmed, pending: seen - confirmed, txids: [] };
  }

  async sweep(index: number, payout: string, minUnits: bigint): Promise<SweepResult> {
    const kp = await this.keypair(index);
    const conn = this.connection();
    const balance = BigInt(await conn.getBalance(kp.publicKey, "finalized"));
    if (balance <= FEE || balance < MIN_SWEEP_LAMPORTS) return { kind: "skipped", note: "nothing to sweep" };
    if (balance < minUnits) return { kind: "skipped", note: `below sweep minimum (${fmtUnits(balance, 9, 4)} SOL)` };
    const amount = balance - FEE;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(payout), lamports: Number(amount) }));
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
    return { kind: "done", txid: sig, amount };
  }

  async gas(): Promise<GasInfo | null> {
    // Fees come out of the swept balance itself; nothing to fund.
    return null;
  }
}

export const LAMPORTS = BigInt(LAMPORTS_PER_SOL);
