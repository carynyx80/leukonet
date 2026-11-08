/**
 * Run your own Leukonet sentinel, independent of the hosted swarm.
 *
 *   OPERATOR_ACCOUNT_ID=you.testnet OPERATOR_PRIVATE_KEY=ed25519:... npm run sentinel
 *
 * Your account locks a bond in the registry and then, for every open report,
 * re-checks the evidence on chain with your own thresholds and votes with stake.
 * Votes on the winning side earn a share of the losers' stake; wrong votes lose it.
 * Nothing here trusts the hosted swarm: evidence is re-read from the chain.
 *
 * Optional env:
 *   OPERATOR_PROFILE   neutrophil | macrophage | nk-cell | t-helper | b-cell (thresholds to use; default b-cell, the strictest)
 *   OPERATOR_BOND      NEAR to lock when registering (default: the registry minimum)
 *   LEUKONET_REGISTRY  registry contract (default: the hackathon registry)
 *   LEUKONET_PROTECTED comma-separated names the look-alike check protects (default: fetched from the hosted swarm, plus famous mainnet names)
 *   NEAR_RPC_URL       RPC endpoint (default FastNear testnet)
 */
import { config, loadKey, hasKey } from "../config.js";
import { accountFromKey, balanceOf, call, fmtNear, near, view } from "../near.js";
import { chainView } from "../chain.js";
import { Hub } from "../hub.js";
import { ImmuneMemory } from "../memory.js";
import { PERSONAS, Sentinel } from "../sentinel.js";
import { MAINNET_PROTECTED } from "../protected.js";
import { DEFAULT_REGISTRY } from "../mcp/server.js";

const registry = process.env.LEUKONET_REGISTRY || config.registry || DEFAULT_REGISTRY;
config.registry = registry;
const SWARM_API = process.env.LEUKONET_API ?? "https://swarm-production-38a8.up.railway.app";

function operatorKey() {
  if (process.env.OPERATOR_ACCOUNT_ID && process.env.OPERATOR_PRIVATE_KEY) {
    return { accountId: process.env.OPERATOR_ACCOUNT_ID, privateKey: process.env.OPERATOR_PRIVATE_KEY };
  }
  if (hasKey("operator")) return loadKey("operator");
  console.error("Set OPERATOR_ACCOUNT_ID and OPERATOR_PRIVATE_KEY (a funded testnet account), or save .keys/operator.json.");
  process.exit(1);
}

const key = operatorKey();
const account = accountFromKey(key.accountId, key.privateKey);
const profile = PERSONAS.find((p) => p.name === (process.env.OPERATOR_PROFILE ?? "b-cell")) ?? PERSONAS[PERSONAS.length - 1];
const persona = { ...profile, name: `operator:${profile.name}`, specialties: [], coordinator: false };

let protectedNames = [...MAINNET_PROTECTED, ...(process.env.LEUKONET_PROTECTED ?? "").split(",").filter(Boolean)];
if (!process.env.LEUKONET_PROTECTED) {
  try {
    const meta = (await (await fetch(`${SWARM_API}/api/state`)).json()).meta;
    protectedNames = [...protectedNames, ...(meta.protected ?? []), meta.master].filter(Boolean);
  } catch {
    console.warn("Could not fetch the demo's protected names; look-alike reports will only be checked against famous mainnet names.");
  }
}

const hub = new Hub();
hub.on("event", (e: any) => {
  if (e.type !== "chain") return;
  const what = e.action === "vote" ? `${e.support ? "confirmed" : "disputed"} report #${e.reportId}` : `${e.action} #${e.reportId ?? ""}`;
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${e.ok ? "✓" : "✗"} ${what}${e.hash ? ` · tx ${e.hash}` : ""}${e.error ? ` · ${e.error}` : ""}`);
});
const memory = new ImmuneMemory();
const sentinel = new Sentinel(persona, account, hub, chainView(), memory, () => protectedNames);

// Join the registry if needed.
const cfg = await view(registry, "get_config");
const sentinels: any[] = await view(registry, "get_sentinels");
const me = sentinels.find((s) => s.account_id === account.accountId);
const balance = await balanceOf(account.accountId);
if (balance === null) {
  console.error(`${account.accountId} does not exist on ${config.network}.`);
  process.exit(1);
}
if (!me) {
  const bond = process.env.OPERATOR_BOND ? near(process.env.OPERATOR_BOND) : BigInt(cfg.min_bond);
  if (balance < bond + BigInt(cfg.min_stake) * 5n) {
    console.error(`Need at least ${fmtNear(bond + BigInt(cfg.min_stake) * 5n, 2)} NEAR (bond + a few stakes); ${account.accountId} has ${fmtNear(balance, 2)}.`);
    process.exit(1);
  }
  await call(account, registry, "register_sentinel", {}, bond);
  console.log(`Registered ${account.accountId} as a sentinel with a ${fmtNear(bond, 2)} NEAR bond.`);
} else {
  console.log(`${account.accountId} is a sentinel: bond ${fmtNear(me.bond, 2)} NEAR, ${me.correct} right / ${me.wrong} wrong.`);
}
console.log(`Watching ${registry} with ${profile.name}'s thresholds. Ctrl+C to stop.`);

// Vote on every open report; learn scam code from confirmed contract reports.
const seen = new Set<number>();
async function tick() {
  try {
    // Newest first: from_index 0 is the latest report.
    const reports: any[] = await view(registry, "get_reports", { from_index: 0, limit: 30 });
    for (const r of reports) {
      if (r.status === "Confirmed" && r.category === "MaliciousContract" && !seen.has(r.id)) {
        try {
          const ev = JSON.parse(r.evidence);
          if (ev.codeHash) memory.remember(ev.codeHash, r.id);
        } catch {
          /* unreadable evidence */
        }
      }
      seen.add(r.id);
      if (r.status === "Open") await sentinel.consider(r);
    }
  } catch (e: any) {
    console.warn(`poll failed: ${e.message}`);
  }
  setTimeout(tick, 2000);
}
void tick();
