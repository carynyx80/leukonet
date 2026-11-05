/**
 * A payment agent that checks Leukonet before every payment.
 *
 *   npm run example:guarded-agent -- <payee> [<payee> ...]
 *
 * With no arguments it tries a safe supplier and the most recent account the
 * swarm confirmed as a threat. Payments go from the demo's steady agent, in
 * tiny amounts, on testnet.
 */
import { config, hasKey, loadKey, requireDeployed } from "../src/config.js";
import { accountFromKey, near, transfer, view } from "../src/near.js";
import { LeukonetBlocked, guarded } from "../src/sdk/guard.js";

requireDeployed();
if (!hasKey("sim-steady-agent")) {
  console.log('Run "npm start" once first so the demo agent exists.');
  process.exit(1);
}
const key = loadKey("sim-steady-agent");
const agent = accountFromKey(key.accountId, key.privateKey);

let payees = process.argv.slice(2);
if (payees.length === 0) {
  const verdicts: any[] = await view(config.registry, "get_verdicts", { from_index: 0, limit: 100 });
  const supplier = hasKey("sim-supplier-a") ? loadKey("sim-supplier-a").accountId : config.master;
  payees = [supplier, ...(verdicts.length ? [verdicts[verdicts.length - 1].account_id] : [])];
}

for (const payee of payees) {
  try {
    const hash = await guarded(payee, { registry: config.registry, rpcUrl: config.rpcUrl }, () => transfer(agent, payee, near(0.001)));
    console.log(`✓ paid ${payee} 0.001 NEAR  ${config.explorer}/txns/${hash}`);
  } catch (e) {
    if (e instanceof LeukonetBlocked) console.log(`✗ ${e.message}`);
    else console.log(`! could not pay ${payee}: ${(e as Error).message}`);
  }
}
