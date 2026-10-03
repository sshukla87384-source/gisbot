import { loadConfig } from "@gis/config";
import { bytesToHex } from "@noble/hashes/utils";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  parseAbi,
  parseAbiItem,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, polygon } from "viem/chains";
import { deriveSecp, PATHS } from "../seed.js";
import type { ChainAdapter, GasInfo, SweepResult } from "../types.js";
import { fmtUnits } from "../types.js";

/**
 * USDT on an EVM chain (BNB Smart Chain, Polygon). One derivation path
 * (m/44'/60'/0'/0/i) serves every EVM chain, so slot i is the SAME address on
 * BSC and Polygon — convenient for the operator (one gas address to fund with
 * both BNB and POL), harmless for payments because each slot is used once.
 *
 * Settlement: USDT balance at (latest − confirmations) blocks is "confirmed".
 * Sweep: the main address (slot 0) sends the payment address just enough gas
 * for one ERC-20 transfer, then the payment address transfers its USDT to the
 * payout wallet. Two ticks, no state kept — each tick looks at balances.
 */
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
]);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const makeClient = (chain: Chain, rpc: string) => createPublicClient({ chain, transport: http(rpc, { timeout: 15_000 }) });
type Pub = ReturnType<typeof makeClient>;

interface EvmSpec {
  code: string;
  chain: Chain;
  rpc: () => string;
  token: Address;
  decimals: number;
  confirmations: number;
  chainLabel: string;
  gasSymbol: string;
  /** Gas to forward for one transfer, in gas units. */
  transferGas: bigint;
  /** Below this native balance on slot 0 the operator is warned. */
  lowGas: bigint;
}

const SPECS: Record<string, EvmSpec> = {
  usdtbsc: {
    code: "usdtbsc",
    chain: bsc,
    rpc: () => loadConfig().BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
    token: "0x55d398326f99059fF775485246999027B3197955",
    decimals: 18,
    confirmations: 12,
    chainLabel: "BNB Smart Chain (BEP20)",
    gasSymbol: "BNB",
    transferGas: 70_000n,
    lowGas: 3_000_000_000_000_000n, // 0.003 BNB ≈ 10 sweeps
  },
  usdtmatic: {
    code: "usdtmatic",
    chain: polygon,
    rpc: () => loadConfig().POLYGON_RPC_URL ?? "https://polygon-rpc.com",
    token: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    decimals: 6,
    confirmations: 30,
    chainLabel: "Polygon (USDT)",
    gasSymbol: "POL",
    transferGas: 80_000n,
    lowGas: 1_000_000_000_000_000_000n, // 1 POL
  },
};

export class EvmUsdtAdapter implements ChainAdapter {
  readonly code: string;
  readonly asset = "USDT";
  readonly chainLabel: string;
  readonly decimals: number;
  readonly stable = true;
  readonly confirmations: number;
  readonly quoteDecimals = 2;
  readonly defaultSweepMinUsd = 1;
  private readonly spec: EvmSpec;
  private client: Pub | null = null;

  constructor(code: "usdtbsc" | "usdtmatic") {
    const spec = SPECS[code];
    if (!spec) throw new Error(`unknown EVM spec ${code}`);
    this.spec = spec;
    this.code = spec.code;
    this.chainLabel = spec.chainLabel;
    this.decimals = spec.decimals;
    this.confirmations = spec.confirmations;
  }

  private pub(): Pub {
    if (!this.client) this.client = makeClient(this.spec.chain, this.spec.rpc());
    return this.client;
  }

  private async account(index: number) {
    const { privateKey } = await deriveSecp(PATHS.evm(index));
    return privateKeyToAccount(`0x${bytesToHex(privateKey)}` as Hex);
  }

  async address(index: number): Promise<string> {
    return (await this.account(index)).address;
  }

  validateAddress(addr: string): boolean {
    return isAddress(addr);
  }

