/** Registry lookups and name checks shared by the popup, background and page scanner. */
import { imitates } from "../../src/detectors/lookalike";
import { MAINNET_PROTECTED } from "../../src/protected";

export const DEFAULTS = {
  registry: "registry.leukonet-mw43jm6i.testnet",
  rpcUrl: "https://rpc.testnet.fastnear.com",
  explorer: "https://testnet.nearblocks.io",
  site: "https://leukonet.vercel.app",
};
export const ACCOUNT_RE = /\b(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*\.(?:testnet|near)\b/g;

export interface Verdict {
  account_id: string;
  /** confirmed scam, open report, impostor name, or clean (so far) */
  level: "scam" | "pending" | "impostor" | "clean" | "unknown";
  risk: number;
  categories: string[];
  report_ids: number[];
  imitates?: string;
  error?: string;
}

const cache = new Map<string, { at: number; v: Verdict }>();

export async function settings() {
  try {
    const s = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...s } as typeof DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

async function isSafe(id: string, s: typeof DEFAULTS) {
  const res = await fetch(s.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "guard",
      method: "query",
      params: { request_type: "call_function", finality: "optimistic", account_id: s.registry, method_name: "is_safe", args_base64: btoa(JSON.stringify({ account_id: id })) },
    }),
  });
  const body = await res.json();
  if (body.error || !body.result?.result) throw new Error("registry unavailable");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
}

export async function check(id: string): Promise<Verdict> {
  id = id.trim().toLowerCase();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const s = await settings();
  const fake = id.endsWith(".near") ? imitates(id, MAINNET_PROTECTED, 2) : null;
  let v: Verdict;
  try {
    const c = await isSafe(id, s);
    const level = !c.safe ? "scam" : c.pending_reports.length ? "pending" : fake ? "impostor" : "clean";
    v = { account_id: id, level, risk: c.risk, categories: c.categories, report_ids: c.safe ? c.pending_reports : c.report_ids, imitates: fake ?? undefined };
  } catch (e: any) {
    v = { account_id: id, level: fake ? "impostor" : "unknown", risk: 0, categories: [], report_ids: [], imitates: fake ?? undefined, error: String(e?.message ?? e) };
  }
  cache.set(id, { at: Date.now(), v });
  return v;
}

export function sentence(v: Verdict): string {
  const human = (c: string) => c.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  switch (v.level) {
    case "scam":
      return `Do not pay. Confirmed ${v.categories.map(human).join(", ")} (risk ${v.risk}/100, report #${v.report_ids.join(", #")}).`;
    case "pending":
      return `Careful: report #${v.report_ids.join(", #")} against this account is being voted on right now.`;
    case "impostor":
      return `Looks like an impostor of ${v.imitates}. Check the exact name before paying.`;
    case "clean":
      return "No confirmed threats. That means not caught yet, not guaranteed safe.";
    default:
      return "Couldn't reach the registry. Try again in a moment.";
  }
}
