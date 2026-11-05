import type { Tx } from "../stream.js";
import type { Detector, Finding, Thresholds } from "./types.js";

/** Characters scammers swap for look-alikes. */
const HOMOGLYPHS: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", i: "l" };

export function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .split("")
    .map((c) => HOMOGLYPHS[c] ?? c)
    .join("")
    .replace(/[-_.]/g, "");
}

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Split "pay.leukonet.testnet" into its first label and the parent suffix. */
function split(accountId: string): [string, string] {
  const i = accountId.indexOf(".");
  return i < 0 ? [accountId, ""] : [accountId.slice(0, i), accountId.slice(i + 1)];
}

/** Returns the protected name `candidate` imitates, if any. */
export function imitates(candidate: string, protectedNames: string[], maxDistance: number): string | null {
  if (protectedNames.includes(candidate)) return null;
  const [label, parent] = split(candidate);
  for (const p of protectedNames) {
    const [pLabel, pParent] = split(p);
    if (parent !== pParent) continue;
    if (pLabel.length < 4) continue;
    if (label === pLabel) continue;
    const nCand = normalize(label);
    const nProt = normalize(pLabel);
    const dist = editDistance(nCand, nProt);
    // Same after normalization (homoglyphs) or within a small edit distance.
    if (nCand === nProt || (dist > 0 && dist <= maxDistance && dist < pLabel.length / 3)) return p;
  }
  return null;
}

/** New accounts named to imitate an account people already trust. */
export function lookalikeDetector(protectedNames: () => string[], t: Thresholds): Detector {
  const createdAccount = (tx: Tx): string | null => {
    if (tx.actions.some((a) => a.kind === "CreateAccount")) return tx.receiver;
    // Top-level .testnet / .near names are created through the registrar contract.
    for (const a of tx.actions) {
      if (a.kind === "FunctionCall" && a.method === "create_account" && typeof a.args?.new_account_id === "string") {
        return a.args.new_account_id;
      }
    }
    return null;
  };

  return {
    name: "lookalike",
    async inspect(tx) {
      const created = createdAccount(tx);
      if (!created) return [];
      const victim = imitates(created, protectedNames(), t.lookalikeDistance);
      if (!victim) return [];
      const f: Finding = {
        target: created,
        category: "Lookalike",
        severity: 6,
        reason: `New account ${created} imitates ${victim}`,
        evidence: { txs: [tx.hash], height: tx.height, imitates: victim, creator: tx.signer },
        detector: "lookalike",
      };
      return [f];
    },
    async verify(f) {
      return imitates(f.target, protectedNames(), t.lookalikeDistance) !== null;
    },
  };
}
