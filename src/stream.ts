import { EventEmitter } from "node:events";
import { baseEncode } from "near-api-js";
import { rpc } from "./near.js";
import { config } from "./config.js";

export type ActionKind =
  | "CreateAccount"
  | "Transfer"
  | "FunctionCall"
  | "AddKey"
  | "DeleteKey"
  | "DeployContract"
  | "DeleteAccount"
  | "Other";

export interface TxAction {
  kind: ActionKind;
  deposit?: bigint;
  method?: string;
  args?: any;
  publicKey?: string;
  fullAccess?: boolean;
  /** For DeployContract: sha256 of the code, base58 (the RPC only returns the hash). */
  codeHash?: string;
  beneficiary?: string;
}

export interface Tx {
  hash: string;
  signer: string;
  receiver: string;
  publicKey: string;
  actions: TxAction[];
  height: number;
  timestampMs: number;
  /** Signer's balance right after the transaction was processed (from neardata state changes). */
  signerBalanceAfter?: bigint;
}

export interface BlockEvent {
  height: number;
  hash: string;
  timestampMs: number;
  txs: Tx[];
  /** How many blocks behind the chain head we are. */
  lag: number;
}

function parseAction(raw: any): TxAction {
  if (raw === "CreateAccount") return { kind: "CreateAccount" };
  const [kind, body] = Object.entries(raw)[0] as [string, any];
  switch (kind) {
    case "Transfer":
      return { kind, deposit: BigInt(body.deposit) };
    case "FunctionCall": {
      let args: any = undefined;
      try {
        args = JSON.parse(Buffer.from(body.args, "base64").toString());
      } catch {
        args = undefined;
      }
      return { kind, method: body.method_name, args, deposit: BigInt(body.deposit ?? 0) };
    }
    case "AddKey":
      return {
        kind,
        publicKey: body.public_key,
        fullAccess: body.access_key?.permission === "FullAccess",
      };
    case "DeleteKey":
      return { kind, publicKey: body.public_key };
    case "DeployContract":
      return { kind, codeHash: baseEncode(Buffer.from(body.code, "base64")) };
    case "DeleteAccount":
      return { kind, beneficiary: body.beneficiary_id };
    default:
      return { kind: "Other" };
  }
}

/** Same block via plain RPC (block + its chunks), used when neardata rate-limits us. */
async function fetchBlockRpc(height: number, rpcUrl?: string): Promise<Omit<BlockEvent, "lag"> | null> {
  let block: any;
  try {
    block = await rpc("block", { block_id: height }, rpcUrl);
  } catch (e: any) {
    if (/UNKNOWN_BLOCK|DB Not Found|not found/i.test(String(e?.message))) return null;
    throw e;
  }
  const timestampMs = Math.floor(Number(block.header.timestamp_nanosec) / 1e6);
  const chunks = block.chunks.filter((c: any) => c.height_included === height && c.tx_root !== "11111111111111111111111111111111");
  const bodies: any[] = await Promise.all(chunks.map((c: any) => rpc("chunk", { chunk_id: c.chunk_hash }, rpcUrl)));
  const txs: Tx[] = bodies.flatMap((ch) =>
    ch.transactions.map((t: any) => ({
      hash: t.hash,
      signer: t.signer_id,
      receiver: t.receiver_id,
      publicKey: t.public_key,
      actions: (t.actions ?? []).map(parseAction),
      height,
      timestampMs,
    })),
  );
  return { height, hash: block.header.hash, timestampMs, txs };
}

