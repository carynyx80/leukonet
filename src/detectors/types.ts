import type { Tx } from "../blocks.js";

/** Must match the contract's `Category` enum. */
export type Category = "Drainer" | "KeyHijack" | "MaliciousContract" | "RogueAgent" | "Lookalike" | "Other";

export interface Finding {
  target: string;
  category: Category;
  /** 1 (suspicious) to 10 (actively stealing funds). */
  severity: number;
  /** One-line, human-readable reason. Replaced by the LLM explanation when available. */
  reason: string;
  /** Facts a second sentinel can re-check on chain. */
  evidence: {
    txs: string[];
    height: number;
    [k: string]: unknown;
  };
  detector: string;
}

/**
 * Chain lookups a detector may need. Injected so detectors stay testable and
 * so the same code can watch testnet or mainnet.
 */
export interface ChainView {
  balance(accountId: string): Promise<bigint | null>;
  /** Exported function names of the contract deployed on an account. */
  contractMethods(accountId: string): Promise<string[] | null>;
  /** True when transaction `hash` exists and went from `sender` to `receiver`. */
  txMatches(hash: string, sender: string, receiver: string): Promise<boolean>;
}

export interface Detector {
  name: string;
  /** Called for every transaction, in block order. */
  inspect(tx: Tx, chain: ChainView): Promise<Finding[]>;
  /** Re-check another sentinel's finding from its evidence; true = confirmed. */
  verify?(finding: { target: string; evidence: any }, chain: ChainView): Promise<boolean>;
}

/** Per-sentinel tuning, so the swarm does not all think alike. */
export interface Thresholds {
  /** Share of a balance that counts as "swept" (0-1). */
  sweepShare: number;
  /** Distinct swept victims before an account is called a drainer. */
  drainerVictims: number;
  /** Blocks after a full-access key is added in which a sweep counts as a hijack. */
  hijackWindow: number;
  /** Spending spike multiple over an agent's median payment. */
  rogueMultiple: number;
  /** Payments needed before an agent has a baseline. */
  rogueMinHistory: number;
  /** Maximum edit distance for a name to count as a look-alike. */
  lookalikeDistance: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  sweepShare: 0.8,
  drainerVictims: 3,
  hijackWindow: 120,
  rogueMultiple: 10,
  rogueMinHistory: 4,
  lookalikeDistance: 2,
};
