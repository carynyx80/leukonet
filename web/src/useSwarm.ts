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
  watchers?: { count: number; tips: number; verified: number };
  dataUrl?: string;
  rpcUrl?: string;
  funds?: { master: string | null; sentinels: Record<string, string>; low: boolean; checkedAt: number };
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
  /** The swarm could not be reached (yet). */
  offline?: boolean;
}

const cap = <T,>(arr: T[], n: number) => (arr.length > n ? arr.slice(arr.length - n) : arr);

/** Subscribes to the swarm's server-sent events and keeps a rolling view of everything. */
export function useSwarm(): [SwarmState, (fn: (e: Ev) => void) => () => void, (e: Ev) => void, number] {
  const listeners = useRef(new Set<(e: Ev) => void>());
  // The server's stream and this browser's own watcher both report transactions; count each once.
  const seenTx = useRef<string[]>([]);
  const seenSet = useRef(new Set<string>());
  const firstSighting = (hash: string) => {
    if (seenSet.current.has(hash)) return false;
    seenSet.current.add(hash);
    seenTx.current.push(hash);
    if (seenTx.current.length > 4000) seenSet.current.delete(seenTx.current.shift()!);
    return true;
  };
  const [watchers, setWatchers] = useState(0);
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

    // The snapshot is retried until it loads, and its meta (funds, running attack,
    // watcher count) is refreshed every half minute so status notices never go stale.
    let loaded = false;
    let fails = 0;
    const refreshMeta = async () => {
      try {
        const snap = await (await fetch(`${API}/api/state`)).json();
        if (snap.meta?.watchers) setWatchers(snap.meta.watchers.count);
        set((p) => ({ ...p, meta: snap.meta, offline: false }));
      } catch {
        /* keep the last meta */
      }
    };
    const metaTimer = setInterval(() => loaded && void refreshMeta(), 30_000);
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`${API}/api/state`);
        const snap = await res.json();
        if (snap.meta?.watchers) setWatchers(snap.meta.watchers.count);
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
          return { ...next, offline: false };
        });
        loaded = true;
      } catch {
        fails++;
        if (fails >= 2) set((p) => ({ ...p, offline: true }));
        if (!stopped) setTimeout(() => void load(), Math.min(2000 * fails, 15_000));
      }
    };
    const boot = async () => {
      await load();
      if (stopped) return;
      es = new EventSource(`${API}/api/events`);
      es.onopen = () => set((p) => ({ ...p, connected: true }));
      es.onerror = () => set((p) => ({ ...p, connected: false }));
      es.addEventListener("hub", (m) => {
        const e = JSON.parse((m as MessageEvent).data);
        if (e.type === "watchers") setWatchers(e.count);
        if (e.type === "tx" && !firstSighting(e.hash)) return;
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
      clearInterval(metaTimer);
      es?.close();
    };
  }, []);

  const subscribe = useCallback((fn: (e: Ev) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  /** Events produced in this browser (its own watcher), delivered to the same listeners. */
  const inject = useCallback((e: Ev) => {
    if (e.type === "tx" && !firstSighting(e.hash)) return;
    listeners.current.forEach((fn) => fn(e));
  }, []);
  return [s, subscribe, inject, watchers];
}
