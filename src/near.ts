import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { config, loadKey } from "./config.js";

export const YOCTO = 10n ** 24n;
export const near = (n: number | string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
export const fmtNear = (y: bigint | string, digits = 3) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(digits);
export const TGAS = 10n ** 12n;

/**
 * Free public RPCs rate-limit, especially from shared cloud IPs. Calls to the
 * default testnet RPC rotate through this pool on 429s and network errors.
 * Override with NEAR_RPC_URLS (comma-separated).
 */
const RPC_POOL = (process.env.NEAR_RPC_URLS ?? `${config.rpcUrl},https://near-testnet.lava.build,https://rpc.testnet.near.org`)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
let preferred = 0;

const providers = new Map<string, any>();
export function provider(url = config.rpcUrl): any {
  let p = providers.get(url);
  if (!p) {
    p =
      url === config.rpcUrl && RPC_POOL.length > 1
        ? new FailoverRpcProvider(RPC_POOL.map((u) => new JsonRpcProvider({ url: u })))
        : new JsonRpcProvider({ url });
    providers.set(url, p);
  }
  return p;
}

export const isRateLimit = (e: unknown) => /429|rate limit|too many requests|TooManyRequests/i.test(String((e as any)?.message ?? e));

/** Raw JSON-RPC call with retries; the default RPC rotates through the pool. */
export async function rpc<T = any>(method: string, params: unknown, url = config.rpcUrl): Promise<T> {
  let lastErr: unknown;
  const pooled = url === config.rpcUrl && RPC_POOL.length > 1;
  for (let attempt = 0; attempt < (pooled ? RPC_POOL.length + 3 : 4); attempt++) {
    const target = pooled ? RPC_POOL[(preferred + attempt) % RPC_POOL.length] : url;
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "leukonet", method, params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`RPC ${res.status}`);
      if (pooled && attempt > 0) preferred = (preferred + attempt) % RPC_POOL.length;
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
      if (e?.rpcError && !/TIMEOUT|INTERNAL|429|rate/i.test(JSON.stringify(e.rpcError))) throw e;
      await new Promise((r) => setTimeout(r, pooled ? 150 : 300 * 2 ** attempt));
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

/** Retries a transaction that was rejected by a rate limit (it was never accepted, so this is safe). */
async function retryRateLimited<T>(job: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await job();
    } catch (e) {
      if (!isRateLimit(e) || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
}

/** Serializes transactions per account so nonces never collide, and rides out rate limits. */
const queues = new Map<string, Promise<unknown>>();
export function serial<T>(accountId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(accountId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => retryRateLimited(job));
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
