import { useEffect, useRef, useState } from "react";
import type { Ev } from "./useSwarm";
import { AGENTS, glyph } from "./agents";

interface Props {
  sentinelAccounts: Record<string, string>;
  reports: any[];
  subscribe: (fn: (e: Ev) => void) => () => void;
  /** Agents currently busy (alert / staking / checking), for halos. */
  busy: Record<string, string>;
}

/** A transaction drifting from the edge to the agent that inspects it. */
interface Particle {
  a: number;
  agent: string;
  born: number;
  life: number;
  demo: boolean;
  kind: string;
  wobble: number;
}
interface Pulse { from: [number, number] | string; to: number | "registry"; color: string; born: number; size: number }
interface Wave { reportId: number; born: number }

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
};
const short = (id: string, n = 26) => (id.length > n ? `${id.slice(0, n - 11)}…${id.slice(-9)}` : id);
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

const OWNER: Record<string, string> = {
  Transfer: "neutrophil",
  AddKey: "neutrophil",
  DeployContract: "macrophage",
  CreateAccount: "t-helper",
};

/**
 * The bloodstream. Every testnet transaction flows from the edge to the
 * agent responsible for it; agents sit on a ring around the registry; reports
 * appear on the outer ring with a line for every staked vote.
 */
export function ThreatMap({ sentinelAccounts, reports, subscribe, busy }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const pulses = useRef<Pulse[]>([]);
  const waves = useRef<Wave[]>([]);
  const registryFlash = useRef(0);
  const reportsRef = useRef(reports);
  const busyRef = useRef(busy);
  const seenStatus = useRef<Record<number, string>>({});
  const threatPos = useRef<Record<number, [number, number, number]>>({});
  const [hover, setHover] = useState<{ r: any; x: number; y: number } | null>(null);
  reportsRef.current = reports;
  busyRef.current = busy;

  // Shockwave when a report turns Confirmed.
  useEffect(() => {
    for (const r of reports) {
      const prev = seenStatus.current[r.id];
      if (prev && prev !== r.status && r.status === "Confirmed") {
        waves.current.push({ reportId: r.id, born: performance.now() });
        registryFlash.current = performance.now();
      }
      seenStatus.current[r.id] = r.status;
    }
  }, [reports]);

  useEffect(
    () =>
      subscribe((e) => {
        const now = performance.now();
        if (e.type === "tx") {
          if (particles.current.length > 320) particles.current.splice(0, particles.current.length - 320);
          const kind: string = (e.kinds as string[]).find((k) => OWNER[k]) ?? e.kinds[0] ?? "Other";
          let agent = OWNER[kind] ?? "b-cell";
          if (kind === "Transfer" && hash(e.hash) > 0.5) agent = "nk-cell";
          particles.current.push({
            a: hash(e.hash) * Math.PI * 2,
            agent,
            born: now,
            life: 2600 + hash(e.signer) * 1800,
            demo: !!e.demo,
            kind,
            wobble: hash(e.receiver) - 0.5,
          });
        }
        if (e.type === "chain" && e.ok && e.reportId !== undefined) {
          if (e.action === "finalize") {
            pulses.current.push({ from: "report", to: e.reportId, color: "chain", born: now, size: 5 });
            registryFlash.current = now;
          } else {
            pulses.current.push({
              from: e.sentinel,
              to: e.reportId,
              color: e.action === "flag" ? `agent:${e.sentinel}` : e.support ? "chain" : "threat",
              born: now,
              size: e.action === "flag" ? 6 : 4.5,
            });
          }
        }
      }),
    [subscribe],
  );

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    const colors: Record<string, string> = {};
    const images: Record<string, HTMLImageElement> = {};
    let colorsAt = -1e9;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const readColors = () => {
      const cs = getComputedStyle(document.documentElement);
      for (const k of ["bg", "surface", "ink", "muted", "line", "accent", "chain", "threat", "safe", "pending", "particle", ...AGENTS.map((a) => a.hue)]) {
        colors[k] = cs.getPropertyValue(`--${k}`).trim();
      }
      for (const a of AGENTS) {
        const key = `${a.name}|${colors[a.hue]}|${colors.bg}`;
        if (!images[key]) {
          const img = new Image();
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(glyph(a.name, colors[a.hue], colors.bg))}`;
          images[key] = img;
        }
        images[a.name] = images[key];
      }
    };
    const col = (c: string) => (c.startsWith("agent:") ? colors[AGENTS.find((a) => a.name === c.slice(6))?.hue ?? "accent"] : colors[c]);

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
      const cy = h / 2;
      const R = Math.min(w, h) / 2 - 14;
      const narrow = w < 560;
      const agentR = R * 0.42;
      const threatR = R * (narrow ? 0.72 : 0.8);

      // backdrop glow
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, colors.surface);
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      // radar sweep
      if (!reduce && "createConicGradient" in ctx) {
        const ang = (now / 4000) * Math.PI * 2;
        const cg = (ctx as any).createConicGradient(ang, cx, cy);
        cg.addColorStop(0, colors.accent + "30");
        cg.addColorStop(0.08, "transparent");
        cg.addColorStop(1, "transparent");
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fill();
      }

      // rings
      ctx.lineWidth = 1;
      for (const [r, dash, alpha] of [[R, [2, 6], 0.9], [threatR, [1, 5], 0.7], [agentR, [], 0.35]] as const) {
        ctx.setLineDash(dash as unknown as number[]);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colors.line;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // agent positions
      const pos: Record<string, [number, number]> = {};
      AGENTS.forEach((a, i) => {
        const ang = -Math.PI / 2 + (i / AGENTS.length) * Math.PI * 2;
        pos[a.name] = [cx + Math.cos(ang) * agentR, cy + Math.sin(ang) * agentR];
      });
      const byAccount: Record<string, string> = {};
      for (const [name, acc] of Object.entries(sentinelAccounts)) byAccount[acc] = name;

      // particles: edge -> responsible agent, with a short trail
      particles.current = particles.current.filter((p) => now - p.born < p.life);
      for (const p of particles.current) {
        const t = ease(Math.min(1, (now - p.born) / p.life));
        const sx = cx + Math.cos(p.a) * R;
        const sy = cy + Math.sin(p.a) * R;
        const [tx, ty] = pos[p.agent] ?? [cx, cy];
        // curve through a control point bent sideways
        const mx = (sx + tx) / 2 + (ty - sy) * p.wobble * 0.5;
        const my = (sy + ty) / 2 - (tx - sx) * p.wobble * 0.5;
        const at = (u: number) => [
          (1 - u) * (1 - u) * sx + 2 * (1 - u) * u * mx + u * u * tx,
          (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * my + u * u * ty,
        ];
        const [x, y] = at(t);
        const [px, py] = at(Math.max(0, t - 0.06));
        const c = p.demo ? colors.accent : p.kind === "Transfer" || p.kind === "FunctionCall" ? colors.particle : col(`agent:${p.agent}`);
        ctx.globalAlpha = (t < 0.1 ? t * 10 : 1) * (t > 0.92 ? (1 - t) * 12 : 1) * (p.demo ? 1 : 0.8);
        ctx.strokeStyle = c;
        ctx.lineWidth = p.demo ? 2.2 : 1.2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(x, y, p.demo ? 2.8 : 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;

      // threats on the outer ring
      // Evenly spaced by report id so labels never collide; offset so they sit between agents.
      const recent = reportsRef.current.slice(0, narrow ? 6 : 10).slice().sort((a, b) => a.id - b.id);
      const tpos: Record<number, [number, number, number]> = {};
      for (const [i, r] of recent.entries()) {
        const ang = -Math.PI / 2 + Math.PI / Math.max(recent.length, 5) + (i / Math.max(recent.length, 5)) * Math.PI * 2;
        const x = cx + Math.cos(ang) * threatR;
        const y = cy + Math.sin(ang) * threatR;
        const rad = 6 + r.severity * 0.7;
        tpos[r.id] = [x, y, rad];
        for (const v of r.votes) {
          const name = byAccount[v.sentinel];
          const from = pos[name];
          if (!from) continue;
          ctx.strokeStyle = v.support ? col(`agent:${name}`) : colors.threat;
          ctx.globalAlpha = r.status === "Open" ? 0.8 : 0.22;
          ctx.setLineDash(v.support ? [] : [3, 4]);
          ctx.lineWidth = r.status === "Open" ? 1.6 : 1;
          ctx.beginPath();
          ctx.moveTo(from[0], from[1]);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        if (r.status === "Confirmed") {
          ctx.strokeStyle = colors.threat;
          ctx.globalAlpha = 0.14;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const color = r.status === "Confirmed" ? colors.threat : r.status === "Open" ? colors.pending : colors.muted;
        if (r.status === "Open" && !reduce) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 180);
          ctx.beginPath();
          ctx.arc(x, y, rad + 7, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // glow
        const gl = ctx.createRadialGradient(x, y, 0, x, y, rad * 2.6);
        gl.addColorStop(0, color + "66");
        gl.addColorStop(1, "transparent");
        ctx.fillStyle = gl;
        ctx.beginPath();
        ctx.arc(x, y, rad * 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        if (hover?.r?.id === r.id) {
          ctx.strokeStyle = colors.ink;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, rad + 3, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        // On narrow screens labels point inward so they are never clipped at the edge.
        const left = narrow ? x > cx : x < cx;
        const lx = x + (left ? -rad - 8 : rad + 8);
        ctx.textAlign = left ? "right" : "left";
        ctx.font = "500 11px 'JetBrains Mono', monospace";
        ctx.fillStyle = colors.ink;
        ctx.fillText(short(r.target, narrow ? 15 : 26), lx, y - 2);
        ctx.fillStyle = color;
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillText(narrow ? r.category : `${r.category} · ${r.status === "Open" ? "voting" : r.status.toLowerCase()}`, lx, y + 11);
      }
      threatPos.current = tpos;

      // shockwaves on confirmation
      waves.current = waves.current.filter((wv) => now - wv.born < 1600);
      for (const wv of waves.current) {
        const p = tpos[wv.reportId];
        if (!p) continue;
        const t = (now - wv.born) / 1600;
        ctx.strokeStyle = colors.threat;
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 3 * (1 - t) + 0.5;
        ctx.beginPath();
        ctx.arc(p[0], p[1], p[2] + t * 70, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;

      // pulses: agent -> report (flag, vote), report -> registry (finalize)
      pulses.current = pulses.current.filter((p) => now - p.born < 1300);
      for (const p of pulses.current) {
        const target = typeof p.to === "number" ? tpos[p.to] : null;
        if (!target) continue;
        let from: [number, number];
        let to: [number, number];
        if (p.from === "report") {
          from = [target[0], target[1]];
          to = [cx, cy];
        } else {
          const f = pos[p.from as string];
          if (!f) continue;
          from = f;
          to = [target[0], target[1]];
        }
        const t = ease(Math.min(1, (now - p.born) / 900));
        const x = from[0] + (to[0] - from[0]) * t;
        const y = from[1] + (to[1] - from[1]) * t;
        const c = col(p.color);
        const gl = ctx.createRadialGradient(x, y, 0, x, y, p.size * 3);
        gl.addColorStop(0, c);
        gl.addColorStop(1, "transparent");
        ctx.fillStyle = gl;
        ctx.beginPath();
        ctx.arc(x, y, p.size * 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // registry
      const flash = Math.max(0, 1 - (now - registryFlash.current) / 1200);
      const confirmed = reportsRef.current.filter((r) => r.status === "Confirmed").length;
      const hexR = 32 + flash * 6;
      if (flash > 0) {
        const gl = ctx.createRadialGradient(cx, cy, 0, cx, cy, hexR * 2.4);
        gl.addColorStop(0, colors.chain + "55");
        gl.addColorStop(1, "transparent");
        ctx.fillStyle = gl;
        ctx.beginPath();
        ctx.arc(cx, cy, hexR * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        const x = cx + Math.cos(a) * hexR;
        const y = cy + Math.sin(a) * hexR;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = colors.bg;
      ctx.fill();
      ctx.strokeStyle = colors.chain;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.chain;
      ctx.textAlign = "center";
      ctx.font = "600 17px 'JetBrains Mono', monospace";
      ctx.fillText(String(confirmed), cx, cy + 3);
      ctx.font = "8.5px 'JetBrains Mono', monospace";
      ctx.fillText("REGISTRY", cx, cy + 15);

      // agents
      const size = narrow ? 30 : 38;
      for (const a of AGENTS) {
        const [x, y] = pos[a.name];
        const c = colors[a.hue];
        const mood = busyRef.current[a.name];
        if (mood && !reduce) {
          const t = (now % 1400) / 1400;
          ctx.strokeStyle = c;
          ctx.globalAlpha = 1 - t;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, size / 2 + 4 + t * 16, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = colors.bg;
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        const img = images[a.name];
        if (img?.complete) ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
        ctx.fillStyle = colors.ink;
        ctx.textAlign = "center";
        ctx.font = `600 ${narrow ? 10 : 12}px 'Instrument Sans', sans-serif`;
        ctx.fillText(a.name, x, y + size / 2 + 14);
        if (mood) {
          ctx.fillStyle = c;
          ctx.font = "10px 'JetBrains Mono', monospace";
          ctx.fillText(mood, x, y + size / 2 + 26);
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sentinelAccounts, hover]);

  const onMove = (e: React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hit: any = null;
    for (const r of reportsRef.current) {
      const p = threatPos.current[r.id];
      if (p && Math.hypot(p[0] - mx, p[1] - my) < p[2] + 8) hit = r;
    }
    if ((hit?.id ?? null) !== (hover?.r?.id ?? null)) setHover(hit ? { r: hit, x: mx, y: my } : null);
  };

  const nameOf: Record<string, string> = Object.fromEntries(Object.entries(sentinelAccounts).map(([n, a]) => [a, n]));
  return (
    <>
      <canvas
        ref={canvas}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ cursor: hover ? "pointer" : "default" }}
        role="img"
        aria-label="Live map: testnet transactions flow to the five sentinel agents around the registry; reported accounts sit on the outer ring with a line for each vote"
      />
      {hover && (
        <div className="map-tip" style={{ left: Math.min(hover.x + 14, (canvas.current?.clientWidth ?? 400) - 250), top: hover.y + 14 }}>
          <b className="mono">{hover.r.target}</b>
          <span className={`chip ${hover.r.status}`}>{hover.r.category} · {hover.r.status}</span>
          <p>{hover.r.summary}</p>
          <div className="tip-votes">
            {hover.r.votes.map((v: any) => (
              <span key={v.sentinel} className={v.support ? "yes" : "no"}>
                {v.support ? "✓" : "✗"} {nameOf[v.sentinel] ?? v.sentinel}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
