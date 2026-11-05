import { useEffect, useRef } from "react";
import type { Ev } from "./useSwarm";

interface Props {
  personas: { name: string }[];
  sentinelAccounts: Record<string, string>;
  reports: any[];
  subscribe: (fn: (e: Ev) => void) => () => void;
}

interface Particle { a: number; r: number; v: number; demo: boolean; born: number }
interface Pulse { from: string; reportId: number; color: string; born: number }

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
};
const short = (id: string, n = 26) => (id.length > n ? `${id.slice(0, n - 12)}…${id.slice(-9)}` : id);

/**
 * The bloodstream: every transaction on testnet drifts in from the edge.
 * Sentinels sit on the inner ring around the registry; flagged accounts appear
 * on the outer ring with live lines for each sentinel's vote.
 */
export function ThreatMap({ personas, sentinelAccounts, reports, subscribe }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const pulses = useRef<Pulse[]>([]);
  const flashes = useRef<Record<string, number>>({});
  const reportsRef = useRef(reports);
  reportsRef.current = reports;

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "tx") {
          if (particles.current.length > 260) particles.current.shift();
          particles.current.push({ a: hash(e.hash) * Math.PI * 2, r: 1.0, v: 0.0016 + hash(e.signer) * 0.0016, demo: !!e.demo, born: performance.now() });
        }
        if (e.type === "chain" && e.ok) {
          flashes.current[e.sentinel] = performance.now();
          if (e.reportId !== undefined && e.action !== "finalize") {
            pulses.current.push({
              from: e.sentinel,
              reportId: e.reportId,
              color: e.action === "flag" ? "accent" : e.support ? "chain" : "threat",
              born: performance.now(),
            });
          }
        }
        if (e.type === "finding" && e.scope === "filed") flashes.current[e.sentinel] = performance.now();
      }),
    [subscribe],
  );

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    let colors: Record<string, string> = {};
    let colorsAt = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const readColors = () => {
      const cs = getComputedStyle(document.documentElement);
      for (const k of ["bg", "surface", "ink", "muted", "line", "accent", "chain", "threat", "safe", "pending", "particle"]) {
        colors[k] = cs.getPropertyValue(`--${k}`).trim();
      }
    };

    const draw = (now: number) => {
      if (now - colorsAt > 1000) {
        readColors();
        colorsAt = now;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2 - 8;
      const R = Math.min(w, h) / 2 - 18;
      const sentinelR = R * 0.4;
      const narrow = w < 560;
      const threatR = R * (narrow ? 0.7 : 0.78);

      // rings
      ctx.lineWidth = 1;
      for (const [r, dash] of [[R, [2, 6]], [threatR, [1, 5]], [sentinelR, [4, 4]]] as const) {
        ctx.setLineDash(dash as unknown as number[]);
        ctx.strokeStyle = colors.line;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // particles: transactions flowing in
      particles.current = particles.current.filter((p) => p.r > 0.42);
      for (const p of particles.current) {
        if (!reduce) p.r -= p.v;
        const x = cx + Math.cos(p.a) * p.r * R;
        const y = cy + Math.sin(p.a) * p.r * R;
        ctx.globalAlpha = Math.min(1, (p.r - 0.42) * 3);
        ctx.fillStyle = p.demo ? colors.accent : colors.particle;
        ctx.beginPath();
        ctx.arc(x, y, p.demo ? 2.6 : 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // sentinel positions
      const pos: Record<string, [number, number]> = {};
      personas.forEach((p, i) => {
        const a = -Math.PI / 2 + (i / personas.length) * Math.PI * 2;
        pos[p.name] = [cx + Math.cos(a) * sentinelR, cy + Math.sin(a) * sentinelR];
      });
      const byAccount: Record<string, string> = {};
      for (const [name, acc] of Object.entries(sentinelAccounts)) byAccount[acc] = name;

      // threats
      const recent = reportsRef.current.slice(0, 10);
      const tpos: Record<number, [number, number]> = {};
      for (const r of recent) {
        const a = hash(r.target) * Math.PI * 2;
        const x = cx + Math.cos(a) * threatR;
        const y = cy + Math.sin(a) * threatR;
        tpos[r.id] = [x, y];
        // vote lines
        for (const v of r.votes) {
          const from = pos[byAccount[v.sentinel]];
          if (!from) continue;
          ctx.strokeStyle = v.support ? colors.chain : colors.threat;
          ctx.globalAlpha = r.status === "Open" ? 0.75 : 0.28;
          ctx.setLineDash(v.support ? [] : [3, 4]);
          ctx.beginPath();
          ctx.moveTo(from[0], from[1]);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // confirmed threats are bound to the registry
        if (r.status === "Confirmed") {
          ctx.strokeStyle = colors.threat;
          ctx.globalAlpha = 0.18;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const color = r.status === "Confirmed" ? colors.threat : r.status === "Open" ? colors.pending : colors.muted;
        const rad = 5 + r.severity * 0.7;
        if (r.status === "Open" && !reduce) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 200);
          ctx.beginPath();
          ctx.arc(x, y, rad + 6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colors.ink;
        ctx.font = "11px 'JetBrains Mono', monospace";
        ctx.textAlign = x < cx ? "right" : "left";
        ctx.fillText(short(r.target, narrow ? 16 : 26), x + (x < cx ? -rad - 6 : rad + 6), y - 2);
        ctx.fillStyle = color;
        ctx.fillText(narrow ? r.category : `${r.category} · ${r.status}`, x + (x < cx ? -rad - 6 : rad + 6), y + 11);
      }

      // pulses travelling from a sentinel to the account it acted on
      pulses.current = pulses.current.filter((p) => now - p.born < 1400);
      for (const p of pulses.current) {
        const from = pos[p.from];
        const to = tpos[p.reportId];
        if (!from || !to) continue;
        const t = Math.min(1, (now - p.born) / 900);
        ctx.fillStyle = colors[p.color];
        ctx.beginPath();
        ctx.arc(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // registry at the centre
      const confirmed = reportsRef.current.filter((r) => r.status === "Confirmed").length;
      ctx.strokeStyle = colors.chain;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        const x = cx + Math.cos(a) * 30;
        const y = cy + Math.sin(a) * 30;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = colors.surface;
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.chain;
      ctx.textAlign = "center";
      ctx.font = "600 15px 'JetBrains Mono', monospace";
      ctx.fillText(String(confirmed), cx, cy + 2);
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.fillText("REGISTRY", cx, cy + 14);

      // sentinels
      for (const p of personas) {
        const [x, y] = pos[p.name];
        const since = now - (flashes.current[p.name] ?? -1e9);
        const lit = since < 1200;
        if (lit && !reduce) {
          ctx.strokeStyle = colors.accent;
          ctx.globalAlpha = 1 - since / 1200;
          ctx.beginPath();
          ctx.arc(x, y, 14 + since / 40, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = lit ? colors.accent : colors.surface;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = colors.ink;
        ctx.textAlign = "center";
        ctx.font = "500 12px 'Instrument Sans', sans-serif";
        ctx.fillText(p.name, x, y + 28);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [personas, sentinelAccounts]);

  return <canvas ref={canvas} role="img" aria-label="Live threat map: transactions flowing in, sentinels around the registry, flagged accounts on the outer ring" />;
}
