/**
 * The browser watcher: this tab becomes a white blood cell.
 *
 * It streams NEAR blocks straight from FastNear's neardata over the visitor's
 * own connection (so it is never throttled with the server), runs the exact
 * same detector code as the swarm, and sends what it finds to the swarm as a
 * tip. Tips are untrusted: a sentinel re-verifies every one on chain before
 * staking anything on it.
 */
import { parseNeardataBlock, type Tx } from "../../src/blocks";
import { fromBase64 } from "../../src/units";
import { DEFAULT_THRESHOLDS, type ChainView, type Detector, type Finding } from "../../src/detectors/types";
import { lookalikeDetector } from "../../src/detectors/lookalike";
import { drainerDetector, keyHijackDetector } from "../../src/detectors/sweep";
import { maliciousContractDetector, wasmExports } from "../../src/detectors/contract";
import { rogueAgentDetector } from "../../src/detectors/rogue";

export interface WatcherStats {
  running: boolean;
  network: string;
  height: number;
  lag: number;
  blocks: number;
  txs: number;
  findings: number;
  tipsSent: number;
  tipsVerified: number;
  /** New accounts and contract deployments inspected (what the radar looks at). */
  accounts: number;
  deploys: number;
  error?: string;
}

export interface TipResult {
  finding: Finding;
  accepted: boolean;
  reason: string;
}

export interface WatcherOptions {
  network: string;
  dataUrl: string;
  rpcUrl: string;
  api: string;
  /** Accounts under this master belong to the demo: the only ones we tip about. */
  master: string;
  protectedNames: () => string[];
  knownBadCode: () => Map<string, number>;
  /** Read-only: never sends tips (used for the mainnet radar). */
  readOnly?: boolean;
  /** Which detectors to run (default: all five). */
  only?: string[];
  onBlock?: (txs: Tx[], stats: WatcherStats) => void;
  onFinding?: (f: Finding, tip?: TipResult) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function browserChain(rpcUrl: string): ChainView {
  const call = async (method: string, params: unknown) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "watcher", method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result;
  };
  const codeCache = new Map<string, string[] | null>();
  return {
    async balance(id) {
      try {
        return BigInt((await call("query", { request_type: "view_account", finality: "optimistic", account_id: id })).amount);
      } catch {
        return null;
      }
    },
    async contractMethods(id) {
      if (codeCache.has(id)) return codeCache.get(id)!;
      let value: string[] | null = null;
      for (let i = 0; i < 3 && value === null; i++) {
        try {
          const r = await call("query", { request_type: "view_code", finality: "optimistic", account_id: id });
          value = wasmExports(fromBase64(r.code_base64));
        } catch {
          await sleep(800); // the deploy may land a block after we see the transaction
        }
      }
      codeCache.set(id, value);
      return value;
    },
    async txMatches(hash, sender, receiver) {
      try {
        const r = await call("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" });
        return r.transaction?.signer_id === sender && r.transaction?.receiver_id === receiver;
      } catch {
        return false;
      }
    },
  };
}

export class BrowserWatcher {
  readonly stats: WatcherStats;
  private detectors: Detector[];
  private chain: ChainView;
  private next = 0;
  private head = 0;
  private stopped = false;
  private seen = new Set<string>();

  constructor(private o: WatcherOptions) {
    this.stats = { running: false, network: o.network, height: 0, lag: 0, blocks: 0, txs: 0, findings: 0, tipsSent: 0, tipsVerified: 0, accounts: 0, deploys: 0 };
    this.chain = browserChain(o.rpcUrl);
    this.detectors = [
      lookalikeDetector(o.protectedNames, DEFAULT_THRESHOLDS),
      drainerDetector(DEFAULT_THRESHOLDS),
      keyHijackDetector(DEFAULT_THRESHOLDS),
      maliciousContractDetector({ knownBad: o.knownBadCode }),
      rogueAgentDetector(DEFAULT_THRESHOLDS),
    ].filter((d) => !o.only || o.only.includes(d.name));
  }

