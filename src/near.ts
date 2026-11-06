import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";
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
/** Endpoint -> time until which it is skipped after misbehaving. */
const coolUntil = new Map<string, number>();

const providers = new Map<string, JsonRpcProvider>();
/** Transactions always go to one endpoint (FastNear by default); serial() rides out its rate limits. */
export function provider(url = config.rpcUrl): JsonRpcProvider {
  let p = providers.get(url);
  if (!p) {
    p = new JsonRpcProvider({ url });
    providers.set(url, p);
  }
  return p;
}

export const isRateLimit = (e: unknown) => /429|rate limit|too many requests|TooManyRequests/i.test(String((e as any)?.message ?? e));

/** An endpoint problem (as opposed to a genuine answer such as "unknown block" or a contract panic). */
class EndpointError extends Error {
  constructor(
    message: string,
    readonly coolMs: number,
  ) {
    super(message);
  }
}

async function callOnce(target: string, method: string, params: unknown) {
  let res: Response;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "leukonet", method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    throw new EndpointError(`network: ${e?.message ?? e}`, 30_000);
  }
  if (res.status === 429) throw new EndpointError("RPC 429", 30_000);
  if (res.status >= 500) throw new EndpointError(`RPC ${res.status}`, 30_000);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new EndpointError(`RPC ${res.status}: not JSON`, 10 * 60_000);
  }
  if (body?.error) {
    const text = JSON.stringify(body.error);
    // A bare string error ("This endpoint has been discontinued.") or overload is the endpoint's fault.
    if (typeof body.error === "string" || /discontinued|deprecated|rate|429|TIMEOUT|INTERNAL/i.test(text)) {
      throw new EndpointError(text, /discontinued|deprecated/i.test(text) ? 60 * 60_000 : 30_000);
    }
    const e = new Error(text);
    (e as any).rpcError = body.error;
    throw e;
  }
  if (body?.result === undefined) throw new EndpointError("RPC reply without a result", 10 * 60_000);
  return body.result;
}

/**
 * Raw JSON-RPC call. Calls to the default testnet RPC try each healthy endpoint
 * in the pool in order, so the primary is always preferred once it recovers;
 * an endpoint that misbehaves is skipped for a while.
 */
export async function rpc<T = any>(method: string, params: unknown, url = config.rpcUrl): Promise<T> {
  const pool = url === config.rpcUrl ? RPC_POOL : [url];
  let lastErr: unknown;
  for (let round = 0; round < 3; round++) {
    const now = Date.now();
    const healthy = pool.filter((u) => (coolUntil.get(u) ?? 0) <= now);
    for (const target of healthy.length ? healthy : pool) {
      try {
        return (await callOnce(target, method, params)) as T;
      } catch (e: any) {
        lastErr = e;
        if (!(e instanceof EndpointError)) throw e; // a real answer: unknown block, contract panic...
        if (pool.length > 1) coolUntil.set(target, Date.now() + e.coolMs);
      }
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** round));
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
