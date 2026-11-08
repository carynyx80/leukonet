/**
 * Leukonet: runs the sentinel swarm and serves the live threat map.
 *   npm start     -> http://localhost:8787
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, config, hasKey, requireDeployed } from "./config.js";
import { accountFor, balanceOf, fmtNear, near, transfer } from "./near.js";
import { Hub } from "./hub.js";
import { Swarm, readDemoState } from "./swarm.js";
import { PERSONAS, Sentinel } from "./sentinel.js";
import { chainView } from "./chain.js";
import { ATTACKS, runAttack, recycle, type AttackKind } from "./sim/attacks.js";
import { startNormalTraffic } from "./sim/traffic.js";
import { checkBeforePay } from "./sdk/guard.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLeukonetMcp } from "./mcp/server.js";

requireDeployed();
const hub = new Hub();
const chain = chainView();

const swarm = new Swarm(hub, { network: config.network, readOnly: false, rpcUrl: config.rpcUrl, dataUrl: config.dataUrl });
for (const p of PERSONAS) {
  if (!hasKey(`sentinel-${p.name}`)) {
    hub.log(`sentinel ${p.name} has no key; run "npm run setup"`, "warn");
    continue;
  }
  swarm.sentinels.push(
    new Sentinel(p, accountFor(`sentinel-${p.name}`), hub, chain, swarm.memory, () => [
      ...readDemoState().protected,
      config.master,
    ]),
  );
}
await swarm.start();

if (process.env.WATCH_MAINNET === "1") {
  const watcher = new Swarm(hub, { network: "mainnet", readOnly: true, rpcUrl: config.mainnetRpcUrl, dataUrl: config.mainnetDataUrl });
  await watcher.start();
}

if (config.normalTraffic) startNormalTraffic(hub);

// ----- funds watchdog -----------------------------------------------------------
// Every report and vote stakes testnet NEAR. Agents running low are refilled from
// the master account; simulations pause before the master gets too low to finish one.
const FUNDS = { attackFloor: near(0.6), sentinelLow: near(0.12), refill: near(0.3), masterReserve: near(1) };
const funds: { master: string | null; sentinels: Record<string, string>; low: boolean; checkedAt: number } = { master: null, sentinels: {}, low: false, checkedAt: 0 };
async function checkFunds() {
  const master = await balanceOf(config.master);
  if (master === null) return;
  funds.master = master.toString();
  funds.low = master < FUNDS.attackFloor;
  for (const s of swarm.sentinels) {
    const bal = await balanceOf(s.id);
    if (bal === null) continue;
    funds.sentinels[s.persona.name] = bal.toString();
    if (bal < FUNDS.sentinelLow && master > FUNDS.masterReserve) {
      try {
        await transfer(accountFor("master"), s.id, FUNDS.refill);
        hub.log(`funds: topped ${s.persona.name} up with ${fmtNear(FUNDS.refill, 2)} NEAR`);
      } catch (e: any) {
        hub.log(`funds: could not top up ${s.persona.name}: ${e.message}`, "warn");
      }
    }
  }
  funds.checkedAt = Date.now();
  if (funds.low) hub.log(`funds: master has ${fmtNear(master, 2)} NEAR; simulations are paused until it is refilled`, "warn");
}
void checkFunds();
setInterval(() => void checkFunds().catch(() => undefined), 60_000);
setInterval(() => void recycle().catch(() => undefined), 60_000);

// ----- HTTP ------------------------------------------------------------------

let attackRunning: string | null = null;
const WEB = path.join(ROOT, "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

// ----- browser watchers ---------------------------------------------------------
// Every open dashboard streams the chain itself and can send tips. Tips are
// re-verified on chain by a sentinel before anything is filed (see Swarm.tip).

let watchers = 0;
let tipsReceived = 0;
let tipsVerified = 0;
const announceWatchers = () => hub.publish({ type: "watchers", count: watchers, tips: tipsReceived, verified: tipsVerified });
const tipBudget = new Map<string, { n: number; reset: number }>();
const DETECTORS = new Set(["drainer", "key_hijack", "malicious_contract", "immune_memory", "rogue_agent", "lookalike"]);
const CATEGORIES = new Set(["Drainer", "KeyHijack", "MaliciousContract", "RogueAgent", "Lookalike"]);
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function readBody(req: http.IncomingMessage, limit = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Shape-checks a tip; returns a clean finding or a reason it was refused. */
function parseTip(raw: any): { finding?: any; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "Expected a JSON object." };
  const { detector, category, target, severity, reason, evidence } = raw;
  if (!DETECTORS.has(detector)) return { error: "Unknown detector." };
  if (!CATEGORIES.has(category)) return { error: "Unknown category." };
  if (typeof target !== "string" || target.length < 2 || target.length > 64 || !ACCOUNT.test(target)) return { error: "Bad account id." };
  if (!Number.isInteger(severity) || severity < 1 || severity > 10) return { error: "Severity must be 1-10." };
  if (typeof reason !== "string" || reason.length > 400) return { error: "Reason missing or too long." };
  if (!evidence || typeof evidence !== "object" || JSON.stringify(evidence).length > 2000) return { error: "Evidence missing or too large." };
  if (!Array.isArray(evidence.txs) || !evidence.txs.every((h: unknown) => typeof h === "string" && /^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(h))) {
    return { error: "Evidence needs transaction hashes." };
  }
  return { finding: { detector, category, target, severity, reason, evidence } };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    return res.end();
  }
  try {
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = (name: string, data: unknown) =>
        res.write(`event: ${name}\ndata: ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
      const onEvent = (e: unknown) => send("hub", e);
      const onState = (s: unknown) => send("state", s);
      hub.on("event", onEvent);
      hub.on("state", onState);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      watchers++;
      announceWatchers();
      req.on("close", () => {
        hub.off("event", onEvent);
        hub.off("state", onState);
        clearInterval(ping);
        watchers = Math.max(0, watchers - 1);
        announceWatchers();
      });
      return;
    }
    if (url.pathname === "/api/state") {
      return json(res, 200, {
        ...hub.snapshot(),
        meta: {
          registry: config.registry,
          master: config.master,
          network: config.network,
          explorer: config.explorer,
          demoControls: config.demoControls,
          attackRunning,
          attacks: ATTACKS,
          protected: readDemoState().protected,
          memory: Object.fromEntries(swarm.memory.knownBad()),
          personas: PERSONAS.map((p) => ({ name: p.name, role: p.role, specialties: p.specialties, coordinator: !!p.coordinator })),
          sentinelAccounts: Object.fromEntries(swarm.sentinels.map((s) => [s.persona.name, s.id])),
          nearAi: !!config.nearAiKey,
          watchMainnet: process.env.WATCH_MAINNET === "1",
          watchers: { count: watchers, tips: tipsReceived, verified: tipsVerified },
          dataUrl: config.dataUrl,
          rpcUrl: config.rpcUrl,
          funds,
        },
      });
    }
    // MCP for AI agents: stateless streamable HTTP, a fresh server per request.
    if (url.pathname === "/mcp") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST (stateless MCP server)." }, id: null }));
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, 64_000));
      } catch {
        return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      }
      const mcp = createLeukonetMcp({ registry: config.registry, rpcUrl: config.rpcUrl, explorer: config.explorer });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    const check = url.pathname.match(/^\/api\/check\/([a-z0-9._-]+)$/);
    if (check) {
      return json(res, 200, await checkBeforePay(check[1], { registry: config.registry, rpcUrl: config.rpcUrl }));
    }
    if (url.pathname === "/api/tip" && req.method === "POST") {
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
      const b = tipBudget.get(ip) ?? { n: 0, reset: Date.now() + 60_000 };
      if (Date.now() > b.reset) Object.assign(b, { n: 0, reset: Date.now() + 60_000 });
      if (++b.n > 20) return json(res, 429, { accepted: false, reason: "Too many tips from this browser. Try again in a minute." });
      tipBudget.set(ip, b);
      let raw: any;
      try {
        raw = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { accepted: false, reason: "Body must be JSON under 8 KB." });
      }
      const { finding, error } = parseTip(raw);
      if (!finding) return json(res, 400, { accepted: false, reason: error });
      tipsReceived++;
      const result = await swarm.tip(finding);
      if (result.accepted) tipsVerified++;
      announceWatchers();
      return json(res, 200, result);
    }
    const attack = url.pathname.match(/^\/api\/attack\/([a-z_]+)$/);
    if (attack && req.method === "POST") {
      if (!config.demoControls) return json(res, 403, { error: "Demo controls are off on this server." });
      const kind = attack[1] as AttackKind;
      if (!ATTACKS.some((a) => a.kind === kind)) return json(res, 404, { error: "Unknown attack" });
      if (funds.low) {
        return json(res, 503, { error: "The demo wallet is out of testnet NEAR, so new simulations are paused. Everything else still works." });
      }
      if (attackRunning) return json(res, 409, { error: `An attack is already running (${attackRunning}). Try again when it finishes.` });
      attackRunning = kind;
      void runAttack(kind, hub, swarm.memory).finally(() => {
        attackRunning = null;
        hub.publish({ type: "attack", kind, stage: "done", ts: Date.now() });
      });
      return json(res, 202, { started: kind });
    }

    // Static dashboard
    let file = path.join(WEB, decodeURIComponent(url.pathname));
    if (!file.startsWith(WEB)) return json(res, 400, { error: "bad path" });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end('Dashboard not built. Run "npm run build:web", or use "npm run dev:web" during development.');
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e: any) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

server.listen(config.port, "0.0.0.0", () => hub.log(`Leukonet threat map on http://localhost:${config.port}`));
