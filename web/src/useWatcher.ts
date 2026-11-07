import { useEffect, useRef, useState } from "react";
import { BrowserWatcher, type TipResult, type WatcherStats } from "./watcher";
import type { Finding } from "../../src/detectors/types";
import type { Meta, Ev } from "./useSwarm";
import { API } from "./api";

/**
 * Runs the white-blood-cell watcher in this tab once the swarm's settings are
 * known, and feeds the transactions it sees into the map.
 */
export function useWatcher(meta: Meta | null, inject: (e: Ev) => void) {
  const [stats, setStats] = useState<WatcherStats | null>(null);
  const [lastTip, setLastTip] = useState<(TipResult & { at: number }) | null>(null);
  const [observed, setObserved] = useState<(Finding & { at: number })[]>([]);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const started = !!meta?.dataUrl;

  useEffect(() => {
    const m = metaRef.current;
    if (!m?.dataUrl || !m.rpcUrl) return;
    const w = new BrowserWatcher({
      network: m.network,
      dataUrl: m.dataUrl,
      rpcUrl: m.rpcUrl,
      api: API,
      master: m.master,
      protectedNames: () => [...(metaRef.current?.protected ?? []), metaRef.current?.master ?? ""].filter(Boolean),
      knownBadCode: () => new Map(Object.entries(metaRef.current?.memory ?? {})),
      onBlock: (txs, st) => {
        setStats({ ...st });
        for (const t of txs) {
          inject({
            type: "tx",
            hash: t.hash,
            signer: t.signer,
            receiver: t.receiver,
            kinds: [...new Set(t.actions.map((a) => a.kind))],
            height: t.height,
            demo: t.signer.endsWith(`.${m.master}`) || t.receiver.endsWith(`.${m.master}`),
            network: m.network,
            source: "browser",
          });
        }
      },
      onFinding: (f, tip) => {
        if (tip) setLastTip({ ...tip, at: Date.now() });
        else setObserved((o) => [{ ...f, at: Date.now() }, ...o].slice(0, 30));
        setStats({ ...w.stats });
      },
    }).start();
    return () => w.stop();
  }, [started, inject]);

  return { stats, lastTip, observed };
}
