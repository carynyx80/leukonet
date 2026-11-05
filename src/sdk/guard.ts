/**
 * Leukonet guard: check an account against the swarm's registry before paying it.
 *
 *   import { checkBeforePay, guardedTransfer } from "leukonet/sdk";
 *   const check = await checkBeforePay("someone.testnet");
 *   if (!check.safe) console.log(check.categories, check.risk);
 *
 * The check is a free view call; no wallet or key is needed.
 */

export interface SafetyCheck {
  account_id: string;
  safe: boolean;
  /** 0 (no known issues) to 100 (confirmed active threat). */
  risk: number;
  categories: string[];
  report_ids: number[];
  /** Reports still being voted on. */
  pending_reports: number[];
}

export interface GuardOptions {
  /** Registry contract, e.g. registry.leukonet-xyz.testnet */
  registry: string;
  rpcUrl?: string;
  /** Refuse while a report is still open (default: false, only confirmed threats block). */
  blockPending?: boolean;
  /** Refuse at or above this risk even without a confirmed verdict (default 50). */
  maxRisk?: number;
}

export class LeukonetBlocked extends Error {
  constructor(readonly check: SafetyCheck) {
    super(
      `Leukonet blocked payment to ${check.account_id}: ${check.categories.join(", ") || "pending report"} (risk ${check.risk}/100)`,
    );
    this.name = "LeukonetBlocked";
  }
}

export async function checkBeforePay(accountId: string, opts: GuardOptions): Promise<SafetyCheck> {
  const rpcUrl = opts.rpcUrl ?? "https://rpc.testnet.fastnear.com";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "guard",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: opts.registry,
        method_name: "is_safe",
        args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString("base64"),
      },
    }),
  });
  const body: any = await res.json();
  if (body.error || !body.result?.result) throw new Error(`Leukonet registry unavailable: ${JSON.stringify(body.error ?? body)}`);
  return JSON.parse(Buffer.from(body.result.result).toString());
}

/** True when the payment should be refused under the given options. */
export function shouldBlock(check: SafetyCheck, opts: Pick<GuardOptions, "blockPending" | "maxRisk">): boolean {
  if (!check.safe) return true;
  if (opts.blockPending && check.pending_reports.length > 0) return true;
  return check.risk >= (opts.maxRisk ?? 50);
}

/**
 * Wraps any payment function: runs the check first and throws LeukonetBlocked
 * instead of paying a flagged account.
 */
export async function guarded<T>(receiverId: string, opts: GuardOptions, pay: () => Promise<T>): Promise<T> {
  const check = await checkBeforePay(receiverId, opts);
  if (shouldBlock(check, opts)) throw new LeukonetBlocked(check);
  return pay();
}