async function fetchBlock(height: number, dataUrl: string, rpcUrl?: string): Promise<Omit<BlockEvent, "lag"> | null> {
  let res = await fetch(`${dataUrl}/v0/block/${height}`);
  for (let i = 0; res.status === 429 && i < 2; i++) {
    await sleep(500 * (i + 1));
    res = await fetch(`${dataUrl}/v0/block/${height}`);
  }
  if (res.status === 429) return fetchBlockRpc(height, rpcUrl);
  if (!res.ok) {
    const e = new Error(`neardata ${res.status}`);
    (e as any).retryAfterMs = Number(res.headers.get("retry-after") ?? 0) * 1000;
    throw e;
  }
  const data: any = await res.json();
  // Heights can be skipped by the chain; neardata returns null for those.
  if (!data) return null;
  const timestampMs = Math.floor(Number(data.block.header.timestamp_nanosec) / 1e6);
  // tx hash + account -> balance after the transaction debited it
  const after = new Map<string, bigint>();
  for (const shard of data.shards ?? []) {
    for (const sc of shard.state_changes ?? []) {
      if (sc.type === "account_update" && sc.cause?.type === "transaction_processing") {
        after.set(`${sc.cause.tx_hash}|${sc.change.account_id}`, BigInt(sc.change.amount));
      }
    }
  }
  const txs: Tx[] = [];
  for (const shard of data.shards ?? []) {
    for (const entry of shard.chunk?.transactions ?? []) {
      const t = entry.transaction;
      txs.push({
        hash: t.hash,
        signer: t.signer_id,
        receiver: t.receiver_id,
        publicKey: t.public_key,
        actions: (t.actions ?? []).map(parseAction),
        height,
        timestampMs,
        signerBalanceAfter: after.get(`${t.hash}|${t.signer_id}`),
      });
    }
  }
  return { height, hash: data.block.header.hash, timestampMs, txs };
}

/**
 * Follows the chain head and emits every block with its transactions, in order.
 * Fetches a few heights in parallel to keep up with ~1s block times.
 */
/** Chain head from neardata's redirect, so following the chain costs no RPC calls. */
async function headHeight(dataUrl: string, rpcUrl?: string): Promise<number> {
  try {
    const res = await fetch(`${dataUrl}/v0/last_block/final`, { redirect: "manual" });
    const m = (res.headers.get("location") ?? "").match(/(\d+)$/);
    if (m) return Number(m[1]);
  } catch {
    /* fall through */
  }
  return (await rpc("block", { finality: "final" }, rpcUrl)).header.height;
}

export class BlockStream extends EventEmitter {
  private next = 0;
  private running = false;
  private failures = 0;
  constructor(
    private opts: { startHeight?: number; maxLag?: number; parallel?: number; pollMs?: number; rpcUrl?: string; dataUrl?: string } = {},
  ) {
    super();
  }

  async start() {
    this.running = true;
    this.next = this.opts.startHeight ?? (await headHeight(this.opts.dataUrl ?? config.dataUrl, this.opts.rpcUrl));
    this.loop().catch((e) => this.emit("error", e));
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    const maxLag = this.opts.maxLag ?? 150;
    const parallel = this.opts.parallel ?? 3;
    const pollMs = this.opts.pollMs ?? 700;
    while (this.running) {
      let head: number;
      try {
        head = await headHeight(this.opts.dataUrl ?? config.dataUrl, this.opts.rpcUrl);
      } catch (e) {
        this.emit("warn", `head fetch failed: ${(e as Error).message}`);
        await sleep(pollMs * 2);
        continue;
      }
      if (head - this.next > maxLag) {
        this.emit("warn", `fell ${head - this.next} blocks behind, skipping ahead`);
        this.next = head - 2;
      }
      while (this.running && this.next <= head) {
        const heights: number[] = [];
        // Fetch more at once only when catching up, to stay under the free rate limits.
        const width = head - this.next > 3 ? parallel + 2 : Math.min(parallel, 2);
        for (let h = this.next; h <= head && heights.length < width; h++) heights.push(h);
        const results = await Promise.allSettled(heights.map((h) => fetchBlock(h, this.opts.dataUrl ?? config.dataUrl, this.opts.rpcUrl)));
        // Emit in order and stop at the first failure: a block is retried, never dropped.
        let failed: any = null;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === "rejected") {
            failed = r.reason;
            break;
          }
          if (r.value) this.emit("block", { ...r.value, lag: head - r.value.height } satisfies BlockEvent);
          this.next = heights[i] + 1;
        }
        if (failed) {
          this.failures++;
          if (this.failures === 1 || this.failures % 10 === 0) this.emit("warn", `block ${this.next}: ${failed.message}, retrying`);
          await sleep(Math.max(failed.retryAfterMs ?? 0, Math.min(400 * 2 ** this.failures, 5000)));
        } else {
          this.failures = 0;
        }
      }
      await sleep(pollMs);
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
