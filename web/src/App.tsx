import { useEffect, useMemo, useRef, useState } from "react";
import { useSwarm, type Ev, type SwarmState } from "./useSwarm";
import { useAgents, type AgentMind } from "./useAgents";
import { ThreatMap } from "./ThreatMap";
import { AGENTS, agentByName, glyph } from "./agents";
import { API } from "./api";
import { useWatcher } from "./useWatcher";
import { BrowserWatcher, type TipResult, type WatcherStats } from "./watcher";
import { MAINNET_PROTECTED } from "../../src/protected";
import { imitates } from "../../src/detectors/lookalike";
import type { Finding } from "../../src/detectors/types";

const fmtNear = (y: string | number | bigint, d = 3) => (Number(BigInt(String(y)) / 10n ** 18n) / 1e6).toFixed(d);
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const short = (id: string, n = 30) => (id.length > n ? `${id.slice(0, n - 12)}…${id.slice(-10)}` : id);
const ago = (ms: number, now: number) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const human = (c: string) => c.replace(/([a-z])([A-Z])/g, "$1 $2");

/** Which agent catches which simulated scam. */
const CATCHER: Record<string, string> = {
  drainer: "neutrophil",
  key_hijack: "neutrophil",
  malicious_contract: "macrophage",
  rogue_agent: "nk-cell",
  lookalike: "t-helper",
};

/** What each agent is like, in one line people remember. */
const PERSONALITY: Record<string, string> = {
  neutrophil: "First to arrive. Follows the money and pounces when a wallet gets emptied.",
  macrophage: "Reads every new contract's code before anyone pays it. Hates fake airdrops.",
  "nk-cell": "Knows each AI agent's habits, and notices the moment one goes rogue.",
  "t-helper": "Guards names. Spots leuk0net-pay pretending to be leukonet-pay. Closes every vote.",
  "b-cell": "The sceptic. Trusts no one, double-checks everyone, and never forgets a scam.",
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function useWide(min = 1080) {
  const [wide, setWide] = useState(() => window.innerWidth >= min);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= min);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [min]);
  return wide;
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const a = agentByName(name);
  const svg = glyph(name, "currentColor", "BG").replace(/fill="BG"/g, 'style="fill:var(--bg)"');
  return (
    <span className="avatar" style={{ width: size, height: size, color: `var(--${a?.hue ?? "accent"})` }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem("leukonet-theme");
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      theme ? localStorage.setItem("leukonet-theme", theme) : localStorage.removeItem("leukonet-theme");
    } catch {
      /* storage blocked */
    }
  }, [theme]);
  const next = theme === "dark" ? "light" : theme === "light" ? null : "dark";
  return (
    <button className="ghost-btn" type="button" onClick={() => setTheme(next)} aria-label={`Colour theme: ${theme ?? "auto"}. Switch.`}>
      {theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto"}
    </button>
  );
}

const MENU_LINKS = [
  { href: "#top", label: "Live map", hint: "Watch the swarm and release a scam" },
  { href: "#swarm", label: "The swarm", hint: "Meet the five agents" },
  { href: "#check", label: "Check an account", hint: "Is it safe to pay?" },
  { href: "#radar", label: "Mainnet radar", hint: "Scan the real NEAR, live" },
  { href: "#registry", label: "Registry", hint: "Every verdict, onchain" },
  { href: "#how", label: "How it works", hint: "Watch, flag, verify, protect" },
  { href: "#developers", label: "Developers", hint: "One call before every payment" },
];

/** Hamburger menu: the button opens a panel with every section, the theme switch and the source link. */
function Menu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!open) return;
    firstLink.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className="menu" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={`burger ${open ? "open" : ""}`}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="site-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span />
        <span />
        <span />
      </button>
      {open && (
        <div id="site-menu" className="menu-panel">
          <nav aria-label="Sections">
            {MENU_LINKS.map((l, i) => (
              <a key={l.href} href={l.href} ref={i === 0 ? firstLink : undefined} onClick={() => setOpen(false)}>
                <b>{l.label}</b>
                <small>{l.hint}</small>
              </a>
            ))}
          </nav>
          <div className="menu-foot">
            <span className="muted">Theme</span>
            <ThemeToggle />
          </div>
          <div className="menu-foot">
            <a href="https://github.com/carynyx80/leukonet" target="_blank" rel="noreferrer">
              Source code ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <circle cx="16" cy="16" r="6" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <g stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round">
        <path d="M16 4v4M16 24v4M4 16h4M24 16h4M7.5 7.5l2.8 2.8M21.7 21.7l2.8 2.8M7.5 24.5l2.8-2.8M21.7 10.3l2.8-2.8" />
      </g>
      <circle cx="16" cy="16" r="2" fill="var(--chain)" />
    </svg>
  );
}

