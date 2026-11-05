import { useEffect, useMemo, useState } from "react";
import { useSwarm, type Ev } from "./useSwarm";
import { ThreatMap } from "./ThreatMap";
import { API } from "./api";

const fmtNear = (y: string | number | bigint, d = 3) => (Number(BigInt(String(y)) / 10n ** 18n) / 1e6).toFixed(d);
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const short = (id: string, n = 30) => (id.length > n ? `${id.slice(0, n - 12)}…${id.slice(-10)}` : id);

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
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
          <svg width="36" height="36" viewBox="0 0 32 32" aria-hidden="true">
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
            <p>An immune system for NEAR. AI sentinels catch scams live and stake on their verdicts.</p>
          </div>
        </div>
        <div className="top-right">
          <span className={`pill ${s.connected ? "" : "off"}`}>
            <span className="dot" />
            {s.connected ? `${meta?.network ?? "testnet"} live` : "reconnecting"}
          </span>
          {lastBlock && <span className="pill mono">block {lastBlock.height.toLocaleString()}</span>}
          {meta && (
            <a className="pill" href={accUrl(meta.registry)} target="_blank" rel="noreferrer">
              registry ↗
            </a>
          )}
          <ThemeToggle />
        </div>
      </header>

      <section className="stats" aria-label="Swarm status">
        <div className="stat"><b>{s.stats?.sentinels ?? "–"}</b><span>Sentinels</span></div>
        <div className="stat"><b>{tps.toFixed(1)}</b><span>Tx / sec watched</span></div>
        <div className="stat"><b>{s.stats?.reports ?? "–"}</b><span>Reports filed</span></div>
        <div className="stat hot"><b>{s.stats?.confirmed ?? "–"}</b><span>Threats confirmed</span></div>
        <div className="stat"><b>{s.stats?.rejected ?? "–"}</b><span>Rejected</span></div>
        <div className="stat"><b>{Object.keys(meta?.memory ?? {}).length + s.memory.length}</b><span>Codes remembered</span></div>
      </section>

      <div className="grid">
        <div className="col">
          <section className="panel">
            <div className="panel-h">
              <h2>Threat map</h2>
              <div className="legend">
                <span><i style={{ background: "var(--particle)" }} />testnet tx</span>
                <span><i style={{ background: "var(--accent)" }} />demo tx / sentinel</span>
                <span><i style={{ background: "var(--pending)" }} />voting</span>
                <span><i style={{ background: "var(--threat)" }} />confirmed threat</span>
                <span><i style={{ background: "var(--chain)" }} />vote: confirm</span>
              </div>
            </div>
            <div className="map-wrap">
              {meta && <ThreatMap personas={meta.personas} sentinelAccounts={meta.sentinelAccounts} reports={s.reports} subscribe={subscribe} />}
              <div className="map-caption">
                <span>{lastBlock ? `${lastBlock.lag} blocks behind head` : "connecting…"}</span>
                <span>{s.txs.length ? `${s.txs.filter((t) => t.demo).length} demo txs in view` : ""}</span>
              </div>
            </div>
          </section>

          <Reports reports={s.reports} sentinelAccounts={meta?.sentinelAccounts ?? {}} chain={s.chain} txUrl={txUrl} accUrl={accUrl} now={now} />
          <Sentinels personas={meta?.personas ?? []} accounts={meta?.sentinelAccounts ?? {}} sentinels={s.sentinels} chain={s.chain} now={now} accUrl={accUrl} />
        </div>

        <div className="col">
          <AttackConsole s={s} txUrl={txUrl} />
          <Checker />
          <Findings findings={s.findings} explains={s.explains} />
          <Memory meta={meta} live={s.memory} />
        </div>
      </div>

      <section className="panel">
        <div className="panel-h"><h2>How it works</h2></div>
        <div className="panel-b how">
          <div><b>1 · Watch</b><p>Five sentinel agents read every testnet block as it lands, about one a second, through FastNear's neardata stream.</p></div>
          <div><b>2 · Flag</b><p>A specialist spots a drainer, hijacked key, scam contract, rogue agent or look-alike name, and stakes NEAR on its report.</p></div>
          <div><b>3 · Verify</b><p>The others re-check the evidence on chain with their own thresholds and vote with stake. Wrong voters lose stake to right ones.</p></div>
          <div><b>4 · Protect</b><p>Confirmed threats land in the registry. Any wallet or agent calls <span className="mono">is_safe</span> before paying.</p></div>
        </div>
      </section>

      <footer>
        <span>Leukonet · built for NEAR HACKATHON 2026</span>
        {meta && <span className="mono">registry: {meta.registry}</span>}
        <span>{meta?.nearAi ? "Explanations: NEAR AI Cloud" : "Explanations: template (no NEAR AI key set)"}</span>
      </footer>
    </div>
  );
}

