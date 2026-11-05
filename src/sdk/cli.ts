/**
 * Check any account against the Leukonet registry:
 *   npm run check -- some-account.testnet
 */
import { config } from "../config.js";
import { checkBeforePay } from "./guard.js";

const id = process.argv[2];
if (!id) {
  console.log("Usage: npm run check -- <account-id>");
  process.exit(1);
}
const r = await checkBeforePay(id, { registry: config.registry, rpcUrl: config.rpcUrl });
console.log(r.safe ? `✓ ${id}: no confirmed threats (risk ${r.risk}/100)` : `✗ ${id}: ${r.categories.join(", ")} (risk ${r.risk}/100, reports ${r.report_ids.join(", ")})`);
if (r.pending_reports.length) console.log(`  open reports still being voted on: ${r.pending_reports.join(", ")}`);
