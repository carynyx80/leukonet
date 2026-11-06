import { useEffect, useRef, useState } from "react";
import type { Ev } from "./useSwarm";
import { AGENTS, glyph } from "./agents";

interface Props {
  sentinelAccounts: Record<string, string>;
  reports: any[];
  subscribe: (fn: (e: Ev) => void) => () => void;
  /** Agents currently busy (alert / staking / checking), for halos. */
  busy: Record<string, string>;
  /** Horizontal centre of the organism, 0-1 of the width (leaves room for overlay text). */
  focusX?: number;
}

interface Particle { a: number; agent: string; born: number; life: number; demo: boolean; wobble: number }
interface Pulse { from: string; to: number | "registry"; color: string; born: number; size: number }
interface Wave { reportId: number; born: number }

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
};
const short = (id: string, n = 28) => (id.length > n ? `${id.slice(0, n - 11)}…${id.slice(-9)}` : id);
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

const OWNER: Record<string, string> = {
  Transfer: "neutrophil",
  AddKey: "neutrophil",
  DeployContract: "macrophage",
  CreateAccount: "t-helper",
};

/**
 * The organism. Testnet transactions stream in from the edge to the agent that
 * inspects them. The agents ring the registry. Accounts the swarm has judged sit
 * on the outer ring: quiet dots once settled, lit up with vote lines while
 * the swarm is deciding.
 */