  private async tokenBalance(addr: Address, blockNumber?: bigint): Promise<bigint> {
    if (blockNumber !== undefined) {
      return this.pub().readContract({ address: this.spec.token, abi: ERC20, functionName: "balanceOf", args: [addr], blockNumber });
    }
    return this.pub().readContract({ address: this.spec.token, abi: ERC20, functionName: "balanceOf", args: [addr] });
  }

  async scan(address: string): Promise<{ confirmed: bigint; pending: bigint; txids: string[] }> {
    const addr = address as Address;
    const latest = await this.pub().getBlockNumber();
    const pending = await this.tokenBalance(addr);
    if (pending === 0n) return { confirmed: 0n, pending: 0n, txids: [] };
    const safeBlock = latest - BigInt(this.spec.confirmations);
    let confirmed = pending;
    try {
      confirmed = await this.tokenBalance(addr, safeBlock);
    } catch {
      // Public RPCs sometimes refuse historical state; fall back to the
      // transfer logs, which every node serves.
      const logs = await this.pub().getLogs({
        address: this.spec.token,
        event: TRANSFER,
        args: { to: addr },
        fromBlock: latest - 5000n,
        toBlock: latest,
      });
      confirmed = logs
        .filter((l) => l.blockNumber !== null && l.blockNumber <= safeBlock)
        .reduce((s, l) => s + (l.args.value ?? 0n), 0n);
      if (confirmed > pending) confirmed = pending;
    }
    return { confirmed, pending: pending - confirmed, txids: [] };
  }

  async sweep(index: number, payout: string, minUnits: bigint): Promise<SweepResult> {
    const pub = this.pub();
    const payer = await this.account(index);
    const balance = await this.tokenBalance(payer.address);
    if (balance === 0n) return { kind: "skipped", note: "nothing to sweep" };
    if (balance < minUnits) return { kind: "skipped", note: `below sweep minimum (${fmtUnits(balance, this.decimals, 2)} USDT)` };

    const gasPrice = await pub.getGasPrice();
    const needed = this.spec.transferGas * gasPrice * 12n / 10n; // +20 % headroom
    const native = await pub.getBalance({ address: payer.address });
    if (native < needed) {
      // Step 1: fund the payment address from the main address.
      const main = await this.account(0);
      const mainBal = await pub.getBalance({ address: main.address });
      const sendGas = 21_000n * gasPrice;
      const topUp = needed - native;
      if (mainBal < topUp + sendGas) {
        return { kind: "pending", note: `main address ${main.address} needs ${this.spec.gasSymbol} for gas (has ${formatEther(mainBal)}, needs ≥ ${formatEther(topUp + sendGas)})` };
      }
      const wallet = createWalletClient({ account: main, chain: this.spec.chain, transport: http(this.spec.rpc(), { timeout: 15_000 }) });
      const hash = await wallet.sendTransaction({ to: payer.address, value: topUp, gas: 21_000n });
      return { kind: "pending", note: `gas sent (${hash}) — transfer on next tick` };
    }
    // Step 2: move the USDT.
    const wallet = createWalletClient({ account: payer, chain: this.spec.chain, transport: http(this.spec.rpc(), { timeout: 15_000 }) });
    const hash = await wallet.writeContract({
      address: this.spec.token, abi: ERC20, functionName: "transfer", args: [payout as Address, balance], gas: this.spec.transferGas,
    });
    return { kind: "done", txid: hash, amount: balance };
  }

  async gas(): Promise<GasInfo | null> {
    const main = await this.account(0);
    const bal = await this.pub().getBalance({ address: main.address });
    return {
      address: main.address,
      symbol: this.spec.gasSymbol,
      balance: formatEther(bal),
      low: bal < this.spec.lowGas,
      hint: `Send a little ${this.spec.gasSymbol} here; each sweep uses ≈ ${formatEther(this.spec.transferGas * 3_000_000_000n)} ${this.spec.gasSymbol} at 3 gwei.`,
    };
  }
}
