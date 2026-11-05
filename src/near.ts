import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { config, loadKey } from "./config.js";

export const YOCTO = 10n ** 24n;
export const near = (n: number | string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
export const fmtNear = (y: bigint | string, digits = 3) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(digits);
export const TGAS = 10n ** 12n;

const providers = new Map<string, JsonRpcProvider>();
export function provider(url = config.rpcUrl): JsonRpcProvider {
  let p = providers.get(url);
  if (!p) {
    p = new JsonRpcProvider({ url });
    providers.set(url, p);
  }
  return p;
}

/** Raw JSON-RPC call with a few retries; the public RPC rate-limits bursts. */
export async function rpc<T = any>(method: string, params: unknown, url = config.rpcUrl): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "leukonet", method, params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`RPC ${res.status}`);
      const body: any = await res.json();
      if (body.error) {
        const msg = JSON.stringify(body.error);
        // Unknown block/chunk right at the head: let the caller decide.
        const e = new Error(msg);
        (e as any).rpcError = body.error;
        throw e;
      }
      return body.result as T;
    } catch (e: any) {
      lastErr = e;
      if (e?.rpcError && !/TIMEOUT|INTERNAL/i.test(JSON.stringify(e.rpcError))) throw e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export function accountFor(name: string): Account {
  const key = loadKey(name);
  return new Account(key.accountId, provider(), key.privateKey as any);
}

export function accountFromKey(accountId: string, privateKey: string): Account {
  return new Account(accountId, provider(), privateKey as any);
}

export async function view<T = any>(contractId: string, method: string, args: object = {}, url = config.rpcUrl): Promise<T> {
  const res = await rpc<any>(
    "query",
    {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    url,
  );
  return JSON.parse(Buffer.from(res.result).toString());
}

export async function balanceOf(accountId: string, url = config.rpcUrl): Promise<bigint | null> {
  try {
    const r = await rpc<any>("query", { request_type: "view_account", finality: "optimistic", account_id: accountId }, url);
    return BigInt(r.amount);
  } catch {
    return null;
  }
}

/** Serializes transactions per account so nonces never collide. */
const queues = new Map<string, Promise<unknown>>();
export function serial<T>(accountId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(accountId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  queues.set(accountId, next);
  return next;
}

export interface CallResult {
  hash: string;
  value: any;
}

export async function call(
  account: Account,
  contractId: string,
  method: string,
  args: object,
  deposit: bigint = 0n,
  gas: bigint = 60n * TGAS,
): Promise<CallResult> {
  return serial(account.accountId, async () => {
    const res: any = await account.signAndSendTransaction({
      receiverId: contractId,
      actions: [actions.functionCall(method, args, gas, deposit)],
      waitUntil: "EXECUTED_OPTIMISTIC",
    } as any);
    const hash = res.transaction?.hash ?? res.transaction_outcome?.id;
    let value: any = undefined;
    const ok = res.status?.SuccessValue;
    if (ok) {
      try {
        value = JSON.parse(Buffer.from(ok, "base64").toString());
      } catch {
        value = undefined;
      }
    }
    return { hash, value };
  });
}

export async function transfer(account: Account, receiverId: string, amount: bigint): Promise<string> {
  return serial(account.accountId, async () => {
    const res: any = await account.signAndSendTransaction({
      receiverId,
      actions: [actions.transfer(amount)],
      waitUntil: "EXECUTED_OPTIMISTIC",
    } as any);
    return res.transaction?.hash;
  });
}

export function newKeyPair() {
  return KeyPair.fromRandom("ed25519");
}

export { Account, KeyPair, KeyPairSigner, actions };
