import { useEffect, useMemo, useRef, useState } from "react";
import { useSwarm, type Ev, type SwarmState } from "./useSwarm";
import { useAgents, type AgentMind } from "./useAgents";
import { ThreatMap } from "./ThreatMap";
import { AGENTS, agentByName, glyph } from "./agents";
import { API } from "./api";

const fmtNear = (y: string | number | bigint, d = 3) => (Number(BigInt(String(y)) / 10n ** 18n) / 1e6).toFixed(d);
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const short = (id: string, n = 30) => (id.length > n ? `${id.slice(0, n - 12)}…${id.slice(-10)}` : id);
const ago = (ms: number, now: number) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

/** Which agent catches which simulated attack. */
const CATCHER: Record<string, string> = {
  drainer: "neutrophil",
  key_hijack: "neutrophil",
  malicious_contract: "macrophage",
  rogue_agent: "nk-cell",
  lookalike: "t-helper",
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const a = agentByName(name);
  const svg = glyph(name, "currentColor", "BG").replace(/fill="BG"/g, 'style="fill:var(--bg)"');
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, color: `var(--${a?.hue ?? "accent"})` }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
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
    <button className="icon-btn" type="button" onClick={() => setTheme(next)} aria-label="Switch colour theme">
      {theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto"}
    </button>
  );
}

