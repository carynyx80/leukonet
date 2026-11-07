import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { view } from "./near.js";
import { BlockStream, type BlockEvent, type Tx } from "./stream.js";
import { chainView } from "./chain.js";
import type { Hub } from "./hub.js";
import { ImmuneMemory } from "./memory.js";
import { Sentinel } from "./sentinel.js";
import type { Detector, Finding } from "./detectors/types.js";
import { DEFAULT_THRESHOLDS } from "./detectors/types.js";
import { lookalikeDetector } from "./detectors/lookalike.js";
import { drainerDetector, keyHijackDetector } from "./detectors/sweep.js";
import { maliciousContractDetector } from "./detectors/contract.js";
import { rogueAgentDetector } from "./detectors/rogue.js";

const DEMO_FILE = path.join(ROOT, "data", "demo.json");

/** Accounts the attack simulator created, and the names it protects. */
export interface DemoState {
  protected: string[];
  accounts: string[];
}

const reportsOpen = (r: any[]) => r?.some((x) => x.status === "Open");

export function readDemoState(): DemoState {
  try {
    return JSON.parse(fs.readFileSync(DEMO_FILE, "utf8"));
  } catch {
    // Fresh host: start from LEUKONET_PROTECTED (comma-separated), set by `npm run export-env`.
    const prot = (process.env.LEUKONET_PROTECTED ?? "").split(",").filter(Boolean);
    return { protected: prot, accounts: [...prot] };
  }
}

export function writeDemoState(s: DemoState) {
  fs.mkdirSync(path.dirname(DEMO_FILE), { recursive: true });
  fs.writeFileSync(DEMO_FILE, JSON.stringify(s, null, 2));
}

export function addDemoAccounts(...ids: string[]) {
  const s = readDemoState();
  for (const id of ids) if (!s.accounts.includes(id)) s.accounts.push(id);
  writeDemoState(s);
}

/** Well-known mainnet names, protected in watch-only mode. */
export const MAINNET_PROTECTED = [
  "wrap.near",
  "ref-finance.near",
  "v2.ref-finance.near",
  "app.ref-finance.near",
  "intents.near",
  "meta-pool.near",
  "linear-protocol.near",
  "burrow.near",
  "token.sweat",
  "usdt.tether-token.near",
  "aurora",
  "near",
  "relay.aurora",
  "hot.tg",
  "game.hot.tg",
  "nearkat.near",
  "social.near",
  "lockup.near",
  "poolv1.near",
];

const DETECTOR_OWNER: Record<string, string> = {
  drainer: "neutrophil",
  key_hijack: "neutrophil",
  malicious_contract: "macrophage",
  immune_memory: "macrophage",
  rogue_agent: "nk-cell",
  lookalike: "t-helper",
};

export interface SwarmOptions {
  network: "testnet" | "mainnet";
  /** Watch only: detect and display, never write to the registry. */
  readOnly: boolean;
  rpcUrl: string;
  dataUrl: string;
}

export class Swarm {
  readonly memory = new ImmuneMemory();
  private detectors: Detector[];
  private seen = new Map<string, number>();
  private findingSeq = 0;
  private queue: BlockEvent[] = [];
  private busy = false;
  private finalizing = new Set<number>();
  private pollCount = 0;
  private stream: BlockStream;
  private chain;

  constructor(
    private hub: Hub,
    private opts: SwarmOptions,
    readonly sentinels: Sentinel[] = [],
  ) {
    this.chain = chainView(opts.rpcUrl);
    const protectedNames = () =>
      opts.network === "mainnet" ? MAINNET_PROTECTED : [...readDemoState().protected, ...(config.master ? [config.master] : [])];
    this.detectors = [
      lookalikeDetector(protectedNames, DEFAULT_THRESHOLDS),
      drainerDetector(DEFAULT_THRESHOLDS),
      keyHijackDetector(DEFAULT_THRESHOLDS),
      maliciousContractDetector(this.memory),
      rogueAgentDetector(DEFAULT_THRESHOLDS),
    ];
    this.stream = new BlockStream({ rpcUrl: opts.rpcUrl, dataUrl: opts.dataUrl });
  }

