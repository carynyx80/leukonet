import { fmtNear, near } from "../units.js";
import type { Detector, Finding, Thresholds } from "./types.js";

const median = (xs: bigint[]) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};

/**
 * Rogue agent: an account with a steady payment pattern suddenly sends many
 * times its usual amount to an account it has never paid before.
 */
export function rogueAgentDetector(t: Thresholds, minAmount = near(0.2)): Detector {
  const history = new Map<string, { amounts: bigint[]; payees: Set<string> }>();

  return {
    name: "rogue_agent",
    async inspect(tx) {
      const amount = tx.actions.reduce((s, a) => s + (a.kind === "Transfer" ? a.deposit ?? 0n : 0n), 0n);
      if (amount === 0n || tx.signer === tx.receiver) return [];
      const h = history.get(tx.signer) ?? { amounts: [], payees: new Set<string>() };
      const findings: Finding[] = [];
      if (h.amounts.length >= t.rogueMinHistory && !h.payees.has(tx.receiver) && amount >= minAmount) {
        const med = median(h.amounts);
        const multiple = med > 0n ? Number((amount * 100n) / med) / 100 : Infinity;
        if (multiple >= t.rogueMultiple) {
          findings.push({
            target: tx.signer,
            category: "RogueAgent",
            severity: 7,
            reason: `${tx.signer} sent ${fmtNear(amount)} NEAR to a new payee, ${multiple.toFixed(0)}x its usual ${fmtNear(med)} NEAR`,
            evidence: {
              txs: [tx.hash],
              height: tx.height,
              payee: tx.receiver,
              amount: amount.toString(),
              median: med.toString(),
              history: h.amounts.length,
              multiple,
            },
            detector: "rogue_agent",
          });
        }
      }
      h.amounts.push(amount);
      if (h.amounts.length > 50) h.amounts.shift();
      h.payees.add(tx.receiver);
      history.set(tx.signer, h);
      return findings;
    },
    async verify(f, chain) {
      const e = f.evidence;
      if (!(Number(e?.history) >= t.rogueMinHistory && Number(e?.multiple) >= t.rogueMultiple)) return false;
      // The spike payment itself must exist on chain, from this agent to the claimed payee.
      return Array.isArray(e?.txs) && typeof e.payee === "string" && chain.txMatches(e.txs[0], f.target, e.payee);
    },
  };
}