function AttackConsole({ s, txUrl }: { s: ReturnType<typeof useSwarm>[0]; txUrl: (h: string) => string }) {
  const [err, setErr] = useState<string | null>(null);
  const meta = s.meta;
  const launch = async (kind: string) => {
    setErr(null);
    const res = await fetch(`${API}/api/attack/${kind}`, { method: "POST" });
    if (!res.ok) setErr((await res.json()).error ?? "Could not start the attack");
  };
  const blocked = [...s.attack].reverse().find((e) => e.stage === "guard_blocked");
  const verdict = [...s.attack].reverse().find((e) => e.stage === "verdict");
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>Launch an attack</h2>
        <span className="muted" style={{ fontSize: 12 }}>testnet · demo accounts only</span>
      </div>
      <div className="panel-b">
        {meta?.demoControls ? (
          <div className="attacks">
            {meta.attacks.map((a) => (
              <button
                key={a.kind}
                type="button"
                className={`attack-btn ${s.attackRunning === a.kind ? "running" : ""}`}
                disabled={!!s.attackRunning}
                onClick={() => void launch(a.kind)}
              >
                <b>{a.label}</b>
                <span className="go">{s.attackRunning === a.kind ? "running…" : "launch →"}</span>
                <small>{a.story}</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="empty">Attack controls are switched off on this server.</p>
        )}
        {err && <p className="neg" style={{ margin: "8px 0 0", fontSize: 13 }}>{err}</p>}
        {s.attack.length > 0 && (
          <div className="timeline" aria-live="polite">
            {s.attack
              .filter((e) => e.stage !== "done")
              .map((e, i) => (
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
        )}
        {blocked && verdict && (
          <div className="guard-card">
            <b>Payment blocked</b>
            <span>{blocked.detail}</span>
          </div>
        )}
      </div>
    </section>
  );
}

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
        <h2>Reports in the registry</h2>
        <span className="muted" style={{ fontSize: 12 }}>newest first · quorum 3 · 66% of stake confirms</span>
      </div>
      <div className="panel-b reports">
        {reports.length === 0 && <p className="empty">No reports yet. Launch an attack to see the swarm respond.</p>}
        {reports.slice(0, 8).map((r) => {
          const left = Math.max(0, Math.ceil((Number(BigInt(r.deadline_ns) / 1_000_000n) - now) / 1000));
          let ev: any = {};
          try {
            ev = JSON.parse(r.evidence);
          } catch {
            /* ignore */
          }
          const stake = r.votes.reduce((a: bigint, v: any) => a + BigInt(v.stake), 0n);
          const tx = flagTx(r.id);
          return (
            <article key={r.id} className={`report ${r.status}`}>
              <div className="report-top">
                <span className="mono muted">#{r.id}</span>
                <a className="target" href={accUrl(r.target)} target="_blank" rel="noreferrer">
                  {short(r.target, 44)}
                </a>
                <span className="chip cat">{r.category}</span>
                <span className={`chip ${r.status}`}>{r.status === "Open" ? `voting · ${left}s` : r.status}</span>
                <span className="sev" title={`Severity ${r.severity}/10`}>
                  {Array.from({ length: 10 }, (_, i) => (
                    <i key={i} className={i < r.severity ? "on" : ""} />
                  ))}
                </span>
              </div>
              <p>{r.summary}</p>
              <div className="votes">
                {r.votes.map((v: any) => (
                  <span key={v.sentinel} className={`vote ${v.support ? "yes" : "no"}`} title={v.note}>
                    {v.support ? "✓" : "✗"} {nameOf[v.sentinel] ?? short(v.sentinel, 18)} · {fmtNear(v.stake, 2)}
                  </span>
                ))}
              </div>
              <div className="report-foot">
                <span>reported by {nameOf[r.reporter] ?? r.reporter}</span>
                <span className="mono">{fmtNear(stake.toString(), 2)} NEAR staked</span>
                {ev.detector && <span className="mono">detector: {ev.detector}</span>}
                {tx && (
                  <a className="mono" href={txUrl(tx)} target="_blank" rel="noreferrer">
                    flag tx ↗
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

function Sentinels({
  personas,
  accounts,
  sentinels,
  chain,
  now,
  accUrl,
}: {
  personas: { name: string; role: string; specialties: string[]; coordinator: boolean }[];
  accounts: Record<string, string>;
  sentinels: any[];
  chain: Ev[];
  now: number;
  accUrl: (a: string) => string;
}) {
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>The swarm</h2>
        <span className="muted" style={{ fontSize: 12 }}>each sentinel is its own NEAR account with its own bond</span>
      </div>
      <div className="panel-b sentinels">
        {personas.map((p) => {
          const acc = accounts[p.name];
          const st = sentinels.find((x) => x.account_id === acc);
          const last = [...chain].reverse().find((c) => c.sentinel === p.name);
          const earnings = st ? Number(BigInt(st.earnings)) / 1e24 : 0;
          return (
            <div key={p.name} className={`sentinel ${last && now - last.ts < 2500 ? "flash" : ""}`}>
              <h3>
                {p.name}
                <small>{p.coordinator ? "coordinator" : p.specialties.length ? p.specialties.join(", ").replace(/_/g, " ") : "verifier"}</small>
              </h3>
              <p>{p.role}</p>
              {acc && (
                <a className="mono" style={{ fontSize: 11 }} href={accUrl(acc)} target="_blank" rel="noreferrer">
                  {short(acc, 34)}
                </a>
              )}
              <div className="kv">
                <div><span>reports</span>{st?.reports_filed ?? 0}</div>
                <div><span>right / wrong</span>{st ? `${st.correct} / ${st.wrong}` : "0 / 0"}</div>
                <div><span>earned</span><b className={earnings >= 0 ? "pos" : "neg"}>{earnings >= 0 ? "+" : ""}{earnings.toFixed(3)}</b></div>
              </div>
              <p className="mono" style={{ fontSize: 11 }}>
                {last ? `${last.action}${last.reportId !== undefined ? ` #${last.reportId}` : ""}${last.support === false ? " (against)" : ""} · ${Math.round((now - last.ts) / 1000)}s ago` : "watching"}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Findings({ findings, explains }: { findings: Ev[]; explains: Record<string, Ev> }) {
  const list = [...findings].reverse().slice(0, 30);
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>Detections</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          <span className="demo" style={{ color: "var(--accent)" }}>filed</span> · <span style={{ color: "var(--pending)" }}>observed</span>
        </span>
      </div>
      <div className="panel-b">
        {list.length === 0 && <p className="empty">Nothing suspicious yet. Public testnet traffic is being scanned.</p>}
        <div className="feed">
          {list.map((f) => (
            <div key={f.id} title={explains[f.id]?.text ?? f.reason}>
              <span className="muted">{time(f.ts)}</span>
              <span className={f.scope === "filed" ? "demo" : "observed"}>
                {f.category} · {f.target}
              </span>
              <span className="muted">{f.sentinel}</span>
            </div>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
          On testnet the swarm only stakes on demo accounts. Patterns spotted elsewhere are shown as observed, never reported.
        </p>
      </div>
    </section>
  );
}

function Checker() {
  const [id, setId] = useState("");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/check/${encodeURIComponent(id.trim().toLowerCase())}`);
      setRes(await r.json());
    } catch {
      setRes({ error: "Could not reach the registry" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <div className="panel-h"><h2>Check before you pay</h2></div>
      <div className="panel-b">
        <form className="checker" onSubmit={run}>
          <input id="check-account" aria-label="Account to check" placeholder="account.testnet" value={id} onChange={(e) => setId(e.target.value)} />
          <button className="btn" type="submit" disabled={busy}>{busy ? "Checking…" : "Check"}</button>
        </form>
        {res && (
          <div className={`check-result ${res.error ? "bad" : res.safe ? "good" : "bad"}`}>
            {res.error
              ? res.error
              : res.safe
                ? `No confirmed threats on ${res.account_id}${res.pending_reports.length ? ` (open report #${res.pending_reports.join(", #")})` : ""}.`
                : `Do not pay ${res.account_id}: ${res.categories.join(", ")} · risk ${res.risk}/100 · report #${res.report_ids.join(", #")}`}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
          The same free view call any wallet or agent can make: <span className="mono">is_safe(account_id)</span>.
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
      <div className="panel-h"><h2>Immune memory</h2></div>
      <div className="panel-b">
        {entries.length === 0 ? (
          <p className="empty">No malicious code remembered yet. Once a scam contract is confirmed, its code is recognised instantly wherever it is deployed next.</p>
        ) : (
          <div className="memory">
            {entries.map(([h, r]) => (
              <div key={h}>
                <span>{h}</span>
                <span className="muted">report #{r}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
