/**
 * Transactions as the detectors see them, and the parser for FastNear's
 * neardata block format. Pure: shared by the server stream and the browser
 * watcher, so both feed the detectors exactly the same thing.
 */
import { base58, bytesToText, fromBase64 } from "./units.js";

export type ActionKind = "CreateAccount" | "Transfer" | "FunctionCall" | "AddKey" | "DeleteKey" | "DeployContract" | "DeleteAccount" | "Other";

export interface TxAction {
  kind: ActionKind;
  deposit?: bigint;
  method?: string;
  args?: any;
  publicKey?: string;
  fullAccess?: boolean;
  /** For DeployContract: sha256 of the code, base58 (the chain only returns the hash). */
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

export interface ParsedBlock {
  height: number;
  hash: string;
  timestampMs: number;
  txs: Tx[];
}

export function parseAction(raw: any): TxAction {
  if (raw === "CreateAccount") return { kind: "CreateAccount" };
  const [kind, body] = Object.entries(raw)[0] as [string, any];
  switch (kind) {
    case "Transfer":
      return { kind, deposit: BigInt(body.deposit) };
    case "FunctionCall": {
      let args: any = undefined;
      try {
        args = JSON.parse(bytesToText(fromBase64(body.args)));
      } catch {
        args = undefined;
      }
      return { kind, method: body.method_name, args, deposit: BigInt(body.deposit ?? 0) };
    }
    case "AddKey":
      return { kind, publicKey: body.public_key, fullAccess: body.access_key?.permission === "FullAccess" };
    case "DeleteKey":
      return { kind, publicKey: body.public_key };
    case "DeployContract":
      return { kind, codeHash: base58(fromBase64(body.code)) };
    case "DeleteAccount":
      return { kind, beneficiary: body.beneficiary_id };
    default:
      return { kind: "Other" };
  }
}

/** A neardata `/v0/block/{height}` body (or null for a skipped height). */
export function parseNeardataBlock(data: any): ParsedBlock | null {
  if (!data) return null;
  const height: number = data.block.header.height;
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
