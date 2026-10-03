import { loadConfig } from "@gis/config";
import { Address, SendMode, TonClient, WalletContractV4, internal } from "@ton/ton";
import { keyPairFromSeed } from "@ton/crypto";
import { deriveEd25519Seed, PATHS } from "../seed.js";
import type { ChainAdapter, GasInfo, SweepResult } from "../types.js";
import { fmtUnits } from "../types.js";

/**
 * Native Toncoin. Each payment slot is its own wallet-v4 contract. A wallet
 * contract does not have to be deployed to RECEIVE — the address is derived
 * from the code + public key — so the customer is shown the non-bounceable
 * ("UQ…") form, which is the one that credits an undeployed wallet. The first
 * outgoing transfer (the sweep) carries the deploy, paid from the balance, and
 * mode 128+32 sends everything that is left and frees the account.
 *
 * Talks to toncenter; a free API key (@tonapibot) lifts the 1 req/s limit.
 */
const MIN_SWEEP = 50_000_000n; // 0.05 TON — below this the deploy fee eats it

export class TonAdapter implements ChainAdapter {
  readonly code = "ton";
  readonly asset = "TON";
  readonly chainLabel = "TON";
  readonly decimals = 9;
  readonly stable = false;
  readonly confirmations = 1;
  readonly priceId = "the-open-network";
  readonly quoteDecimals = 4;
  readonly defaultSweepMinUsd = 0.5;
  private client: TonClient | null = null;

  private ton(): TonClient {
    if (!this.client) {
      const apiKey = loadConfig().TONCENTER_API_KEY;
      this.client = new TonClient({ endpoint: "https://toncenter.com/api/v2/jsonRPC", ...(apiKey ? { apiKey } : {}) });
    }
    return this.client;
  }

  private async wallet(index: number) {
    const seed = await deriveEd25519Seed(PATHS.ton(index));
    const keyPair = keyPairFromSeed(Buffer.from(seed));
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    return { keyPair, wallet };
  }

  async address(index: number): Promise<string> {
    const { wallet } = await this.wallet(index);
    return wallet.address.toString({ bounceable: false, testOnly: false });
  }

  validateAddress(addr: string): boolean {
    try {
      Address.parse(addr);
      return true;
    } catch {
      return false;
    }
  }

  async scan(address: string): Promise<{ confirmed: bigint; pending: bigint; txids: string[] }> {
    const bal = await this.ton().getBalance(Address.parse(address));
    // TON finalises in seconds; the balance the node reports is settled.
    return { confirmed: bal, pending: 0n, txids: [] };
  }

  async sweep(index: number, payout: string, minUnits: bigint): Promise<SweepResult> {
    const { keyPair, wallet } = await this.wallet(index);
    const client = this.ton();
    const balance = await client.getBalance(wallet.address);
    if (balance < MIN_SWEEP) return { kind: "skipped", note: "nothing to sweep" };
    if (balance < minUnits) return { kind: "skipped", note: `below sweep minimum (${fmtUnits(balance, 9, 4)} TON)` };
    const opened = client.open(wallet);
    const seqno = await opened.getSeqno();
    await opened.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.DESTROY_ACCOUNT_IF_ZERO,
      messages: [internal({ to: Address.parse(payout), value: 0n, bounce: false, body: "sweep" })],
    });
    // External messages have no hash we can show before the block lands; the
    // wallet address itself is the reference.
    return { kind: "done", txid: `ton:${wallet.address.toString({ bounceable: false })}:${seqno}`, amount: balance };
  }

  async gas(): Promise<GasInfo | null> {
    return null; // fees come out of the swept balance
  }
}
