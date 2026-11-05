import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "./api";

export interface Meta {
  registry: string;
  master: string;
  network: string;
  explorer: string;
  demoControls: boolean;
  attackRunning: string | null;
  attacks: { kind: string; label: string; story: string }[];
  protected: string[];
  memory: Record<string, number>;
  personas: { name: string; role: string; specialties: string[]; coordinator: boolean }[];
  sentinelAccounts: Record<string, string>;
  nearAi: boolean;
  watchMainnet: boolean;
}

export type Ev = { type: string; [k: string]: any };

export interface SwarmState {
  connected: boolean;
  meta: Meta | null;
  reports: any[];
  sentinels: any[];
  stats: any;
  verdicts: any[];
  config: any;
  blocks: Ev[];
  txs: Ev[];
  findings: Ev[];
  explains: Record<string, Ev>;
  chain: Ev[];
  attack: Ev[];
  memory: Ev[];
  attackRunning: string | null;
  /** Monotonic counter so canvas effects can react to new events. */
  tick: number;
}

const cap = <T,>(arr: T[], n: number) => (arr.length > n ? arr.slice(arr.length - n) : arr);

/** Subscribes to the swarm's server-sent events and keeps a rolling view of everything. */
export function useSwarm(): [SwarmState, (fn: (e: Ev) => void) => () => void] {
  const listeners = useRef(new Set<(e: Ev) => void>());
  const [s, set] = useState<SwarmState>({
    connected: false,
    meta: null,
    reports: [],
    sentinels: [],
    stats: null,
    verdicts: [],
    config: null,
    blocks: [],
    txs: [],
    findings: [],
    explains: {},
    chain: [],
    attack: [],
    memory: [],
    attackRunning: null,
    tick: 0,
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;

    const apply = (prev: SwarmState, e: Ev): SwarmState => {
      switch (e.type) {
        case "block":
          return { ...prev, blocks: cap([...prev.blocks, e], 120) };
        case "tx":
          return { ...prev, txs: cap([...prev.txs, e], 200) };
        case "finding":
          return { ...prev, findings: cap([...prev.findings, e], 80) };
        case "explain":
          return { ...prev, explains: { ...prev.explains, [e.findingId]: e } };
        case "chain":
          return { ...prev, chain: cap([...prev.chain, e], 200) };
        case "memory":
          return { ...prev, memory: [...prev.memory, e] };
        case "attack": {
          const fresh = e.stage === "start" ? [e] : [...prev.attack, e];
          return {
            ...prev,
            attack: fresh,
            attackRunning: e.stage === "done" ? null : e.kind,
          };
        }
        default:
          return prev;
      }
    };

    const boot = async () => {
      try {
        const res = await fetch(`${API}/api/state`);
        const snap = await res.json();
        set((prev) => {
          let next: SwarmState = {
            ...prev,
            meta: snap.meta,
            reports: snap.reports ?? [],
            sentinels: snap.sentinels ?? [],
            stats: snap.stats,
            verdicts: snap.verdicts ?? [],
            config: snap.config,
            attackRunning: snap.meta?.attackRunning ?? null,
          };
          for (const e of snap.events ?? []) next = apply(next, e);
          return next;
        });
      } catch {
        /* server not up yet; EventSource will retry */
      }
      if (stopped) return;
      es = new EventSource(`${API}/api/events`);
      es.onopen = () => set((p) => ({ ...p, connected: true }));
      es.onerror = () => set((p) => ({ ...p, connected: false }));
      es.addEventListener("hub", (m) => {
        const e = JSON.parse((m as MessageEvent).data);
        listeners.current.forEach((fn) => fn(e));
        set((p) => ({ ...apply(p, e), tick: p.tick + 1 }));
      });
      es.addEventListener("state", (m) => {
        const st = JSON.parse((m as MessageEvent).data);
        set((p) => ({ ...p, ...st }));
      });
    };
    void boot();
    return () => {
      stopped = true;
      es?.close();
    };
  }, []);

  const subscribe = useCallback((fn: (e: Ev) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  return [s, subscribe];
}