  start() {
    this.stats.running = true;
    void this.loop();
    return this;
  }

  stop() {
    this.stopped = true;
    this.stats.running = false;
  }

  /**
   * neardata answers a rate-limited request without CORS headers, so the browser
   * only sees "Failed to fetch". Treat that like a 429: back off and retry.
   */
  private async getJson(url: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(url);
      } catch {
        res = null; // network error or a CORS-less 429
      }
      if (res?.ok) return res.json();
      if ((res && res.status !== 429) || attempt >= 5) throw new Error(res ? `neardata ${res.status}` : "network");
      await sleep(Math.min(400 * 2 ** attempt, 4000));
    }
  }

  private async loop() {
    while (!this.stopped) {
      try {
        // Hidden tab: rest, then rejoin at the head instead of replaying the backlog.
        if (document.visibilityState === "hidden") {
          this.next = 0;
          await sleep(1000);
          continue;
        }
        if (this.next === 0 || this.next > this.head) {
          // last_block/final redirects to the newest block, so this is both the head and a block.
          const data = await this.getJson(`${this.o.dataUrl}/v0/last_block/final`);
          const block = parseNeardataBlock(data);
          if (!block) continue;
          this.head = block.height;
          if (this.next === 0 || this.head - this.next > 60) this.next = this.head;
          if (this.next === this.head) {
            await this.process(block.txs, block.height);
            this.next = this.head + 1;
            // About one testnet block time: asking sooner usually returns the same block.
            await sleep(1050);
          }
          continue;
        }
        const data = await this.getJson(`${this.o.dataUrl}/v0/block/${this.next}`);
        const block = parseNeardataBlock(data);
        if (block) await this.process(block.txs, block.height);
        this.next++;
        this.stats.error = undefined;
      } catch (e: any) {
        this.stats.error = String(e?.message ?? e);
        await sleep(1500);
      }
    }
  }

  private involvesDemo(f: Finding, tx: Tx) {
    const e = f.evidence as any;
    const ids = [f.target, tx.signer, tx.receiver, e?.victim, e?.payee, e?.creator, ...(Array.isArray(e?.victims) ? e.victims : [])].filter(Boolean).map(String);
    const suffix = `.${this.o.master}`;
    return f.detector === "lookalike" || ids.some((id) => id === this.o.master || id.endsWith(suffix));
  }

  private async process(txs: Tx[], height: number) {
    this.stats.blocks++;
    this.stats.txs += txs.length;
    for (const tx of txs) {
      for (const a of tx.actions) {
        if (a.kind === "CreateAccount" || (a.kind === "FunctionCall" && a.method === "create_account")) this.stats.accounts++;
        if (a.kind === "DeployContract") this.stats.deploys++;
      }
    }
    this.stats.height = height;
    this.stats.lag = Math.max(0, this.head - height);
    this.o.onBlock?.(txs, this.stats);
    for (const tx of txs) {
      for (const d of this.detectors) {
        let found: Finding[] = [];
        try {
          found = await d.inspect(tx, this.chain);
        } catch {
          continue;
        }
        for (const f of found) {
          const key = `${f.target}|${f.category}`;
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          this.stats.findings++;
          if (this.o.readOnly || !this.involvesDemo(f, tx)) {
            this.o.onFinding?.(f);
            continue;
          }
          void this.sendTip(f);
        }
      }
    }
  }

  private async sendTip(f: Finding) {
    this.stats.tipsSent++;
    let result: TipResult = { finding: f, accepted: false, reason: "Could not reach the swarm." };
    try {
      const res = await fetch(`${this.o.api}/api/tip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      const body = await res.json();
      result = { finding: f, accepted: !!body.accepted, reason: String(body.reason ?? "") };
    } catch {
      /* keep the default */
    }
    if (result.accepted) this.stats.tipsVerified++;
    this.o.onFinding?.(f, result);
  }
}