// ================================================================================

export function App() {
  const [s, subscribe, inject, watchers] = useSwarm();
  const cell = useWatcher(s.meta, inject);
  const now = useNow();
  const wide = useWide();
  const meta = s.meta;
  const explorer = meta?.explorer ?? "https://testnet.nearblocks.io";
  const txUrl = (h: string) => `${explorer}/txns/${h}`;
  const accUrl = (a: string) => `${explorer}/address/${a}`;
  const memory = useMemo(
    () => [...new Map([...Object.entries(meta?.memory ?? {}), ...s.memory.map((m) => [m.codeHash, m.reportId] as [string, number])]).entries()],
    [meta, s.memory],
  );
  const minds = useAgents(
    AGENTS.map((a) => a.name),
    subscribe,
    memory.length,
  );
  const busy: Record<string, string> = {};
  for (const [name, m] of Object.entries(minds)) if (m.mood !== "watching" && now - m.at < 6000) busy[name] = m.mood;

  const lastBlock = s.blocks[s.blocks.length - 1];
  const tps = useMemo(() => {
    const recent = s.blocks.slice(-30);
    if (recent.length < 2) return 0;
    const span = (recent[recent.length - 1].ts - recent[0].ts) / 1000;
    return span > 0 ? recent.reduce((a, b) => a + b.txs, 0) / span : 0;
  }, [s.blocks]);
  const caught = s.reports.filter((r) => r.status === "Confirmed").length;

  return (
    <>
      <nav className="nav">
        <a className="brand" href="#top" aria-label="Leukonet home">
          <Logo />
          <span>
            leuko<b>net</b>
          </span>
        </a>
        <div className="nav-right">
          <span className={`live ${s.connected ? "" : "off"}`}>
            <i />
            {s.connected ? "testnet live" : "reconnecting"}
          </span>
          <Menu />
        </div>
      </nav>

      <header className="hero" id="top">
        <div className="hero-map">
          {meta && <ThreatMap sentinelAccounts={meta.sentinelAccounts} reports={s.reports} subscribe={subscribe} busy={busy} focusX={wide ? 0.66 : 0.5} />}
        </div>
        <div className="hero-side">
          <Story s={s} minds={minds} txUrl={txUrl} accUrl={accUrl} now={now} cell={cell.stats} lastTip={cell.lastTip} />
          <div className="readouts" aria-label="Live numbers">
            <div>
              <b className="mono">{(cell.stats?.height || lastBlock?.height)?.toLocaleString() ?? "…"}</b>
              <span>latest block</span>
            </div>
            <div>
              <b className="mono">{cell.stats ? cell.stats.txs.toLocaleString() : tps.toFixed(1)}</b>
              <span>{cell.stats ? "tx checked by your browser" : "tx / second read"}</span>
            </div>
            <div>
              <b className="mono hot">{caught}</b>
              <span>scams caught</span>
            </div>
          </div>
          <CellStatus stats={cell.stats} watchers={watchers} lastTip={cell.lastTip} now={now} />
        </div>
        <p className="hero-hint">Each streak is a real testnet transaction flowing to the agent that inspects it. Hover a dot for details.</p>
      </header>

      <main className="page">
        <section className="section" id="swarm">
          <div className="section-h">
            <span className="eyebrow">The swarm</span>
            <h2>Five agents. Five different instincts. One verdict.</h2>
            <p>Each agent is its own NEAR account with its own bond. When one raises the alarm, the others check the evidence themselves and stake on their answer.</p>
          </div>
          <div className="agents">
            {AGENTS.map((a) => (
              <AgentCard
                key={a.name}
                name={a.name}
                mind={minds[a.name]}
                stats={s.sentinels.find((x) => x.account_id === meta?.sentinelAccounts?.[a.name])}
                account={meta?.sentinelAccounts?.[a.name]}
                memory={a.name === "b-cell" ? memory : undefined}
                now={now}
                accUrl={accUrl}
              />
            ))}
          </div>
        </section>

        <Checker reports={s.reports} protectedNames={meta?.protected ?? []} />

        <Radar />

        <Registry reports={s.reports} sentinelAccounts={meta?.sentinelAccounts ?? {}} chain={s.chain} txUrl={txUrl} accUrl={accUrl} now={now} findings={s.findings} />

        <section className="section how" id="how">
          <div className="section-h">
            <span className="eyebrow">How it works</span>
            <h2>From robbery to "don't pay" in about fifteen seconds</h2>
          </div>
          <ol className="steps">
            <li><Avatar name="neutrophil" size={34} /><b>Watch</b><p>The agents read every testnet block as it lands, about one a second.</p></li>
            <li><Avatar name="macrophage" size={34} /><b>Flag and stake</b><p>The agent that spots a scam reports it and puts NEAR on the line.</p></li>
            <li><Avatar name="b-cell" size={34} /><b>Check each other</b><p>The rest re-check the evidence with their own rules and stake on their vote. Wrong votes lose stake to right ones.</p></li>
            <li><Avatar name="t-helper" size={34} /><b>Protect</b><p>Confirmed scams go into a public registry. Wallets and agents ask it before they pay.</p></li>
          </ol>
        </section>

        <Developers registry={meta?.registry ?? "registry.leukonet-mw43jm6i.testnet"} />

        <footer className="footer">
          <span className="brand small">
            <Logo />
            <span>
              leuko<b>net</b>
            </span>
          </span>
          <span>Built for NEAR HACKATHON 2026 · runs on NEAR testnet</span>
          {meta && (
            <a href={accUrl(meta.registry)} target="_blank" rel="noreferrer">
              registry contract ↗
            </a>
          )}
          <a href="https://github.com/carynyx80/leukonet" target="_blank" rel="noreferrer">
            source code ↗
          </a>
        </footer>
      </main>

      <VerdictToast attack={s.attack} />
    </>
  );
}

