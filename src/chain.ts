import { config } from "./config.js";
import { balanceOf, rpc } from "./near.js";
import { wasmExports } from "./detectors/contract.js";
import type { ChainView } from "./detectors/types.js";

/** Chain lookups with a short cache, shared by every detector. */
export function chainView(rpcUrl = config.rpcUrl): ChainView {
  const methods = new Map<string, { at: number; value: string[] | null }>();
  return {
    balance: (id) => balanceOf(id, rpcUrl),
    async contractMethods(accountId) {
      const hit = methods.get(accountId);
      if (hit && Date.now() - hit.at < 60_000) return hit.value;
      let value: string[] | null = null;
      try {
        const r: any = await rpc("query", { request_type: "view_code", finality: "optimistic", account_id: accountId }, rpcUrl);
        value = wasmExports(Buffer.from(r.code_base64, "base64"));
      } catch {
        value = null;
      }
      methods.set(accountId, { at: Date.now(), value });
      return value;
    },
  };
}
