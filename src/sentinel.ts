import type { Account } from "near-api-js";
import { config } from "./config.js";
import { call, near } from "./near.js";
import { explain } from "./explain.js";
import type { Hub } from "./hub.js";
import type { ChainView, Detector, Finding, Thresholds } from "./detectors/types.js";
import { lookalikeDetector } from "./detectors/lookalike.js";
import { drainerDetector, keyHijackDetector } from "./detectors/sweep.js";
import { maliciousContractDetector } from "./detectors/contract.js";
import { rogueAgentDetector } from "./detectors/rogue.js";
import type { ImmuneMemory } from "./memory.js";

export const STAKE = near(0.02);

export interface Persona {
  name: string;
  role: string;
  /** Detectors whose findings this sentinel files on chain. */
  specialties: string[];
  thresholds: Thresholds;
  /** Closes reports once voting is done. */
  coordinator?: boolean;
}

/** Category (as stored on chain) -> detector able to re-check it. */
const VERIFIER_FOR: Record<string, string> = {
  Drainer: "drainer",
  KeyHijack: "key_hijack",
  MaliciousContract: "malicious_contract",
  RogueAgent: "rogue_agent",
  Lookalike: "lookalike",
};

export class Sentinel {
  readonly voted = new Set<number>();
  private verifiers = new Map<string, Detector>();
  private lastFlagAt = 0;

  constructor(
    readonly persona: Persona,
    readonly account: Account,
    private hub: Hub,
    private chain: ChainView,
    memory: ImmuneMemory,
    protectedNames: () => string[],
  ) {
    // Each sentinel re-checks evidence with its own thresholds, so verdicts are independent.
    const t = persona.thresholds;
    for (const d of [
      lookalikeDetector(protectedNames, t),
      drainerDetector(t),
      keyHijackDetector(t),
      maliciousContractDetector(memory),
      rogueAgentDetector(t),
    ]) {
      this.verifiers.set(d.name, d);
    }
  }

  get id() {
    return this.account.accountId;
  }

  /** Explain a finding and stake on it in the registry. */
  async file(f: Finding, findingId: string): Promise<number | null> {
    // Simple spend guard: at most one new report every 3 seconds per sentinel.
    const wait = this.lastFlagAt + 3000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastFlagAt = Date.now();

    const { text, source } = await explain(f);
    this.hub.publish({ type: "explain", findingId, text, source });
    const evidence = JSON.stringify({ ...f.evidence, detector: f.detector }).slice(0, 2000);
    try {
      const res = await call(
        this.account,
        config.registry,
        "flag",
        { target: f.target, category: f.category, severity: f.severity, summary: text.slice(0, 400), evidence },
        STAKE,
      );
      const reportId = typeof res.value === "number" ? res.value : null;
      if (reportId !== null) this.voted.add(reportId);
      this.hub.publish({ type: "chain", sentinel: this.persona.name, action: "flag", reportId: reportId ?? undefined, hash: res.hash, ok: true, ts: Date.now() });
      return reportId;
    } catch (e: any) {
      this.hub.publish({ type: "chain", sentinel: this.persona.name, action: "flag", ok: false, error: shortError(e), ts: Date.now() });
      return null;
    }
  }

  /**
   * Re-check a claim (from another sentinel or a visitor's browser) against the
   * chain with this sentinel's own thresholds. Never trusts the claimant.
   */
  async check(category: string, target: string, evidence: any): Promise<boolean> {
    const verifier = this.verifiers.get(VERIFIER_FOR[category] ?? "");
    if (!verifier?.verify) return false;
    try {
      // The accused account must actually exist.
      if ((await this.chain.balance(target)) === null) return false;
      return await verifier.verify({ target, evidence }, this.chain);
    } catch {
      return false;
    }
  }

  /** Independently re-check an open report and vote with stake. */
  async consider(report: any) {
    if (this.voted.has(report.id) || report.reporter === this.id) return;
    if (report.votes.some((v: any) => v.sentinel === this.id)) {
      this.voted.add(report.id);
      return;
    }
    this.voted.add(report.id);
    const verifier = this.verifiers.get(VERIFIER_FOR[report.category] ?? "");
    let evidence: any = {};
    try {
      evidence = JSON.parse(report.evidence || "{}");
    } catch {
      /* unreadable evidence counts against the report */
    }
    let support = false;
    try {
      support = verifier ? await verifier.verify!({ target: report.target, evidence }, this.chain) : false;
    } catch {
      support = false;
    }
    const note = support ? `${this.persona.name}: evidence checks out` : `${this.persona.name}: could not confirm with my thresholds`;
    try {
      const res = await call(this.account, config.registry, "vote", { report_id: report.id, support, note }, STAKE);
      this.hub.publish({ type: "chain", sentinel: this.persona.name, action: "vote", reportId: report.id, support, hash: res.hash, ok: true, ts: Date.now() });
    } catch (e: any) {
      this.hub.publish({ type: "chain", sentinel: this.persona.name, action: "vote", reportId: report.id, support, ok: false, error: shortError(e), ts: Date.now() });
    }
  }

  async finalize(reportId: number) {
    try {
      const res = await call(this.account, config.registry, "finalize", { report_id: reportId }, 0n);
      this.hub.publish({ type: "chain", sentinel: this.persona.name, action: "finalize", reportId, hash: res.hash, ok: true, ts: Date.now() });
      return true;
    } catch (e: any) {
      this.hub.publish({ type: "chain", sentinel: this.persona.name, action: "finalize", reportId, ok: false, error: shortError(e), ts: Date.now() });
      return false;
    }
  }
}

export function shortError(e: any): string {
  const s = String(e?.message ?? e);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/);
  return (m ? m[1] : s).slice(0, 160);
}

/** The five cells of the swarm. Different thresholds mean they can disagree. */
export const PERSONAS: Persona[] = [
  {
    name: "neutrophil",
    role: "First responder. Catches drainers and hijacked keys.",
    specialties: ["drainer", "key_hijack"],
    thresholds: { sweepShare: 0.8, drainerVictims: 3, hijackWindow: 120, rogueMultiple: 10, rogueMinHistory: 4, lookalikeDistance: 2 },
  },
  {
    name: "macrophage",
    role: "Inspects newly deployed contracts for lure code.",
    specialties: ["malicious_contract", "immune_memory"],
    thresholds: { sweepShare: 0.75, drainerVictims: 3, hijackWindow: 150, rogueMultiple: 8, rogueMinHistory: 4, lookalikeDistance: 2 },
  },
  {
    name: "nk-cell",
    role: "Watches agents for spending that breaks their pattern.",
    specialties: ["rogue_agent"],
    thresholds: { sweepShare: 0.8, drainerVictims: 3, hijackWindow: 120, rogueMultiple: 8, rogueMinHistory: 4, lookalikeDistance: 2 },
  },
  {
    name: "t-helper",
    role: "Spots look-alike names and closes finished votes.",
    specialties: ["lookalike"],
    thresholds: { sweepShare: 0.85, drainerVictims: 3, hijackWindow: 100, rogueMultiple: 10, rogueMinHistory: 5, lookalikeDistance: 2 },
    coordinator: true,
  },
  {
    name: "b-cell",
    role: "The sceptic. Strictest thresholds; keeps the immune memory.",
    specialties: [],
    thresholds: { sweepShare: 0.9, drainerVictims: 3, hijackWindow: 90, rogueMultiple: 15, rogueMinHistory: 5, lookalikeDistance: 1 },
  },
];