export function ThreatMap({ sentinelAccounts, reports, subscribe, busy, focusX = 0.5 }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const pulses = useRef<Pulse[]>([]);
  const waves = useRef<Wave[]>([]);
  const registryFlash = useRef(0);
  const reportsRef = useRef(reports);
  const busyRef = useRef(busy);
  const seenStatus = useRef<Record<number, string>>({});
  const settledAt = useRef<Record<number, number>>({});
  const threatPos = useRef<Record<number, [number, number, number]>>({});
  const hoverRef = useRef<number | null>(null);
  const [hover, setHover] = useState<{ r: any; x: number; y: number } | null>(null);
  reportsRef.current = reports;
  busyRef.current = busy;

  useEffect(() => {
    for (const r of reports) {
      const prev = seenStatus.current[r.id];
      if (prev && prev !== r.status) {
        settledAt.current[r.id] = performance.now();
        if (r.status === "Confirmed") {
          waves.current.push({ reportId: r.id, born: performance.now() });
          registryFlash.current = performance.now();
        }
      }
      seenStatus.current[r.id] = r.status;
    }
  }, [reports]);

  useEffect(
    () =>
      subscribe((e) => {
        const now = performance.now();
        if (e.type === "tx") {
          if (particles.current.length > 260) particles.current.splice(0, particles.current.length - 260);
          const kind: string = (e.kinds as string[]).find((k) => OWNER[k]) ?? "Other";
          let agent = OWNER[kind] ?? "b-cell";
          if (kind === "Transfer" && hash(e.hash) > 0.5) agent = "nk-cell";
          particles.current.push({ a: hash(e.hash) * Math.PI * 2, agent, born: now, life: 2400 + hash(e.signer) * 1600, demo: !!e.demo, wobble: hash(e.receiver) - 0.5 });
        }
        if (e.type === "chain" && e.ok && e.reportId !== undefined) {
          if (e.action === "finalize") {
            pulses.current.push({ from: "report", to: e.reportId, color: "chain", born: now, size: 6 });
            registryFlash.current = now;
          } else {
            pulses.current.push({
              from: e.sentinel,
              to: e.reportId,
              color: e.action === "flag" ? `agent:${e.sentinel}` : e.support ? "chain" : "threat",
              born: now,
              size: e.action === "flag" ? 7 : 5,
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
      for (const k of ["bg", "surface", "ink", "muted", "line", "accent", "chain", "threat", "pending", "particle", ...AGENTS.map((a) => a.hue)]) {
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
    const glow = (x: number, y: number, r: number, c: string, alpha = "55") => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c + alpha);
      g.addColorStop(1, c + "00");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
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
      const cx = w * focusX;
      const cy = h / 2;
      const R = Math.max(120, Math.min(h / 2 - 26, w - cx - 30, cx - 30));
      const narrow = R < 230;
      const agentR = R * 0.43;
      const threatR = R * 0.84;

      // soft body
      glow(cx, cy, R * 1.15, colors.accent, "14");
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 7]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, threatR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // radar sweep
      if (!reduce && "createConicGradient" in ctx) {
        const cg = (ctx as any).createConicGradient((now / 5000) * Math.PI * 2, cx, cy);
        cg.addColorStop(0, colors.accent + "26");
        cg.addColorStop(0.07, colors.accent + "00");
        cg.addColorStop(1, colors.accent + "00");
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fill();
      }

      const pos: Record<string, [number, number]> = {};
      AGENTS.forEach((a, i) => {
        const ang = -Math.PI / 2 + (i / AGENTS.length) * Math.PI * 2;
        pos[a.name] = [cx + Math.cos(ang) * agentR, cy + Math.sin(ang) * agentR];
      });
      const byAccount: Record<string, string> = {};
      for (const [name, acc] of Object.entries(sentinelAccounts)) byAccount[acc] = name;

      // transactions streaming in
      particles.current = particles.current.filter((p) => now - p.born < p.life);
      for (const p of particles.current) {
        const t = ease(Math.min(1, (now - p.born) / p.life));
        const sx = cx + Math.cos(p.a) * R;
        const sy = cy + Math.sin(p.a) * R;
        const [tx, ty] = pos[p.agent] ?? [cx, cy];
        const mx = (sx + tx) / 2 + (ty - sy) * p.wobble * 0.55;
        const my = (sy + ty) / 2 - (tx - sx) * p.wobble * 0.55;
        const at = (u: number) => [(1 - u) ** 2 * sx + 2 * (1 - u) * u * mx + u * u * tx, (1 - u) ** 2 * sy + 2 * (1 - u) * u * my + u * u * ty];
        const [x, y] = at(t);
        const [px, py] = at(Math.max(0, t - 0.08));
        const c = p.demo ? colors.accent : col(`agent:${p.agent}`);
        const fade = (t < 0.12 ? t / 0.12 : 1) * (t > 0.9 ? (1 - t) * 10 : 1);
        ctx.globalAlpha = fade * (p.demo ? 1 : 0.55);
        ctx.strokeStyle = c;
        ctx.lineWidth = p.demo ? 2.4 : 1.3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
        if (p.demo) glow(x, y, 9, c, "88");
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;

      // the judged accounts
      const all = reportsRef.current.slice(0, narrow ? 8 : 12).slice().sort((a, b) => a.id - b.id);
      const latest = reportsRef.current[0];
      const n = Math.max(all.length, 6);
      const tpos: Record<number, [number, number, number]> = {};
      for (const [i, r] of all.entries()) {
        const ang = -Math.PI / 2 + Math.PI / n + (i / n) * Math.PI * 2;
        tpos[r.id] = [cx + Math.cos(ang) * threatR, cy + Math.sin(ang) * threatR, 0];
      }
      for (const r of all) {
        const [x, y] = tpos[r.id];
        const open = r.status === "Open";
        const recent = now - (settledAt.current[r.id] ?? -1e9) < 9000;
        const hovered = hoverRef.current === r.id;
        const lit = open || recent || hovered;
        const color = r.status === "Confirmed" ? colors.threat : open ? colors.pending : colors.muted;
        const rad = lit ? 7 + r.severity * 0.6 : 4.5;
        tpos[r.id][2] = rad;

        if (lit) {
          for (const v of r.votes) {
            const name = byAccount[v.sentinel];
            const from = pos[name];
            if (!from) continue;
            ctx.strokeStyle = v.support ? col(`agent:${name}`) : colors.threat;
            ctx.globalAlpha = open || hovered ? 0.85 : 0.45 * (1 - (now - (settledAt.current[r.id] ?? now)) / 9000);
            ctx.setLineDash(v.support ? [] : [4, 4]);
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(from[0], from[1]);
            ctx.lineTo(x, y);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          ctx.globalAlpha = 1;
          glow(x, y, rad * 3, color, "70");
          if (open && !reduce) {
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 160);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, rad + 8, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.lineWidth = 1;
          }
        }
        ctx.fillStyle = color;
        ctx.globalAlpha = lit ? 1 : 0.75;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        if (lit || r.id === latest?.id) {
          const inward = narrow ? x > cx : x < cx;
          const lx = x + (inward ? -rad - 10 : rad + 10);
          ctx.textAlign = inward ? "right" : "left";
          ctx.font = `600 ${narrow ? 11 : 12}px 'JetBrains Mono', monospace`;
          ctx.fillStyle = colors.ink;
          ctx.fillText(short(r.target, narrow ? 16 : 28), lx, y - 2);
          ctx.font = `${narrow ? 10 : 11}px 'Instrument Sans', sans-serif`;
          ctx.fillStyle = color;
          ctx.fillText(open ? `${r.category} · voting` : `${r.category} · ${r.status.toLowerCase()}`, lx, y + 12);
        }
      }
      threatPos.current = tpos;

      // shockwaves
      waves.current = waves.current.filter((wv) => now - wv.born < 1800);
      for (const wv of waves.current) {
        const p = tpos[wv.reportId];
        if (!p) continue;
        const t = (now - wv.born) / 1800;
        ctx.strokeStyle = colors.threat;
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 3 * (1 - t) + 0.5;
        ctx.beginPath();
        ctx.arc(p[0], p[1], 10 + ease(t) * 90, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;

      // pulses
      pulses.current = pulses.current.filter((p) => now - p.born < 1200);
      for (const p of pulses.current) {
        const target = typeof p.to === "number" ? tpos[p.to] : null;
        if (!target) continue;
        const from = p.from === "report" ? [target[0], target[1]] : pos[p.from];
        const to = p.from === "report" ? [cx, cy] : [target[0], target[1]];
        if (!from) continue;
        const t = ease(Math.min(1, (now - p.born) / 850));
        glow(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, p.size * 3, col(p.color), "ee");
      }

      // registry
      const flash = Math.max(0, 1 - (now - registryFlash.current) / 1400);
      const hexR = (narrow ? 26 : 34) + flash * 7;
      glow(cx, cy, hexR * 2.6, colors.chain, flash > 0 ? "66" : "22");
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        i ? ctx.lineTo(cx + Math.cos(a) * hexR, cy + Math.sin(a) * hexR) : ctx.moveTo(cx + Math.cos(a) * hexR, cy + Math.sin(a) * hexR);
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
      ctx.font = `600 ${narrow ? 15 : 19}px 'JetBrains Mono', monospace`;
      ctx.fillText(String(reportsRef.current.filter((r) => r.status === "Confirmed").length), cx, cy + 4);
      ctx.font = `${narrow ? 7.5 : 8.5}px 'JetBrains Mono', monospace`;
      ctx.fillText("CAUGHT", cx, cy + (narrow ? 14 : 17));

      // agents
      const size = narrow ? 34 : 48;
      for (const a of AGENTS) {
        const [x, y] = pos[a.name];
        const c = colors[a.hue];
        const mood = busyRef.current[a.name];
        glow(x, y, size * (mood ? 1.5 : 1.1), c, mood ? "55" : "22");
        if (mood && !reduce) {
          const t = (now % 1300) / 1300;
          ctx.strokeStyle = c;
          ctx.globalAlpha = 1 - t;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, size / 2 + 4 + t * 18, 0, Math.PI * 2);
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
        ctx.textAlign = "center";
        ctx.fillStyle = colors.ink;
        ctx.font = `600 ${narrow ? 10.5 : 12.5}px 'Instrument Sans', sans-serif`;
        ctx.fillText(a.name, x, y + size / 2 + 15);
        if (mood) {
          ctx.fillStyle = c;
          ctx.font = `600 ${narrow ? 9 : 10}px 'JetBrains Mono', monospace`;
          ctx.fillText(mood.toUpperCase(), x, y + size / 2 + 28);
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sentinelAccounts, focusX]);

  const onMove = (e: React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hit: any = null;
    for (const r of reportsRef.current) {
      const p = threatPos.current[r.id];
      if (p && Math.hypot(p[0] - mx, p[1] - my) < Math.max(p[2], 6) + 9) hit = r;
    }
    hoverRef.current = hit?.id ?? null;
    if ((hit?.id ?? null) !== (hover?.r?.id ?? null)) setHover(hit ? { r: hit, x: mx, y: my } : null);
  };

  const nameOf: Record<string, string> = Object.fromEntries(Object.entries(sentinelAccounts).map(([n, a]) => [a, n]));
  return (
    <>
      <canvas
        ref={canvas}
        onMouseMove={onMove}
        onMouseLeave={() => {
          hoverRef.current = null;
          setHover(null);
        }}
        style={{ cursor: hover ? "pointer" : "default" }}
        role="img"
        aria-label="Live map: testnet transactions stream to five AI agents around the registry; accounts they judged sit on the outer ring"
      />
      {hover && (
        <div className="map-tip" style={{ left: Math.min(hover.x + 16, (canvas.current?.clientWidth ?? 400) - 270), top: Math.min(hover.y + 16, (canvas.current?.clientHeight ?? 400) - 160) }}>
          <span className={`chip ${hover.r.status}`}>{hover.r.category} · {hover.r.status === "Open" ? "voting" : hover.r.status.toLowerCase()}</span>
          <b className="mono">{hover.r.target}</b>
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
