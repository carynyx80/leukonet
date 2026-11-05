/**
 * Trigger an attack against a running swarm:
 *   npm run attack -- drainer | key_hijack | malicious_contract | rogue_agent | lookalike
 * Uses the running server (npm start) when it is up, so the dashboard shows it.
 */
import { config } from "../config.js";
import { ATTACKS, runAttack, type AttackKind } from "./attacks.js";

const kind = process.argv[2] as AttackKind;
if (!ATTACKS.some((a) => a.kind === kind)) {
  console.log("Usage: npm run attack -- <kind>\n");
  for (const a of ATTACKS) console.log(`  ${a.kind.padEnd(19)} ${a.story}`);
  process.exit(1);
}
try {
  const res = await fetch(`http://localhost:${config.port}/api/attack/${kind}`, { method: "POST" });
  console.log(res.ok ? `Started ${kind}. Watch it on http://localhost:${config.port}` : (await res.json()).error);
} catch {
  console.log("Swarm server not running; running the attack standalone (start the server to see it caught).");
  await runAttack(kind);
}
