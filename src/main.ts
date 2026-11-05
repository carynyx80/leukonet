/**
 * Leukonet: runs the sentinel swarm and serves the live threat map.
 *   npm start     -> http://localhost:8787
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, config, hasKey, requireDeployed } from "./config.js";
import { accountFor } from "./near.js";
import { Hub } from "./hub.js";
import { Swarm, readDemoState } from "./swarm.js";
import { PERSONAS, Sentinel } from "./sentinel.js";
import { chainView } from "./chain.js";
import { ATTACKS, runAttack, recycle, type AttackKind } from "./sim/attacks.js";
import { startNormalTraffic } from "./sim/traffic.js";
import { checkBeforePay } from "./sdk/guard.js";

requireDeployed();
const hub = new Hub();
const chain = chainView();

const swarm = new Swarm(hub, { network: "testnet", readOnly: false, rpcUrl: config.rpcUrl, dataUrl: config.dataUrl });
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

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
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
      req.on("close", () => {
        hub.off("event", onEvent);
        hub.off("state", onState);
        clearInterval(ping);
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
        },
      });
    }
    const check = url.pathname.match(/^\/api\/check\/([a-z0-9._-]+)$/);
    if (check) {
      return json(res, 200, await checkBeforePay(check[1], { registry: config.registry, rpcUrl: config.rpcUrl }));
    }
    const attack = url.pathname.match(/^\/api\/attack\/([a-z_]+)$/);
    if (attack && req.method === "POST") {
      if (!config.demoControls) return json(res, 403, { error: "Demo controls are off on this server." });
      const kind = attack[1] as AttackKind;
      if (!ATTACKS.some((a) => a.kind === kind)) return json(res, 404, { error: "Unknown attack" });
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

server.listen(config.port, () => hub.log(`Leukonet threat map on http://localhost:${config.port}`));