export function App() {
  const [s, subscribe] = useSwarm();
  const now = useNow();
  const meta = s.meta;
  const explorer = meta?.explorer ?? "https://testnet.nearblocks.io";
  const txUrl = (h: string) => `${explorer}/txns/${h}`;
  const accUrl = (a: string) => `${explorer}/address/${a}`;
  const memorySize = new Set([...Object.keys(meta?.memory ?? {}), ...s.memory.map((m) => m.codeHash)]).size;
  const minds = useAgents(
    AGENTS.map((a) => a.name),
    subscribe,
    memorySize,
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

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true" className="logo">
            <circle cx="16" cy="16" r="6" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
            <g stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round">
              <path d="M16 4v4M16 24v4M4 16h4M24 16h4M7.5 7.5l2.8 2.8M21.7 21.7l2.8 2.8M7.5 24.5l2.8-2.8M21.7 10.3l2.8-2.8" />
            </g>
            <circle cx="16" cy="16" r="2" fill="var(--chain)" />
          </svg>
          <div>
            <h1>
              leuko<span>net</span>
            </h1>
            <p>An immune system for NEAR</p>
          </div>
        </div>
        <div className="top-right">
          <span className={`pill ${s.connected ? "" : "off"}`}>
            <span className="dot" />
            {s.connected ? `${meta?.network ?? "testnet"} · live` : "reconnecting…"}
          </span>
          {lastBlock && <span className="pill mono">block {lastBlock.height.toLocaleString()}</span>}
          {meta && (
            <a className="pill" href={accUrl(meta.registry)} target="_blank" rel="noreferrer">
              registry contract ↗
            </a>
          )}
          <ThemeToggle />
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <h2>
            Five AI agents guard NEAR. <em>Release a scam and watch them catch it.</em>
          </h2>
          <p>
            They read every block as it lands, stake NEAR when they spot a scam, check each other's work, and write confirmed
            threats to a public registry that any wallet or agent checks before paying.
          </p>
        </div>
        <div className="hero-stats">
          <Stat label="Tx / sec watched" value={tps.toFixed(1)} />
          <Stat label="Threats confirmed" value={s.stats?.confirmed ?? "–"} hot />
          <Stat label="Reports filed" value={s.stats?.reports ?? "–"} />
          <Stat label="Scam codes remembered" value={memorySize} />
        </div>
      </section>

      <div className="grid">
        <section className="panel map-panel">
          <div className="panel-h">
            <h2>The bloodstream</h2>
            <div className="legend">
              <span><i style={{ background: "var(--particle)" }} />live testnet tx</span>
              <span><i style={{ background: "var(--accent)" }} />simulation tx</span>
              <span><i style={{ background: "var(--pending)" }} />being voted on</span>
              <span><i style={{ background: "var(--threat)" }} />confirmed threat</span>
            </div>
          </div>
          <div className="map-wrap">
            {meta && <ThreatMap sentinelAccounts={meta.sentinelAccounts} reports={s.reports} subscribe={subscribe} busy={busy} />}
            <div className="map-caption">
              <span>{lastBlock ? (lastBlock.lag <= 2 ? "in sync with the chain" : `${lastBlock.lag} blocks behind`) : "connecting to testnet…"}</span>
              <span>each transaction flows to the agent that inspects it · hover a dot</span>
            </div>
          </div>
        </section>

        <Simulation s={s} minds={minds} txUrl={txUrl} accUrl={accUrl} now={now} />
      </div>

      <section className="panel">
        <div className="panel-h">
          <h2>The swarm</h2>
          <span className="muted small">each agent is its own NEAR account with its own bond, and they check each other</span>
        </div>
        <div className="panel-b agents">
          {AGENTS.map((a) => (
            <AgentCard
              key={a.name}
              name={a.name}
              mind={minds[a.name]}
              account={meta?.sentinelAccounts?.[a.name]}
              stats={s.sentinels.find((x) => x.account_id === meta?.sentinelAccounts?.[a.name])}
              now={now}
              accUrl={accUrl}
            />
          ))}
        </div>
      </section>

      <div className="grid">
        <Reports reports={s.reports} sentinelAccounts={meta?.sentinelAccounts ?? {}} chain={s.chain} txUrl={txUrl} accUrl={accUrl} now={now} />
        <div className="col">
          <Checker reports={s.reports} protectedNames={meta?.protected ?? []} />
          <Findings findings={s.findings} explains={s.explains} now={now} />
          <Memory meta={meta} live={s.memory} />
        </div>
      </div>

      <section className="panel">
        <div className="panel-h"><h2>How it works</h2></div>
        <div className="panel-b how">
          <div><span className="how-n">1</span><b>Watch</b><p>Five agents read every testnet block as it lands, about one a second. Each transaction flows to the agent that knows that kind of trick.</p></div>
          <div><span className="how-n">2</span><b>Flag and stake</b><p>An agent that spots a drainer, stolen key, scam contract, rogue agent or fake name files a report and puts 0.02 NEAR on it.</p></div>
          <div><span className="how-n">3</span><b>Check each other</b><p>The others re-check the evidence themselves, with their own thresholds, and vote with stake. Wrong voters lose their stake to right ones.</p></div>
          <div><span className="how-n">4</span><b>Protect</b><p>Confirmed threats land in the registry. Wallets and agents call <span className="mono">is_safe</span> before paying, and the robber gets nothing.</p></div>
        </div>
      </section>

      <footer>
        <span>Leukonet · built for NEAR HACKATHON 2026</span>
        {meta && <span className="mono">{meta.registry}</span>}
        <span>{meta?.nearAi ? "Explanations by NEAR AI Cloud" : "Explanations: built-in (no NEAR AI key set)"}</span>
        <a href="https://github.com/carynyx80/leukonet" target="_blank" rel="noreferrer">source ↗</a>
      </footer>

      <VerdictToast attack={s.attack} />
    </div>
  );
}

function Stat({ label, value, hot }: { label: string; value: string | number; hot?: boolean }) {
  return (
    <div className={`stat ${hot ? "hot" : ""}`}>
      <b key={String(value)} className="bump">{value}</b>
      <span>{label}</span>
    </div>
  );
}

// ----- Simulation ---------------------------------------------------------------

const PHASES = ["Attack", "Detect", "Report", "Vote", "Verdict", "Protected"] as const;