  async start() {
    this.stream.on("block", (b: BlockEvent) => {
      this.queue.push(b);
      void this.drain();
    });
    this.stream.on("warn", (w) => this.hub.log(`[${this.opts.network}] ${w}`, "warn"));
    this.stream.on("error", (e) => this.hub.log(`[${this.opts.network}] stream stopped: ${e.message}`, "warn"));
    await this.stream.start();
    if (!this.opts.readOnly) this.pollRegistry();
    this.hub.log(`${this.opts.network} swarm watching${this.opts.readOnly ? " (read-only)" : ""} with ${this.sentinels.length} sentinels`);
  }

  /** Blocks are processed strictly in order so detectors see history correctly. */
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const b = this.queue.shift()!;
        this.hub.publish({ type: "block", height: b.height, txs: b.txs.length, lag: b.lag, ts: b.timestampMs, network: this.opts.network });
        const demo = readDemoState();
        const demoSet = new Set(demo.accounts);
        for (const tx of b.txs) {
          const isDemo = this.isDemo(tx.signer, demoSet) || this.isDemo(tx.receiver, demoSet);
          this.hub.publish({
            type: "tx",
            hash: tx.hash,
            signer: tx.signer,
            receiver: tx.receiver,
            kinds: [...new Set(tx.actions.map((a) => a.kind))],
            height: tx.height,
            demo: isDemo,
            network: this.opts.network,
          });
        }
        await Promise.all(b.txs.map((tx) => this.inspect(tx, demoSet)));
      }
    } finally {
      this.busy = false;
    }
  }

  private isDemo(id: string, demoSet: Set<string>) {
    return demoSet.has(id) || (!!config.master && id.endsWith(`.${config.master}`)) || id === config.master;
  }

  private async inspect(tx: Tx, demoSet: Set<string>) {
    for (const d of this.detectors) {
      let findings: Finding[] = [];
      try {
        findings = await d.inspect(tx, this.chain);
      } catch (e: any) {
        this.hub.log(`${d.name} failed on ${tx.hash}: ${e.message}`, "warn");
      }
      for (const f of findings) this.onFinding(f, demoSet, tx);
    }
  }

  private onFinding(f: Finding, demoSet: Set<string>, tx: Tx) {
    const key = `${f.target}|${f.category}`;
    const last = this.seen.get(key);
    if (last && Date.now() - last < 10 * 60_000) return;
    this.seen.set(key, Date.now());

    // On testnet the swarm stakes only on accounts in the demo, so it never accuses strangers
    // with real (test) money; everything else is shown as observed.
    const involved = [f.target, tx.signer, tx.receiver, ...(Array.isArray(f.evidence.victims) ? f.evidence.victims : [])];
    const inScope =
      !this.opts.readOnly &&
      (process.env.FLAG_SCOPE === "all" || involved.some((id) => this.isDemo(String(id), demoSet)));

    const owner = this.sentinels.find((s) => s.persona.name === DETECTOR_OWNER[f.detector]);
    const id = `f${++this.findingSeq}-${this.opts.network}`;
    this.hub.publish({
      type: "finding",
      id,
      sentinel: owner?.persona.name ?? DETECTOR_OWNER[f.detector] ?? f.detector,
      detector: f.detector,
      category: f.category,
      target: f.target,
      severity: f.severity,
      reason: f.reason,
      evidence: f.evidence,
      scope: inScope && owner ? "filed" : "observed",
      network: this.opts.network,
      ts: Date.now(),
    });
    if (inScope && owner) void owner.file(f, id);
  }

  /**
   * A tip from a visitor's browser, which runs the same detectors on its own
   * copy of the chain. Tips are untrusted: the sentinel that owns the detector
   * re-verifies the evidence on chain before anything is filed or staked.
   */
  async tip(f: Finding): Promise<{ accepted: boolean; reason: string; findingId?: string }> {
    const owner = this.sentinels.find((s) => s.persona.name === DETECTOR_OWNER[f.detector]);
    if (!owner) return { accepted: false, reason: "No sentinel handles that kind of finding." };
    const key = `${f.target}|${f.category}`;
    const last = this.seen.get(key);
    if (last && Date.now() - last < 10 * 60_000) return { accepted: false, reason: "The swarm already has this one." };

    const demoSet = new Set(readDemoState().accounts);
    const e = f.evidence ?? {};
    const involved = [f.target, e.victim, e.payee, e.creator, ...(Array.isArray(e.victims) ? e.victims : [])].filter(Boolean).map(String);
    const inScope = process.env.FLAG_SCOPE === "all" || involved.some((id) => this.isDemo(id, demoSet));
    if (!inScope) return { accepted: false, reason: "Outside the demo: observed only, never reported." };

    if (!(await owner.check(f.category, f.target, e))) {
      return { accepted: false, reason: `${owner.persona.name} could not confirm it on chain.` };
    }
    // Verified: same path as the swarm's own findings.
    this.seen.set(key, Date.now());
    const id = `f${++this.findingSeq}-${this.opts.network}`;
    this.hub.publish({
      type: "finding",
      id,
      sentinel: owner.persona.name,
      detector: f.detector,
      category: f.category,
      target: f.target,
      severity: f.severity,
      reason: f.reason,
      evidence: e,
      scope: "filed",
      network: this.opts.network,
      ts: Date.now(),
      source: "browser",
    });
    void owner.file({ ...f, evidence: e }, id);
    return { accepted: true, reason: `${owner.persona.name} verified it on chain and is reporting it.`, findingId: id };
  }

  /** Polls the registry and lets every sentinel weigh in on open reports. */
  private pollRegistry() {
    const tick = async () => {
      try {
        // Reports drive voting, so they are polled fast; the rest changes rarely.
        const slow = this.pollCount++ % 5 === 0;
        const [reports, stats, sentinels, verdicts, cfg] = await Promise.all([
          view(config.registry, "get_reports", { from_index: 0, limit: 20 }),
          slow ? view(config.registry, "get_stats") : this.hub.state.stats,
          slow ? view(config.registry, "get_sentinels") : this.hub.state.sentinels,
          slow ? view(config.registry, "get_verdicts", { from_index: 0, limit: 100 }) : this.hub.state.verdicts,
          this.hub.state.config ?? view(config.registry, "get_config"),
        ]);
        this.hub.state = { reports, sentinels, stats, verdicts, config: cfg };
        this.hub.emit("state", this.hub.state);
        const nowNs = BigInt(Date.now()) * 1_000_000n;
        for (const r of reports as any[]) {
          if (r.status === "Confirmed" && r.category === "MaliciousContract") {
            try {
              const ev = JSON.parse(r.evidence);
              if (ev.codeHash && this.memory.remember(ev.codeHash, r.id)) {
                this.hub.publish({ type: "memory", codeHash: ev.codeHash, reportId: r.id });
                this.hub.log(`immune memory: remembered code ${ev.codeHash.slice(0, 10)}… from report #${r.id}`);
              }
            } catch {
              /* ignore */
            }
          }
          if (r.status !== "Open") continue;
          for (const s of this.sentinels) void s.consider(r);
          const allVoted = this.sentinels.every((s) => r.votes.some((v: any) => v.sentinel === s.id));
          const expired = nowNs >= BigInt(r.deadline_ns);
          if ((allVoted || expired) && !this.finalizing.has(r.id)) {
            const coordinator = this.sentinels.find((s) => s.persona.coordinator) ?? this.sentinels[0];
            this.finalizing.add(r.id);
            void coordinator.finalize(r.id).then((ok) => {
              if (!ok) setTimeout(() => this.finalizing.delete(r.id), 5000);
            });
          }
        }
      } catch (e: any) {
        this.hub.log(`registry poll failed: ${e.message}`, "warn");
      }
      setTimeout(tick, reportsOpen(this.hub.state.reports) ? 2000 : 5000);
    };
    void tick();
  }
}
