import type { Detector, Finding } from "./types.js";

/** Method names that only make sense in a wallet-draining lure. */
export const LURE_METHODS = [
  "claim_airdrop",
  "airdrop_claim",
  "verify_wallet",
  "validate_wallet",
  "connect_wallet",
  "sync_wallet",
  "claim_reward",
  "unlock_reward",
  "rectify_wallet",
  "migrate_wallet",
];

/** Reads the names of the functions a wasm module exports. */
export function wasmExports(code: Uint8Array): string[] {
  let p = 8; // magic + version
  const leb = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = code[p++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
  };
  while (p < code.length) {
    const id = code[p++];
    const size = leb();
    const end = p + size;
    if (id === 7) {
      const names: string[] = [];
      const count = leb();
      for (let i = 0; i < count; i++) {
        const len = leb();
        const name = new TextDecoder().decode(code.subarray(p, p + len));
        p += len;
        const kind = code[p++];
        leb(); // index
        if (kind === 0) names.push(name);
      }
      return names;
    }
    p = end;
  }
  return [];
}

/**
 * Malicious contracts. Immune memory first: code already confirmed malicious
 * is recognised instantly by its hash, whatever account it is deployed to.
 * New code is judged by the lure methods it exposes.
 */
export function maliciousContractDetector(memory: { knownBad: () => Map<string, number> }): Detector {
  return {
    name: "malicious_contract",
    async inspect(tx, chain) {
      const deploy = tx.actions.find((a) => a.kind === "DeployContract");
      if (!deploy?.codeHash) return [];
      const remembered = memory.knownBad().get(deploy.codeHash);
      if (remembered !== undefined) {
        const f: Finding = {
          target: tx.receiver,
          category: "MaliciousContract",
          severity: 9,
          reason: `${tx.receiver} deployed code already confirmed malicious in report #${remembered}`,
          evidence: { txs: [tx.hash], height: tx.height, codeHash: deploy.codeHash, matchesReport: remembered },
          detector: "immune_memory",
        };
        return [f];
      }
      const methods = await chain.contractMethods(tx.receiver);
      if (!methods) return [];
      const lures = methods.filter((m) => LURE_METHODS.includes(m));
      if (lures.length === 0) return [];
      const f: Finding = {
        target: tx.receiver,
        category: "MaliciousContract",
        severity: 8,
        reason: `${tx.receiver} deployed a contract exposing lure methods: ${lures.join(", ")}`,
        evidence: { txs: [tx.hash], height: tx.height, codeHash: deploy.codeHash, lures },
        detector: "malicious_contract",
      };
      return [f];
    },
    async verify(f, chain) {
      if (f.evidence?.codeHash && memory.knownBad().has(f.evidence.codeHash)) return true;
      const methods = await chain.contractMethods(f.target);
      return !!methods?.some((m) => LURE_METHODS.includes(m));
    },
  };
}
