import { EventEmitter } from "node:events";

export type HubEvent =
  | { type: "block"; height: number; txs: number; lag: number; ts: number; network: string }
  | { type: "tx"; hash: string; signer: string; receiver: string; kinds: string[]; height: number; demo: boolean; network: string }
  | {
      type: "finding";
      id: string;
      sentinel: string;
      detector: string;
      category: string;
      target: string;
      severity: number;
      reason: string;
      evidence: any;
      scope: "filed" | "observed";
      network: string;
      ts: number;
      /** "browser" when a visitor's browser spotted it first and the swarm verified it. */
      source?: "swarm" | "browser";
    }
  | { type: "explain"; findingId: string; text: string; source: string }
  | {
      type: "chain";
      sentinel: string;
      action: "flag" | "vote" | "finalize" | "register";
      reportId?: number;
      support?: boolean;
      hash?: string;
      ok: boolean;
      error?: string;
      ts: number;
    }
  | { type: "memory"; codeHash: string; reportId: number }
  | { type: "attack"; kind: string; stage: string; detail?: string; hash?: string; ts: number }
  | { type: "log"; level: "info" | "warn"; message: string; ts: number }
  | { type: "watchers"; count: number; tips: number; verified: number };

/** In-process event bus with a replay buffer for newly connected dashboards. */
export class Hub extends EventEmitter {
  private recent: HubEvent[] = [];
  /** Latest polled registry state, served with the snapshot. */
  state: { reports: any[]; sentinels: any[]; stats: any; verdicts: any[]; config: any } = {
    reports: [],
    sentinels: [],
    stats: null,
    verdicts: [],
    config: null,
  };

  publish(e: HubEvent) {
    // Keep the replay buffer small but make sure blocks do not crowd out findings.
    this.recent.push(e);
    if (this.recent.length > 600) {
      const idx = this.recent.findIndex((x) => x.type === "block" || x.type === "tx");
      this.recent.splice(idx >= 0 ? idx : 0, 1);
    }
    this.emit("event", e);
  }

  log(message: string, level: "info" | "warn" = "info") {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
    level === "warn" ? console.warn(line) : console.log(line);
    this.publish({ type: "log", level, message, ts: Date.now() });
  }

  snapshot() {
    return { events: this.recent, ...this.state };
  }
}
