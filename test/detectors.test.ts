import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { editDistance, imitates, lookalikeDetector } from "../src/detectors/lookalike.js";
import { drainerDetector, keyHijackDetector } from "../src/detectors/sweep.js";
import { rogueAgentDetector } from "../src/detectors/rogue.js";
import { maliciousContractDetector, wasmExports } from "../src/detectors/contract.js";
import { DEFAULT_THRESHOLDS as T, type ChainView } from "../src/detectors/types.js";
import type { Tx, TxAction } from "../src/stream.js";
import { near } from "../src/near.js";

const chain = (balances: Record<string, bigint> = {}, methods: Record<string, string[]> = {}): ChainView => ({
  balance: async (id) => balances[id] ?? null,
  contractMethods: async (id) => methods[id] ?? null,
});

let n = 0;
const tx = (signer: string, receiver: string, actions: TxAction[], extra: Partial<Tx> = {}): Tx => ({
  hash: `h${++n}`,
  signer,
  receiver,
  publicKey: "ed25519:main",
  actions,
  height: 1000 + n,
  timestampMs: 0,
  ...extra,
});
const pay = (amount: bigint): TxAction => ({ kind: "Transfer", deposit: amount });

test("edit distance handles swaps and substitutions", () => {
  assert.equal(editDistance("leukonet", "leukonet"), 0);
  assert.equal(editDistance("leukonet", "luekonet"), 1);
  assert.equal(editDistance("leukonet", "leukonat"), 1);
});

test("look-alikes: homoglyphs and near-misses, but not the real name or unrelated names", () => {
  const protectedNames = ["leukonet-pay.testnet", "ref-finance.near"];
  assert.equal(imitates("leuk0net-pay.testnet", protectedNames, 2), "leukonet-pay.testnet");
  assert.equal(imitates("1eukonet-pay.testnet", protectedNames, 2), "leukonet-pay.testnet");
  assert.equal(imitates("ref-flnance.near", protectedNames, 2), "ref-finance.near");
  assert.equal(imitates("leukonet-pay.testnet", protectedNames, 2), null);
  assert.equal(imitates("weather-app.testnet", protectedNames, 2), null);
  // a different parent is a different namespace
  assert.equal(imitates("leuk0net-pay.near", protectedNames, 2), null);
});

test("look-alike detector fires on account creation through the registrar", async () => {
  const d = lookalikeDetector(() => ["leukonet-pay.testnet"], T);
  const f = await d.inspect(
    tx("someone.testnet", "testnet", [{ kind: "FunctionCall", method: "create_account", args: { new_account_id: "leukonet-pey.testnet" } }]),
    chain(),
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].target, "leukonet-pey.testnet");
  assert.equal(f[0].category, "Lookalike");
});

test("drainer needs three different swept victims", async () => {
  const d = drainerDetector(T);
  const c = chain();
  for (const v of ["a.testnet", "b.testnet"]) {
    assert.deepEqual(await d.inspect(tx(v, "thief.testnet", [pay(near(0.95))], { signerBalanceAfter: near(0.05) }), c), []);
  }
  // a small payment from a third account is not a sweep
  assert.deepEqual(await d.inspect(tx("c.testnet", "thief.testnet", [pay(near(0.1))], { signerBalanceAfter: near(5) }), c), []);
  const f = await d.inspect(tx("d.testnet", "thief.testnet", [pay(near(0.9))], { signerBalanceAfter: near(0.01) }), c);
  assert.equal(f.length, 1);
  assert.equal(f[0].category, "Drainer");
  assert.deepEqual(f[0].evidence.victims, ["a.testnet", "b.testnet", "d.testnet"]);
});

test("key hijack: sweep signed by a freshly added full-access key", async () => {
  const d = keyHijackDetector(T);
  const c = chain();
  await d.inspect(tx("victim.testnet", "victim.testnet", [{ kind: "AddKey", publicKey: "ed25519:evil", fullAccess: true }]), c);
  // the old key moving money is fine
  assert.deepEqual(await d.inspect(tx("victim.testnet", "shop.testnet", [pay(near(0.9))], { signerBalanceAfter: near(0.05) }), c), []);
  const f = await d.inspect(
    tx("victim.testnet", "thief.testnet", [pay(near(0.9))], { publicKey: "ed25519:evil", signerBalanceAfter: near(0.02) }),
    c,
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].target, "thief.testnet");
  assert.equal(f[0].category, "KeyHijack");
});

test("rogue agent: a spike to a new payee after a steady history, not a big payment to a known payee", async () => {
  const d = rogueAgentDetector(T);
  const c = chain();
  for (let i = 0; i < 5; i++) await d.inspect(tx("agent.testnet", `shop${i % 2}.testnet`, [pay(near(0.01))]), c);
  assert.deepEqual(await d.inspect(tx("agent.testnet", "shop0.testnet", [pay(near(0.5))]), c), []);
  const f = await d.inspect(tx("agent.testnet", "exfil.testnet", [pay(near(0.3))]), c);
  assert.equal(f.length, 1);
  assert.equal(f[0].target, "agent.testnet");
});

test("bait contract exports lure methods, and immune memory recognises known code", async () => {
  const wasm = path.resolve("contracts/bait/target/wasm32-unknown-unknown/release/leukonet_bait.wasm");
  if (fs.existsSync(wasm)) {
    assert.deepEqual(wasmExports(fs.readFileSync(wasm)).sort(), ["claim_airdrop", "new", "verify_wallet"]);
  }
  const memory = new Map<string, number>([["KNOWNHASH", 7]]);
  const d = maliciousContractDetector({ knownBad: () => memory });
  const known = await d.inspect(tx("x.testnet", "x.testnet", [{ kind: "DeployContract", codeHash: "KNOWNHASH" }]), chain());
  assert.equal(known[0].detector, "immune_memory");
  assert.equal(known[0].severity, 9);
  const fresh = await d.inspect(
    tx("y.testnet", "y.testnet", [{ kind: "DeployContract", codeHash: "NEW" }]),
    chain({}, { "y.testnet": ["new", "claim_airdrop"] }),
  );
  assert.equal(fresh[0].detector, "malicious_contract");
  const benign = await d.inspect(
    tx("z.testnet", "z.testnet", [{ kind: "DeployContract", codeHash: "OK" }]),
    chain({}, { "z.testnet": ["new", "ft_transfer"] }),
  );
  assert.deepEqual(benign, []);
});