function Simulation({
  s,
  minds,
  txUrl,
  accUrl,
  now,
}: {
  s: SwarmState;
  minds: Record<string, AgentMind>;
  txUrl: (h: string) => string;
  accUrl: (a: string) => string;
  now: number;
}) {
  const [err, setErr] = useState<string | null>(null);
  const meta = s.meta;
  const launch = async (kind: string) => {
    setErr(null);
    try {
      const res = await fetch(`${API}/api/attack/${kind}`, { method: "POST" });
      if (!res.ok) setErr((await res.json()).error ?? "Could not start the simulation");
    } catch {
      setErr("Could not reach the swarm. Is the backend running?");
    }
  };

  const steps = s.attack.filter((e) => e.stage !== "done");
  const start = steps.find((e) => e.stage === "start");
  const kind = start?.kind as string | undefined;
  const t0 = start?.ts ?? 0;
  const lastAttack = [...steps].reverse().find((e) => e.stage === "attack");
  const verdict = steps.find((e) => e.stage === "verdict");
  const blocked = steps.find((e) => e.stage === "guard_blocked");
  const failed = steps.find((e) => e.stage === "error" || e.stage === "timeout");
  const flag = start ? s.chain.find((c) => c.action === "flag" && c.ok && c.ts >= t0) : undefined;
  const detected = start ? s.findings.find((f) => f.scope === "filed" && f.ts >= t0) : undefined;
  const votes = flag ? s.chain.filter((c) => c.action === "vote" && c.ok && c.reportId === flag.reportId) : [];
  const running = !!s.attackRunning;

  const phaseAt: (number | undefined)[] = [
    lastAttack && (detected || steps.some((e) => e.stage === "waiting")) ? lastAttack.ts : undefined,
    detected?.ts,
    flag?.ts,
    votes.length >= 2 ? votes[votes.length - 1].ts : undefined,
    verdict?.ts,
    blocked?.ts,
  ];
  const current = phaseAt.findIndex((t) => t === undefined);
  const caughtIn = verdict && lastAttack ? Math.max(1, Math.round((verdict.ts - lastAttack.ts) / 1000)) : null;
  const elapsed = lastAttack ? Math.max(0, Math.round(((running ? now : steps[steps.length - 1]?.ts ?? now) - lastAttack.ts) / 1000)) : 0;
  const target = verdict?.detail?.split(" ")[0] ?? "";
  const catcher = kind ? CATCHER[kind] : undefined;
  const story = [...steps].reverse().find((e) => e.detail)?.detail;
  const activeMind = catcher ? minds[catcher] : undefined;

  return (
    <section className="panel sim">
      <div className="panel-h">
        <h2>Run a simulation</h2>
        <span className="muted small">testnet · demo accounts only</span>
      </div>
      <div className="panel-b">
        {start && (
          <div className={`run ${verdict ? "won" : failed ? "lost" : ""}`}>
            <div className="run-head">
              {catcher && <Avatar name={catcher} size={32} />}
              <div>
                <b>{meta?.attacks.find((a) => a.kind === kind)?.label ?? kind}</b>
                <span className="muted small">{verdict ? `caught by ${catcher}` : catcher ? `${catcher} is on watch` : ""}</span>
              </div>
              <div className="clock mono">
                {caughtIn !== null ? `${caughtIn}s` : lastAttack ? `${elapsed}s` : "…"}
                <small>{caughtIn !== null ? "attack to verdict" : lastAttack ? "since the attack" : "setting up"}</small>
              </div>
            </div>
            <ol className="phases">
              {PHASES.map((p, i) => {
                const done = phaseAt[i] !== undefined;
                const active = !done && i === current && running;
                return (
                  <li key={p} className={done ? "done" : active ? "active" : ""}>
                    <i />
                    <span>{p}</span>
                    <small className="mono">{done && lastAttack && i > 0 ? `+${Math.max(0, Math.round((phaseAt[i]! - lastAttack.ts) / 1000))}s` : " "}</small>
                  </li>
                );
              })}
            </ol>
            {flag && (
              <div className="voters">
                {AGENTS.map((a) => {
                  const vote = votes.find((x) => x.sentinel === a.name);
                  const v = a.name === flag.sentinel ? "reporter" : vote ? (vote.support ? "yes" : "no") : "wait";
                  return (
                    <span key={a.name} className={`voter ${v}`} title={`${a.name}: ${v}`}>
                      <Avatar name={a.name} size={24} />
                      <small>{v === "reporter" ? "reported" : v === "yes" ? "confirmed" : v === "no" ? "disputed" : "checking…"}</small>
                    </span>
                  );
                })}
              </div>
            )}
            <p className="story" aria-live="polite">
              {verdict ? verdict.detail : activeMind && activeMind.mood !== "watching" && now - activeMind.at < 8000 ? activeMind.thought : story}
            </p>
            {blocked && (
              <div className="guard-card">
                <b>Payment blocked</b>
                <span>{blocked.detail}</span>
                {target && (
                  <a className="mono" href={accUrl(target)} target="_blank" rel="noreferrer">
                    {short(target, 34)} on the explorer ↗
                  </a>
                )}
              </div>
            )}
            {failed && <p className="neg small">{failed.detail}</p>}
            <details className="raw">
              <summary>Every step, with transactions</summary>
              <div className="timeline">
                {steps.map((e, i) => (
                  <div key={i} className={`step ${e.stage}`}>
                    <time>{time(e.ts)}</time>
                    <i />
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
        )}

        {meta?.demoControls ? (
          <>
            <p className="pick">{start ? (running ? "One simulation at a time. Watch this one play out." : "Release another:") : "Pick a scam to release on testnet:"}</p>
            <div className="attacks">
              {meta.attacks.map((a) => (
                <button
                  key={a.kind}
                  type="button"
                  className={`attack-btn ${s.attackRunning === a.kind ? "running" : ""}`}
                  disabled={running}
                  onClick={() => void launch(a.kind)}
                  style={{ ["--hue" as any]: `var(--${agentByName(CATCHER[a.kind])?.hue})` }}
                >
                  <Avatar name={CATCHER[a.kind]} size={28} />
                  <span className="attack-text">
                    <b>{a.label}</b>
                    <small>{a.story}</small>
                  </span>
                  <span className="go">{s.attackRunning === a.kind ? "running" : "release"}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="empty">Simulations are switched off on this server.</p>
        )}
        {err && <p className="neg small">{err}</p>}
      </div>
    </section>
  );
}

function VerdictToast({ attack }: { attack: Ev[] }) {
  const [shown, setShown] = useState<Ev | null>(null);
  const seen = useRef<number>(0);
  useEffect(() => {
    const v = attack.find((e) => e.stage === "verdict");
    if (v && v.ts !== seen.current && Date.now() - v.ts < 30_000) {
      seen.current = v.ts;
      setShown(v);
      const t = setTimeout(() => setShown(null), 7000);
      return () => clearTimeout(t);
    }
  }, [attack]);
  if (!shown) return null;
  return (
    <div className="toast" role="status">
      <b>Threat confirmed onchain</b>
      <span>{shown.detail}</span>
      <button type="button" onClick={() => setShown(null)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

// ----- Agents -------------------------------------------------------------------

function AgentCard({
  name,
  mind,
  account,
  stats,
  now,
  accUrl,
}: {
  name: string;
  mind?: AgentMind;
  account?: string;
  stats?: any;
  now: number;
  accUrl: (a: string) => string;
}) {
  const a = agentByName(name)!;
  const live = !!mind && mind.mood !== "watching" && now - mind.at < 6000;
  const earnings = stats ? Number(BigInt(stats.earnings)) / 1e24 : 0;
  return (
    <article className={`agent ${live ? "live" : ""}`} style={{ ["--hue" as any]: `var(--${a.hue})` }}>
      <header>
        <Avatar name={name} size={42} />
        <div>
          <h3>{name}</h3>
          <span>{a.title}</span>
        </div>
        <span className={`mood ${live ? mind!.mood : "watching"}`}>{live ? mind!.mood : "watching"}</span>
      </header>
      <div className="bubble">
        <p>{mind?.thought ?? "…"}</p>
      </div>
      <div className="kv">
        <div><span>catches</span>{a.catches}</div>
        <div><span>looked at</span><b className="mono">{(mind?.seen ?? 0).toLocaleString()} txs</b></div>
        <div><span>right / wrong</span><b className="mono">{stats ? `${stats.correct} / ${stats.wrong}` : "0 / 0"}</b></div>
        <div><span>stake won</span><b className={`mono ${earnings > 0 ? "pos" : earnings < 0 ? "neg" : ""}`}>{earnings >= 0 ? "+" : ""}{earnings.toFixed(3)}</b></div>
      </div>
      {mind && mind.log.length > 0 && (
        <ul className="agent-log">
          {mind.log.slice(0, 3).map((l, i) => (
            <li key={i} className={l.tone}>
              <time className="mono">{ago(l.at, now)}</time> {l.text}
            </li>
          ))}
        </ul>
      )}
      {account && (
        <a className="mono acct" href={accUrl(account)} target="_blank" rel="noreferrer">
          {short(account, 40)} ↗
        </a>
      )}
    </article>
  );
}

// ----- Reports ------------------------------------------------------------------

function Reports({
  reports,
  sentinelAccounts,
  txUrl,
  accUrl,
  now,
  chain,
}: {
  reports: any[];
  sentinelAccounts: Record<string, string>;
  txUrl: (h: string) => string;
  accUrl: (a: string) => string;
  now: number;
  chain: Ev[];
}) {
  const nameOf = Object.fromEntries(Object.entries(sentinelAccounts).map(([n, a]) => [a, n]));
  const flagTx = (id: number) => chain.find((c) => c.action === "flag" && c.reportId === id && c.hash)?.hash;
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>The registry</h2>
        <span className="muted small">newest first · needs 3 votes and 66% of the stake</span>
      </div>
      <div className="panel-b reports">
        {reports.length === 0 && <p className="empty">No reports yet. Release a scam and the first one appears here within seconds.</p>}
        {reports.slice(0, 8).map((r) => {
          const left = Math.max(0, Math.ceil((Number(BigInt(r.deadline_ns) / 1_000_000n) - now) / 1000));
          let ev: any = {};
          try {
            ev = JSON.parse(r.evidence);
          } catch {
            /* ignore */
          }
          const yes = r.votes.filter((v: any) => v.support).reduce((a: bigint, v: any) => a + BigInt(v.stake), 0n);
          const no = r.votes.filter((v: any) => !v.support).reduce((a: bigint, v: any) => a + BigInt(v.stake), 0n);
          const total = yes + no;
          const yesPct = total ? Number((yes * 1000n) / total) / 10 : 0;
          const tx = flagTx(r.id);
          const reporter = nameOf[r.reporter];
          return (
            <article key={r.id} className={`report ${r.status}`}>
              <div className="report-top">
                {reporter && <Avatar name={reporter} size={26} />}
                <a className="target" href={accUrl(r.target)} target="_blank" rel="noreferrer">
                  {short(r.target, 44)}
                </a>
                <span className="chip cat">{r.category.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
                <span className={`chip ${r.status}`}>{r.status === "Open" ? `voting · ${left}s` : r.status}</span>
                <span className="mono muted small">#{r.id}</span>
              </div>
              <p>{r.summary}</p>
              <div className="stakebar" title={`${yesPct}% of staked NEAR confirms`}>
                <span className="yes" style={{ width: `${yesPct}%` }} />
                <span className="no" style={{ width: `${100 - yesPct}%` }} />
                <i className="line66" />
              </div>
              <div className="votes">
                {r.votes.map((v: any) => (
                  <span key={v.sentinel} className={`vote ${v.support ? "yes" : "no"}`} title={v.note}>
                    {nameOf[v.sentinel] && <Avatar name={nameOf[v.sentinel]} size={16} />}
                    {v.support ? "✓" : "✗"} {nameOf[v.sentinel] ?? short(v.sentinel, 18)}
                  </span>
                ))}
              </div>
              <div className="report-foot">
                <span className="mono">{fmtNear(total.toString(), 2)} NEAR staked</span>
                <span>severity {r.severity}/10</span>
                {ev.detector && <span className="mono">{ev.detector}</span>}
                {tx && (
                  <a className="mono" href={txUrl(tx)} target="_blank" rel="noreferrer">
                    report tx ↗
                  </a>
                )}
                {Array.isArray(ev.txs) &&
                  ev.txs.slice(0, 3).map((h: string, i: number) => (
                    <a key={h} className="mono" href={txUrl(h)} target="_blank" rel="noreferrer">
                      evidence {i + 1} ↗
                    </a>
                  ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ----- Side panels --------------------------------------------------------------

function Findings({ findings, explains, now }: { findings: Ev[]; explains: Record<string, Ev>; now: number }) {
  const list = [...findings].reverse().slice(0, 24);
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>What the agents noticed</h2>
      </div>
      <div className="panel-b">
        {list.length === 0 && <p className="empty">Nothing suspicious yet. Every testnet transaction is being read.</p>}
        <div className="feed">
          {list.map((f) => (
            <div key={f.id} title={explains[f.id]?.text ?? f.reason}>
              <Avatar name={f.sentinel} size={18} />
              <span className={f.scope === "filed" ? "filed" : "observed"}>
                {f.category.replace(/([a-z])([A-Z])/g, "$1 $2")} · {f.target}
              </span>
              <span className="muted">{ago(f.ts, now)}</span>
            </div>
          ))}
        </div>
        <p className="muted small" style={{ margin: "10px 0 0" }}>
          <span className="filed">Filed</span> = reported and staked on. <span className="observed">Observed</span> = spotted on public
          testnet, never reported: the swarm only accuses accounts in its own demo.
        </p>
      </div>
    </section>
  );
}

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
      setRes({ error: "Could not reach the registry" });
    } finally {
      setBusy(false);
    }
  };
  const examples = [...reports.filter((r) => r.status === "Confirmed").slice(0, 1).map((r) => r.target), ...protectedNames.slice(0, 1)];
  return (
    <section className="panel">
      <div className="panel-h"><h2>Check before you pay</h2></div>
      <div className="panel-b">
        <form
          className="checker"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input id="check-account" aria-label="Account to check" placeholder="someone.testnet" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" spellCheck={false} />
          <button className="btn" type="submit" disabled={busy}>{busy ? "Checking…" : "Check"}</button>
        </form>
        {examples.length > 0 && (
          <div className="examples">
            <span className="muted small">try</span>
            {examples.map((x) => (
              <button key={x} type="button" className="ex" onClick={() => void run(x)}>
                {short(x, 30)}
              </button>
            ))}
          </div>
        )}
        {res && (
          <div className={`check-result ${res.error ? "bad" : res.safe ? "good" : "bad"}`}>
            {res.error ? (
              res.error
            ) : res.safe ? (
              <>
                <b>No confirmed threats</b>
                <span>
                  {res.account_id}
                  {res.pending_reports.length ? ` · report #${res.pending_reports.join(", #")} still being voted on` : ""}
                </span>
              </>
            ) : (
              <>
                <b>Do not pay</b>
                <span>
                  {res.account_id}: {res.categories.join(", ")} · risk {res.risk}/100 · report #{res.report_ids.join(", #")}
                </span>
              </>
            )}
          </div>
        )}
        <p className="muted small" style={{ margin: "10px 0 0" }}>
          Paste the account you are about to <b>pay</b>, never a seed phrase or key. Wallets and agents make this same free call,{" "}
          <span className="mono">is_safe</span>, automatically.
        </p>
      </div>
    </section>
  );
}

function Memory({ meta, live }: { meta: any; live: Ev[] }) {
  const entries: [string, number][] = [
    ...Object.entries((meta?.memory ?? {}) as Record<string, number>),
    ...live.map((m) => [m.codeHash, m.reportId] as [string, number]),
  ].filter((e, i, a) => a.findIndex((x) => x[0] === e[0]) === i);
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>Immune memory</h2>
        <Avatar name="b-cell" size={20} />
      </div>
      <div className="panel-b">
        {entries.length === 0 ? (
          <p className="empty">Once a scam contract is confirmed, its code is remembered, and caught on sight wherever it is deployed next.</p>
        ) : (
          <div className="memory">
            {entries.map(([h, r]) => (
              <div key={h}>
                <span className="mono">{h}</span>
                <span className="muted">from #{r}</span>
              </div>
            ))}
            <p className="muted small">Release "Airdrop scam contract" again: the same code under a new name is caught from memory.</p>
          </div>
        )}
      </div>
    </section>
  );
}