// ================================================================================
// The story column: idle pitch -> live mission -> verdict

const PHASES = ["Attack", "Spotted", "Reported", "Voted", "Confirmed", "Blocked"] as const;

function Story({
  s,
  minds,
  txUrl,
  accUrl,
  now,
  cell,
  lastTip,
}: {
  s: SwarmState;
  minds: Record<string, AgentMind>;
  txUrl: (h: string) => string;
  accUrl: (a: string) => string;
  now: number;
  cell: WatcherStats | null;
  lastTip: (TipResult & { at: number }) | null;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<number>(0);
  const meta = s.meta;
  const launch = async (kind: string) => {
    setErr(null);
    try {
      const res = await fetch(`${API}/api/attack/${kind}`, { method: "POST" });
      if (!res.ok) setErr((await res.json()).error ?? "Could not start the simulation");
    } catch {
      setErr("Can't reach the swarm right now. Try again in a moment.");
    }
  };

  const steps = s.attack.filter((e) => e.stage !== "done");
  const start = steps.find((e) => e.stage === "start");
  const running = !!s.attackRunning;
  const lag = s.blocks[s.blocks.length - 1]?.lag ?? 0;
  // A simulation needs someone watching the chain in real time: the server, or this browser.
  const browserReady = !!cell && cell.running && cell.blocks > 2 && cell.lag <= 5 && !cell.error;
  const behind = lag > 15 && !browserReady;
  const showMission = !!start && (running || (start.ts !== dismissed && now - start.ts < 10 * 60_000));

  if (!showMission) {
    return (
      <div className="story idle">
        <span className="eyebrow">An immune system for NEAR</span>
        <h1>
          Five AI agents hunt scams on NEAR. <em>Release one and watch them catch it.</em>
        </h1>
        <p className="lede">They read every block live, stake money on what they find, check each other, and publish a list any wallet can ask before it pays.</p>
        {meta?.demoControls ? (
          <>
            <p className="pick">Release a scam on testnet</p>
            {behind && (
              <p className="lagging" role="status">
                The swarm is catching up with the chain ({lag} blocks behind). Simulations unlock when it's back in sync, usually within a minute.
              </p>
            )}
            <div className="scams">
              {meta.attacks.map((a) => (
                <button key={a.kind} type="button" className="scam" disabled={running || behind} onClick={() => void launch(a.kind)} style={{ ["--hue" as any]: `var(--${agentByName(CATCHER[a.kind])?.hue})` }}>
                  <Avatar name={CATCHER[a.kind]} size={30} />
                  <span>
                    <b>{a.label}</b>
                    <small>{a.story}</small>
                  </span>
                  <i aria-hidden="true">→</i>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="muted">Simulations are switched off on this server.</p>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    );
  }

  const kind = start!.kind as string;
  const t0 = start!.ts;
  const lastAttack = [...steps].reverse().find((e) => e.stage === "attack");
  const verdict = steps.find((e) => e.stage === "verdict");
  const blocked = steps.find((e) => e.stage === "guard_blocked");
  const failed = steps.find((e) => e.stage === "error" || e.stage === "timeout");
  const flag = s.chain.find((c) => c.action === "flag" && c.ok && c.ts >= t0);
  const detected = s.findings.find((f) => f.scope === "filed" && f.ts >= t0);
  const votes = flag ? s.chain.filter((c) => c.action === "vote" && c.ok && c.reportId === flag.reportId) : [];
  const attackDone = !!lastAttack && (!!detected || steps.some((e) => e.stage === "waiting"));
  const phaseAt = [attackDone ? lastAttack!.ts : undefined, detected?.ts, flag?.ts, votes.length >= 2 ? votes[votes.length - 1].ts : undefined, verdict?.ts, blocked?.ts];
  const current = phaseAt.findIndex((t) => t === undefined);
  const base = lastAttack?.ts ?? t0;
  const seconds = verdict ? Math.max(1, Math.round((verdict.ts - base) / 1000)) : lastAttack ? Math.max(0, Math.round(((running ? now : steps[steps.length - 1].ts) - base) / 1000)) : 0;
  const catcher = CATCHER[kind];
  const label = meta?.attacks.find((a) => a.kind === kind)?.label ?? kind;
  const target = verdict?.detail?.split(" ")[0] ?? "";
  const mind = minds[catcher];
  const myTip = lastTip && lastTip.at >= t0 ? lastTip : null;
  const narration = verdict
    ? null
    : mind && mind.mood !== "watching" && now - mind.at < 8000
      ? { who: catcher, text: mind.thought }
      : { who: null, text: [...steps].reverse().find((e) => e.detail)?.detail ?? "Setting up the scam…" };

  return (
    <div className={`story mission ${verdict ? "won" : failed ? "lost" : ""}`} aria-live="polite">
      <div className="mission-head">
        <span className="eyebrow">{verdict ? "Caught" : failed ? "Simulation stopped" : running ? "Live simulation" : "Simulation"}</span>
        {!running && (
          <button className="ghost-btn" type="button" onClick={() => setDismissed(t0)}>
            Release another
          </button>
        )}
      </div>
      <h1 className="mission-title">
        {verdict ? (
          <>
            {label} caught in <em>{seconds} seconds</em>
          </>
        ) : (
          <>
            {label}
            <span className="clock mono">{lastAttack ? `${seconds}s` : "…"}</span>
          </>
        )}
      </h1>

      <ol className="track">
        {PHASES.map((p, i) => {
          const done = phaseAt[i] !== undefined;
          return (
            <li key={p} className={done ? "done" : i === current && running ? "now" : ""}>
              <i />
              <span>{p}</span>
              <small className="mono">{done && i > 0 && lastAttack ? `${Math.max(0, Math.round((phaseAt[i]! - base) / 1000))}s` : " "}</small>
            </li>
          );
        })}
      </ol>

      <div className="jury">
        {AGENTS.map((a) => {
          const vote = votes.find((x) => x.sentinel === a.name);
          const state = flag && a.name === flag.sentinel ? "reporter" : vote ? (vote.support ? "yes" : "no") : flag ? "thinking" : a.name === catcher ? "hunting" : "idle";
          const word = { reporter: "reported it", yes: "confirmed", no: "disputed", thinking: "checking…", hunting: "hunting…", idle: "watching" }[state];
          return (
            <div key={a.name} className={`juror ${state}`} style={{ ["--hue" as any]: `var(--${a.hue})` }}>
              <Avatar name={a.name} size={34} />
              <b>{a.name}</b>
              <small>{word}</small>
            </div>
          );
        })}
      </div>

      {myTip && (
        <div className={`your-catch ${myTip.accepted ? "" : "dup"}`}>
          <span className="cell-dot" aria-hidden="true" />
          <p>
            {myTip.accepted ? <b>Your browser spotted it first.</b> : <b>Your browser spotted it too.</b>} {myTip.reason}
          </p>
        </div>
      )}

      {narration && (
        <div className="narration">
          {narration.who && <Avatar name={narration.who} size={22} />}
          <p>{narration.text}</p>
        </div>
      )}

      {blocked && (
        <div className="verdict-card">
          <b>Payment blocked</b>
          <p>{blocked.detail}</p>
          {target && (
            <a href={accUrl(target)} target="_blank" rel="noreferrer">
              See {short(target, 30)} on the explorer ↗
            </a>
          )}
        </div>
      )}
      {failed && <p className="err">{failed.detail}</p>}

      <details className="raw">
        <summary>Every step, with transaction links</summary>
        <div className="timeline">
          {steps.map((e, i) => (
            <div key={i} className={`step ${e.stage}`}>
              <time className="mono">{time(e.ts)}</time>
              <p>
                {e.detail ?? e.stage}
                {e.hash && (
                  <a href={txUrl(e.hash)} target="_blank" rel="noreferrer">
                    tx ↗
                  </a>
                )}
              </p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/** "Your browser is a white blood cell": what this tab is doing for the swarm. */
function CellStatus({ stats, watchers, lastTip, now }: { stats: WatcherStats | null; watchers: number; lastTip: (TipResult & { at: number }) | null; now: number }) {
  if (!stats) return null;
  const healthy = stats.running && !stats.error && stats.lag <= 5;
  return (
    <div className={`cell ${healthy ? "" : "warn"}`} role="status">
      <span className="cell-dot" aria-hidden="true" />
      <div>
        <b>Your browser is a white blood cell.</b>
        <span>
          {healthy ? `It reads every block itself and tips the swarm when it spots a scam.` : `Reconnecting to the chain…`}{" "}
          {watchers > 1 ? `${watchers} browsers are watching right now.` : "You're the only one watching right now."}
          {stats.tipsVerified > 0 ? ` ${stats.tipsVerified} of your tips verified.` : ""}
          {lastTip && now - lastTip.at < 20_000 && lastTip.accepted ? " Your latest tip is being reported." : ""}
        </span>
      </div>
    </div>
  );
}

function VerdictToast({ attack }: { attack: Ev[] }) {
  const [shown, setShown] = useState<Ev | null>(null);
  const seen = useRef(0);
  useEffect(() => {
    const v = attack.find((e) => e.stage === "verdict");
    if (v && v.ts !== seen.current && Date.now() - v.ts < 30_000) {
      seen.current = v.ts;
      setShown(v);
      const t = setTimeout(() => setShown(null), 6000);
      return () => clearTimeout(t);
    }
  }, [attack]);
  if (!shown) return null;
  return (
    <div className="toast" role="status">
      <b>Confirmed onchain</b>
      <span>{shown.detail}</span>
      <button type="button" onClick={() => setShown(null)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

// ================================================================================

function AgentCard({
  name,
  mind,
  stats,
  account,
  memory,
  now,
  accUrl,
}: {
  name: string;
  mind?: AgentMind;
  stats?: any;
  account?: string;
  memory?: [string, number][];
  now: number;
  accUrl: (a: string) => string;
}) {
  const a = agentByName(name)!;
  const live = !!mind && mind.mood !== "watching" && now - mind.at < 6000;
  const caught = stats ? stats.reports_filed : 0;
  return (
    <article className={`agent ${live ? "live" : ""}`} style={{ ["--hue" as any]: `var(--${a.hue})` }}>
      <div className="agent-top">
        <Avatar name={name} size={58} />
        <span className={`mood ${live ? mind!.mood : ""}`}>{live ? mind!.mood : "watching"}</span>
      </div>
      <h3>{name}</h3>
      <span className="role">{a.title}</span>
      <p className="persona">{PERSONALITY[name]}</p>
      <div className="thought">
        <small>thinking</small>
        <p>{mind?.thought ?? "…"}</p>
      </div>
      <dl className="agent-stats">
        <div><dt>reported</dt><dd className="mono">{caught}</dd></div>
        <div><dt>record</dt><dd className="mono" title="votes on the right side / wrong side">{stats ? `${stats.correct}✓ ${stats.wrong}✗` : "0✓ 0✗"}</dd></div>
        <div><dt>tx read</dt><dd className="mono">{(mind?.seen ?? 0).toLocaleString()}</dd></div>
      </dl>
      {memory && memory.length > 0 && (
        <p className="memory-note">
          Remembers {memory.length} scam contract{memory.length === 1 ? "" : "s"} by code fingerprint, so a copy under a new name is caught on sight.
        </p>
      )}
      {account && (
        <a className="acct mono" href={accUrl(account)} target="_blank" rel="noreferrer">
          {short(account, 36)} ↗
        </a>
      )}
    </article>
  );
}

// ================================================================================
// Mainnet radar: the same detectors, pointed at NEAR mainnet, read-only.

const MAINNET = { dataUrl: "https://mainnet.neardata.xyz", rpcUrl: "https://rpc.mainnet.fastnear.com", explorer: "https://nearblocks.io" };

function Radar() {
  const [stats, setStats] = useState<WatcherStats | null>(null);
  const [hits, setHits] = useState<(Finding & { at: number })[]>([]);
  const [name, setName] = useState("");
  const w = useRef<BrowserWatcher | null>(null);
  const now = useNow();
  useEffect(() => () => w.current?.stop(), []);

  const toggle = () => {
    if (w.current) {
      w.current.stop();
      w.current = null;
      setStats((st) => (st ? { ...st, running: false } : st));
      return;
    }
    w.current = new BrowserWatcher({
      network: "mainnet",
      dataUrl: MAINNET.dataUrl,
      rpcUrl: MAINNET.rpcUrl,
      api: API,
      master: "",
      readOnly: true,
      only: ["lookalike", "malicious_contract"],
      protectedNames: () => MAINNET_PROTECTED,
      knownBadCode: () => new Map(),
      onBlock: (_txs, st) => setStats({ ...st }),
      onFinding: (f) => setHits((h) => [{ ...f, at: Date.now() }, ...h].slice(0, 20)),
    }).start();
    setStats({ ...w.current.stats });
  };

  const q = name.trim().toLowerCase();
  const fooled = q.length > 3 ? imitates(q.includes(".") || q === "near" ? q : `${q}.near`, MAINNET_PROTECTED, 2) : null;
  const running = !!stats?.running;

  return (
    <section className="section radar" id="radar">
      <div className="section-h">
        <span className="eyebrow">Mainnet radar</span>
        <h2>Point the agents at the real NEAR</h2>
        <p>
          The same detectors, scanning NEAR mainnet live from your browser, read-only. They look for new accounts named to imitate famous ones and for
          contracts built as airdrop lures. Anything found here is shown, never reported: no one is accused on chain.
        </p>
      </div>
      <div className="radar-grid">
        <div className="radar-live">
          <button type="button" className={`btn ${running ? "stop" : ""}`} onClick={toggle}>
            {running ? "Stop scanning" : "Scan NEAR mainnet live"}
          </button>
          {stats ? (
            <dl className="radar-stats">
              <div><dt>block</dt><dd className="mono">{stats.height ? stats.height.toLocaleString() : "…"}</dd></div>
              <div><dt>mainnet tx checked</dt><dd className="mono">{stats.txs.toLocaleString()}</dd></div>
              <div><dt>new accounts</dt><dd className="mono">{stats.accounts.toLocaleString()}</dd></div>
              <div><dt>contracts deployed</dt><dd className="mono">{stats.deploys.toLocaleString()}</dd></div>
            </dl>
          ) : (
            <p className="muted small">Uses your connection: about one block a second. Nothing is sent anywhere.</p>
          )}
          {stats?.error && running && <p className="muted small">Reconnecting to mainnet…</p>}
          <div className="hits" aria-live="polite">
            {hits.length === 0 && stats && <p className="muted small">{running ? "No imitations or lure contracts so far. Most blocks are honest." : "Scan stopped."}</p>}
            {hits.map((h) => (
              <article key={`${h.target}${h.at}`} className="hit">
                <span className="hit-kind">{h.category === "Lookalike" ? "Imitation" : "Lure contract"}</span>
                <a className="mono" href={`${MAINNET.explorer}/address/${h.target}`} target="_blank" rel="noreferrer">
                  {h.target} ↗
                </a>
                <small>{h.reason} · {ago(h.at, now)}</small>
              </article>
            ))}
          </div>
        </div>
        <div className="radar-name">
          <b>Would this name fool people?</b>
          <p className="muted small">Type an account name. The look-alike agent compares it with {MAINNET_PROTECTED.length} famous NEAR accounts, catching swapped letters and look-alike characters such as 0 for o.</p>
          <input id="radar-name" aria-label="Account name to test" placeholder="ref-flnance.near" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
          {q.length > 3 && (
            <p className={`verdict-line ${fooled ? "bad" : "good"}`}>
              {fooled ? (
                <>
                  Imitates <b className="mono">{fooled}</b>. t-helper would flag it the moment it's created.
                </>
              ) : MAINNET_PROTECTED.includes(q) || MAINNET_PROTECTED.includes(`${q}.near`) ? (
                <>That's the real account.</>
              ) : (
                <>Doesn't imitate any of the famous accounts we protect.</>
              )}
            </p>
          )}
          <div className="examples left">
            {["ref-flnance.near", "wrap0.near", "1ntents.near", "rnintbase1.near"].map((x) => (
              <button key={x} type="button" onClick={() => setName(x)}>{x}</button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ================================================================================

function Checker({ reports, protectedNames }: { reports: any[]; protectedNames: string[] }) {
  const [id, setId] = useState("");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (value = id) => {
    const q = value.trim().toLowerCase();
    if (!q) return;
    setId(q);
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/check/${encodeURIComponent(q)}`);
      setRes(await r.json());
    } catch {
      setRes({ error: "Can't reach the registry right now." });
    } finally {
      setBusy(false);
    }
  };
  const examples = [...reports.filter((r) => r.status === "Confirmed").slice(0, 2).map((r) => r.target), ...protectedNames.slice(0, 1)];
  return (
    <section className="section check" id="check">
      <div className="section-h center">
        <span className="eyebrow">Check before you pay</span>
        <h2>Is this account safe to pay?</h2>
        <p>Type the account you're about to send money to. Never a seed phrase or key: only the public name.</p>
      </div>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input id="check-account" aria-label="Account to check" placeholder="someone.testnet" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>
      {examples.length > 0 && (
        <div className="examples">
          <span>Try</span>
          {examples.map((x) => (
            <button key={x} type="button" onClick={() => void run(x)}>
              {short(x, 32)}
            </button>
          ))}
        </div>
      )}
      {res && (
        <div className={`answer ${res.error ? "bad" : res.safe ? "good" : "bad"}`} role="status">
          {res.error ? (
            <p>{res.error}</p>
          ) : res.safe ? (
            <>
              <span className="answer-icon" aria-hidden="true">✓</span>
              <div>
                <b>No confirmed threats</b>
                <p className="mono">{res.account_id}</p>
                <small>{res.pending_reports.length ? `Report #${res.pending_reports.join(", #")} is still being voted on. Check again in a few seconds.` : "The swarm hasn't caught this account doing anything wrong. That means not caught yet, not guaranteed safe."}</small>
              </div>
            </>
          ) : (
            <>
              <span className="answer-icon" aria-hidden="true">!</span>
              <div>
                <b>Do not pay this account</b>
                <p className="mono">{res.account_id}</p>
                <small>
                  {res.categories.map(human).join(", ")} · risk {res.risk}/100 · confirmed in report #{res.report_ids.join(", #")}
                </small>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ================================================================================

function Registry({
  reports,
  sentinelAccounts,
  txUrl,
  accUrl,
  now,
  chain,
  findings,
}: {
  reports: any[];
  sentinelAccounts: Record<string, string>;
  txUrl: (h: string) => string;
  accUrl: (a: string) => string;
  now: number;
  chain: Ev[];
  findings: Ev[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const nameOf = Object.fromEntries(Object.entries(sentinelAccounts).map(([n, a]) => [a, n]));
  const observed = findings.filter((f) => f.scope === "observed").slice(-3).reverse();
  return (
    <section className="section" id="registry">
      <div className="section-h">
        <span className="eyebrow">The registry</span>
        <h2>Every verdict, onchain</h2>
        <p>A report needs at least 3 votes and 66% of the staked NEAR to be confirmed. Click a row for the evidence.</p>
      </div>
      <div className="ledger">
        {reports.length === 0 && <p className="muted">No reports yet. Release a scam at the top of the page.</p>}
        {reports.slice(0, 10).map((r) => {
          const yes = r.votes.filter((v: any) => v.support).reduce((a: bigint, v: any) => a + BigInt(v.stake), 0n);
          const total = r.votes.reduce((a: bigint, v: any) => a + BigInt(v.stake), 0n);
          const pct = total ? Number((yes * 1000n) / total) / 10 : 0;
          const left = Math.max(0, Math.ceil((Number(BigInt(r.deadline_ns) / 1_000_000n) - now) / 1000));
          const reporter = nameOf[r.reporter];
          const isOpen = open === r.id;
          let ev: any = {};
          try {
            ev = JSON.parse(r.evidence);
          } catch {
            /* ignore */
          }
          const tx = chain.find((c) => c.action === "flag" && c.reportId === r.id && c.hash)?.hash;
          return (
            <article key={r.id} className={`entry ${r.status} ${isOpen ? "open" : ""}`}>
              <button type="button" className="entry-row" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                <span className={`status ${r.status}`}>{r.status === "Open" ? `voting ${left}s` : r.status}</span>
                <span className="entry-main">
                  <b className="mono">{short(r.target, 46)}</b>
                  <small>{human(r.category)} · caught by {reporter ?? "a sentinel"}</small>
                </span>
                <span className="entry-votes" aria-label={`${r.votes.length} votes`}>
                  {r.votes.map((v: any) => (
                    <span key={v.sentinel} className={v.support ? "yes" : "no"} title={`${nameOf[v.sentinel] ?? v.sentinel}: ${v.support ? "confirmed" : "disputed"}`}>
                      {nameOf[v.sentinel] ? <Avatar name={nameOf[v.sentinel]} size={22} /> : "•"}
                    </span>
                  ))}
                </span>
                <span className="chev" aria-hidden="true">{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && (
                <div className="entry-body">
                  <p>{r.summary}</p>
                  <div className="stakebar" title={`${pct}% of staked NEAR confirms`}>
                    <span style={{ width: `${pct}%` }} />
                    <i />
                  </div>
                  <small className="muted">
                    {pct}% of {fmtNear(total.toString(), 2)} NEAR staked says "confirmed" · severity {r.severity}/10 · {ev.detector ?? "detector"}
                  </small>
                  <div className="links">
                    <a href={accUrl(r.target)} target="_blank" rel="noreferrer">account ↗</a>
                    {tx && <a href={txUrl(tx)} target="_blank" rel="noreferrer">report transaction ↗</a>}
                    {Array.isArray(ev.txs) && ev.txs.slice(0, 3).map((h: string, i: number) => (
                      <a key={h} href={txUrl(h)} target="_blank" rel="noreferrer">evidence {i + 1} ↗</a>
                    ))}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {observed.length > 0 && (
        <p className="observed-note">
          Also spotted on public testnet, but <b>not reported</b> (the swarm only accuses accounts in its own demo):{" "}
          {observed.map((f, i) => (
            <span key={f.id} className="mono">
              {i ? ", " : ""}
              {human(f.category).toLowerCase()} {short(f.target, 24)} ({ago(f.ts, now)})
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

// ================================================================================

function Developers({ registry }: { registry: string }) {
  const [copied, setCopied] = useState(false);
  const code = `// Ask Leukonet before your wallet or agent pays anyone
const res = await fetch("https://rpc.testnet.fastnear.com", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "query",
    params: {
      request_type: "call_function", finality: "final",
      account_id: "${registry}",
      method_name: "is_safe",
      args_base64: btoa(JSON.stringify({ account_id: "someone.testnet" })),
    },
  }),
});
const check = JSON.parse(new TextDecoder().decode(new Uint8Array((await res.json()).result.result)));
if (!check.safe) throw new Error("Leukonet: do not pay, " + check.categories.join(", "));`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="section dev" id="developers">
      <div className="section-h">
        <span className="eyebrow">For developers</span>
        <h2>One free call before every payment</h2>
        <p>
          No key, no wallet, no fee: <span className="mono">is_safe</span> is a read-only view on the registry contract. Use it from any language, or wrap
          payments with the guard in <span className="mono">src/sdk/guard.ts</span>.
        </p>
      </div>
      <div className="code">
        <button type="button" className="ghost-btn copy" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    </section>
  );
}
