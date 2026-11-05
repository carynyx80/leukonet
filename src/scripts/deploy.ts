/**
 * Deploys the registry to registry.<master> and initialises it.
 *   npm run deploy            (fresh deploy)
 *   npm run deploy -- --code  (redeploy code only, keeps state)
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, config, loadKey, saveKey } from "../config.js";
import { accountFor, accountFromKey, actions, near, newKeyPair, TGAS } from "../near.js";

export const REGISTRY_WASM = path.join(ROOT, "contracts/registry/target/wasm32-unknown-unknown/release/leukonet_registry.wasm");

export async function deployRegistry(codeOnly = false): Promise<string> {
  const master = accountFor("master");
  const registryId = `registry.${master.accountId}`;
  const code = fs.readFileSync(REGISTRY_WASM);

  if (codeOnly) {
    const key = loadKey("registry");
    const reg = accountFromKey(key.accountId, key.privateKey);
    await reg.deployContract(new Uint8Array(code));
    console.log(`Redeployed code to ${registryId}`);
    return registryId;
  }

  const kp = newKeyPair();
  // Storage for ~240 KB of code plus room for reports.
  await master.signAndSendTransaction({
    receiverId: registryId,
    actions: [
      actions.createAccount(),
      actions.transfer(near(2.8)),
      actions.addFullAccessKey(kp.getPublicKey()),
      actions.deployContract(new Uint8Array(code)),
      actions.functionCall(
        "new",
        {
          owner: master.accountId,
          config: {
            min_bond: near(0.2).toString(),
            min_stake: near(0.02).toString(),
            quorum: 3,
            window_ns: 20_000_000_000,
            confirm_pct: 66,
          },
        },
        30n * TGAS,
        0n,
      ),
    ],
    waitUntil: "EXECUTED_OPTIMISTIC",
  } as any);
  saveKey("registry", { accountId: registryId, privateKey: kp.toString() });
  console.log(`Deployed registry at ${registryId}`);
  return registryId;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  deployRegistry(process.argv.includes("--code")).catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
void config;
