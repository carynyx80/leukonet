/**
 * One-command setup on NEAR testnet (free):
 *   1. creates a funded master account through the testnet faucet
 *   2. builds and deploys the registry contract
 *   3. creates five sentinel accounts and registers them with a bond
 *   4. registers a protected name for the look-alike demo
 *   5. writes .env
 * Safe to run again: finished steps are skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { ROOT, config, hasKey, loadKey, saveKey } from "../config.js";
import { accountFor, actions, balanceOf, call, fmtNear, near, newKeyPair, serial, view } from "../near.js";
import { PERSONAS } from "../sentinel.js";
import { REGISTRY_WASM, deployRegistry } from "./deploy.js";
import { BAIT_WASM, ensureProtectedName } from "../sim/attacks.js";

const step = (s: string) => console.log(`\n▸ ${s}`);

async function faucetAccount(): Promise<string> {
  const kp = newKeyPair();
  const id = `leukonet-${Date.now().toString(36)}.testnet`;
  const res = await fetch("https://helper.testnet.near.org/account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`Faucet refused (${res.status}): ${(await res.text()).slice(0, 200)}`);
  saveKey("master", { accountId: id, privateKey: kp.toString() });
  return id;
}

function writeEnv(values: Record<string, string>) {
  const file = path.join(ROOT, ".env");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(file, lines.filter((l, i) => l || i < lines.length - 1).join("\n") + "\n");
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  Object.assign(config, { master: values.LEUKONET_MASTER ?? config.master, registry: values.LEUKONET_REGISTRY ?? config.registry });
}

async function main() {
  if (config.network !== "testnet") throw new Error("Setup only runs on testnet.");

  step("Master account");
  const masterId = hasKey("master") ? loadKey("master").accountId : await faucetAccount();
  console.log(`  ${masterId} (${fmtNear((await balanceOf(masterId)) ?? 0n)} NEAR)`);
  writeEnv({ LEUKONET_MASTER: masterId });

  step("Contracts");
  if (!fs.existsSync(REGISTRY_WASM) || !fs.existsSync(BAIT_WASM) || process.argv.includes("--build")) {
    console.log("  building wasm with cargo (a minute the first time)…");
    execSync("rustup target add wasm32-unknown-unknown", { stdio: "ignore" });
    execSync("cargo build --target wasm32-unknown-unknown --release", {
      cwd: path.join(ROOT, "contracts/registry"),
      stdio: "inherit",
      env: { ...process.env, RUSTFLAGS: "--cfg near -C link-arg=-s" },
    });
    execSync("cargo build --target wasm32-unknown-unknown --release", { cwd: path.join(ROOT, "contracts/bait"), stdio: "inherit" });
  }
  const registryId = `registry.${masterId}`;
  if ((await balanceOf(registryId)) === null) await deployRegistry();
  console.log(`  registry: ${registryId}`);
  writeEnv({ LEUKONET_REGISTRY: registryId });

  step("Sentinels");
  const master = accountFor("master");
  const registered = new Set(((await view(registryId, "get_sentinels")) as any[]).map((s) => s.account_id));
  for (const p of PERSONAS) {
    const id = `${p.name}.${masterId}`;
    if (!hasKey(`sentinel-${p.name}`) || (await balanceOf(id)) === null) {
      const kp = newKeyPair();
      await serial(master.accountId, () =>
        master.signAndSendTransaction({
          receiverId: id,
          actions: [actions.createAccount(), actions.transfer(near(0.45)), actions.addFullAccessKey(kp.getPublicKey())],
          waitUntil: "EXECUTED_OPTIMISTIC",
        } as any),
      );
      saveKey(`sentinel-${p.name}`, { accountId: id, privateKey: kp.toString() });
    }
    if (!registered.has(id)) {
      await call(accountFor(`sentinel-${p.name}`), registryId, "register_sentinel", {}, near(0.2));
    }
    console.log(`  ${p.name.padEnd(11)} ${id}  — ${p.role}`);
  }

  step("Protected name for the look-alike demo");
  console.log(`  ${await ensureProtectedName()}`);

  console.log(`\n✓ Ready. Master balance: ${fmtNear((await balanceOf(masterId)) ?? 0n)} NEAR`);
  console.log("  Next: npm start   (then open http://localhost:8787)");
}

main().catch((e) => {
  console.error(`\n✗ ${e.message ?? e}`);
  process.exit(1);
});
