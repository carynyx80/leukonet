/**
 * Attack simulator. Testnet has few real scams to catch on demand, so this
 * replays the patterns behind real ones using throwaway accounts that all
 * belong to the demo. No one outside the demo is ever involved.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, config, saveKey, loadKey, hasKey } from "../config.js";
import { Account, accountFor, accountFromKey, actions, balanceOf, call, near, newKeyPair, rpc, TGAS, transfer, view, serial } from "../near.js";
import { addDemoAccounts, readDemoState, writeDemoState } from "../swarm.js";
import type { Hub } from "../hub.js";
import { checkBeforePay, shouldBlock } from "../sdk/guard.js";

export const BAIT_WASM = path.join(ROOT, "contracts/bait/target/wasm32-unknown-unknown/release/leukonet_bait.wasm");

export type AttackKind = "drainer" | "key_hijack" | "malicious_contract" | "rogue_agent" | "lookalike";
export const ATTACKS: { kind: AttackKind; label: string; story: string }[] = [
  { kind: "drainer", label: "Wallet drainer", story: "Three wallets sign a fake approval and get swept to one account." },
  { kind: "key_hijack", label: "Key hijack", story: "A phished seed adds a new key, which empties the wallet." },
  { kind: "malicious_contract", label: "Airdrop scam contract", story: "A fake airdrop contract charges a 'verification fee'." },
  { kind: "rogue_agent", label: "Rogue AI agent", story: "A payroll agent is prompt-injected and wires funds out." },
  { kind: "lookalike", label: "Look-alike account", story: "Someone registers a name one character away from ours." },
];

const rand = () => Math.random().toString(36).slice(2, 7);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sub-accounts created by an attack, deleted afterwards so funds return to the master. */
const cleanup: { id: string; at: number }[] = [];

class Run {
  constructor(
    readonly kind: AttackKind,
    private hub?: Hub,
  ) {}
  stage(stage: string, detail?: string, hash?: string) {
    this.hub?.publish({ type: "attack", kind: this.kind, stage, detail, hash, ts: Date.now() });
    if (!this.hub) console.log(`[${this.kind}] ${stage}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Creates (and funds) a sub-account of the master, saving its key under .keys/sim-<label>.json */
async function subAccount(label: string, amount: bigint, keep = false): Promise<Account> {
  const master = accountFor("master");
  const id = `${label}.${master.accountId}`;
  const kp = newKeyPair();
  await serial(master.accountId, () =>
    master.signAndSendTransaction({
      receiverId: id,
      actions: [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(kp.getPublicKey())],
      waitUntil: "EXECUTED_OPTIMISTIC",
    } as any),
  );
  saveKey(`sim-${label}`, { accountId: id, privateKey: kp.toString() });
  addDemoAccounts(id);
  if (!keep) cleanup.push({ id: `sim-${label}`, at: Date.now() + 3 * 60_000 });
  return accountFromKey(id, kp.toString());
}

/** Waits for the swarm's verdict, then shows a guarded agent refusing to pay. */
async function awaitVerdictAndGuard(run: Run, target: string, timeoutMs = 75_000) {
  const t0 = Date.now();
  let announcedPending = false;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const check = await checkBeforePay(target, { registry: config.registry, rpcUrl: config.rpcUrl });
      if (!announcedPending && check.pending_reports.length) {
        announcedPending = true;
        run.stage("reported", `${target} has an open report; sentinels are voting`);
      }
      if (!check.safe) {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        run.stage("verdict", `${target} confirmed: ${check.categories.join(", ")} (risk ${check.risk}/100) after ${secs}s`);
        if (shouldBlock(check, {})) {
          run.stage("guard_blocked", `Guarded payment agent refused to send 0.05 NEAR to ${target}`);
        }
        return true;
      }
    } catch {
      /* registry hiccup, keep polling */
    }
    await sleep(1500);
  }
  run.stage("timeout", `No verdict on ${target} within ${timeoutMs / 1000}s`);
  return false;
}

async function drainer(run: Run) {
  const thief = await subAccount(`drainer-${rand()}`, near(0.01));
  run.stage("setup", `Attacker account ${thief.accountId} is ready`);
  const victims = await Promise.all([1, 2, 3].map(() => subAccount(`wallet-${rand()}`, near(0.1))));
  for (const v of victims) {
    const bal = (await balanceOf(v.accountId)) ?? near(0.1);
    const hash = await transfer(v, thief.accountId, (bal * 95n) / 100n);
    run.stage("attack", `${v.accountId} signed a fake approval and was swept`, hash);
    await sleep(1200);
  }
  return thief.accountId;
}

async function keyHijack(run: Run) {
  const thief = await subAccount(`thief-${rand()}`, near(0.01));
  const victim = await subAccount(`wallet-${rand()}`, near(0.12));
  run.stage("setup", `${victim.accountId} holds 0.12 NEAR`);
  const attackerKey = newKeyPair();
  const addHash = await serial(victim.accountId, async () => {
    const r: any = await victim.signAndSendTransaction({
      receiverId: victim.accountId,
      actions: [actions.addFullAccessKey(attackerKey.getPublicKey())],
      waitUntil: "EXECUTED_OPTIMISTIC",
    } as any);
    return r.transaction.hash;
  });
  run.stage("attack", `Phished seed phrase used to add an attacker key to ${victim.accountId}`, addHash);
  await sleep(2500);
  const asAttacker = accountFromKey(victim.accountId, attackerKey.toString());
  const bal = (await balanceOf(victim.accountId)) ?? near(0.12);
  const hash = await transfer(asAttacker, thief.accountId, (bal * 96n) / 100n);
  run.stage("attack", `The new key emptied ${victim.accountId} into ${thief.accountId}`, hash);
  return thief.accountId;
}

async function maliciousContract(run: Run, memory?: { knownBad: () => Map<string, number> }) {
  const code = new Uint8Array(fs.readFileSync(BAIT_WASM));
  const reuse = (memory?.knownBad().size ?? 0) > 0;
  const name = reuse ? `claim-rewards-${rand()}` : `free-airdrop-${rand()}`;
  const scam = await subAccount(name, near(0.05));
  const master = accountFor("master");
  const r: any = await serial(scam.accountId, () =>
    scam.signAndSendTransaction({
      receiverId: scam.accountId,
      actions: [actions.deployContract(code), actions.functionCall("new", new TextEncoder().encode(master.accountId), 10n * TGAS, 0n)],
      waitUntil: "EXECUTED_OPTIMISTIC",
    } as any),
  );
  run.stage(
    "attack",
    reuse
      ? `Same scam code redeployed under a new name: ${scam.accountId}`
      : `Fake airdrop contract deployed at ${scam.accountId}`,
    r.transaction.hash,
  );
  const victim = await subAccount(`wallet-${rand()}`, near(0.05));
  try {
    const res = await call(victim, scam.accountId, "claim_airdrop", {}, near(0.02), 20n * TGAS);
    run.stage("attack", `${victim.accountId} paid a 0.02 NEAR "verification fee"`, res.hash);
  } catch {
    /* the deploy is what the swarm catches; the claim is colour */
  }
  return scam.accountId;
}

async function rogueAgent(run: Run) {
  const agent = await subAccount(`payroll-agent-${rand()}`, near(0.45));
  const shops = await Promise.all([1, 2].map(() => subAccount(`shop-${rand()}`, near(0.01))));
  run.stage("setup", `${agent.accountId} pays suppliers 0.01 NEAR at a time`);
  for (let i = 0; i < 6; i++) {
    const hash = await transfer(agent, shops[i % 2].accountId, near(0.01));
    run.stage("baseline", `Routine payment ${i + 1}/6 to ${shops[i % 2].accountId}`, hash);
    await sleep(1300);
  }
  const exfil = await subAccount(`exfil-${rand()}`, near(0.01));
  const hash = await transfer(agent, exfil.accountId, near(0.3));
  run.stage("attack", `Prompt-injected agent wired 0.3 NEAR to ${exfil.accountId}`, hash);
  return agent.accountId;
}

/** Generates a name one character away from the protected one. */
function mutate(name: string): string {
  const [label, ...rest] = name.split(".");
  const swaps: Record<string, string[]> = { o: ["0"], i: ["1", "l"], l: ["1", "i"], e: ["3"], a: ["4"], s: ["5"], m: ["rn"], y: ["v"], u: ["v"], n: ["m"] };
  const spots = [...label].map((c, i) => [c, i] as const).filter(([c]) => swaps[c]);
  const [c, i] = spots[Math.floor(Math.random() * spots.length)];
  const sub = swaps[c][Math.floor(Math.random() * swaps[c].length)];
  return [label.slice(0, i) + sub + label.slice(i + 1), ...rest].join(".");
}

async function lookalike(run: Run) {
  const demo = readDemoState();
  const protectedName = demo.protected[0];
  if (!protectedName) throw new Error("No protected account. Run setup first.");
  const master = accountFor("master");
  for (let attempt = 0; attempt < 6; attempt++) {
    const fake = mutate(protectedName);
    if ((await balanceOf(fake)) !== null) continue;
    const kp = newKeyPair();
    const parent = fake.split(".").slice(1).join(".");
    const res = await call(
      master,
      parent,
      "create_account",
      { new_account_id: fake, new_public_key: kp.getPublicKey().toString() },
      near(0.01),
      30n * TGAS,
    );
    const label = `look-${fake.split(".")[0]}`;
    saveKey(`sim-${label}`, { accountId: fake, privateKey: kp.toString() });
    addDemoAccounts(fake);
    cleanup.push({ id: `sim-${label}`, at: Date.now() + 3 * 60_000 });
    run.stage("attack", `Registered ${fake}, imitating ${protectedName}`, res.hash);
    return fake;
  }
  throw new Error("Could not find a free look-alike name");
}

export async function runAttack(kind: AttackKind, hub?: Hub, memory?: { knownBad: () => Map<string, number> }) {
  const run = new Run(kind, hub);
  run.stage("start", ATTACKS.find((a) => a.kind === kind)?.story);
  try {
    const target =
      kind === "drainer"
        ? await drainer(run)
        : kind === "key_hijack"
          ? await keyHijack(run)
          : kind === "malicious_contract"
            ? await maliciousContract(run, memory)
            : kind === "rogue_agent"
              ? await rogueAgent(run)
              : await lookalike(run);
    run.stage("waiting", `Attack finished. Waiting for the swarm to catch ${target}`);
    await awaitVerdictAndGuard(run, target);
  } catch (e: any) {
    run.stage("error", String(e?.message ?? e).slice(0, 200));
  }
}

/** Deletes finished attack accounts, returning their NEAR to the master. */
export async function recycle(force = false) {
  const master = config.master || loadKey("master").accountId;
  const due = cleanup.filter((c) => force || c.at <= Date.now());
  for (const c of due) {
    cleanup.splice(cleanup.indexOf(c), 1);
    if (!hasKey(c.id)) continue;
    const key = loadKey(c.id);
    try {
      const acc = accountFromKey(key.accountId, key.privateKey);
      await serial(key.accountId, () => acc.deleteAccount(master));
      fs.rmSync(path.join(ROOT, ".keys", `${c.id}.json`), { force: true });
    } catch {
      /* already gone, or balance locked: leave it */
    }
  }
  return due.length;
}

/** Makes sure the protected look-alike target exists (a top-level name we own). */
export async function ensureProtectedName(): Promise<string> {
  const demo = readDemoState();
  if (demo.protected.length) return demo.protected[0];
  const master = accountFor("master");
  const base = master.accountId.split(".")[0].replace(/-[a-z0-9]+$/, "");
  const parent = config.network === "mainnet" ? "near" : "testnet";
  for (const candidate of [`${base}-pay`, `${base}-wallet`, `${base}-pay-${rand()}`]) {
    const id = `${candidate}.${parent}`;
    if ((await balanceOf(id)) !== null) continue;
    const kp = newKeyPair();
    await call(master, parent, "create_account", { new_account_id: id, new_public_key: kp.getPublicKey().toString() }, near(0.02), 30n * TGAS);
    saveKey("protected", { accountId: id, privateKey: kp.toString() });
    writeDemoState({ ...demo, protected: [id], accounts: [...demo.accounts, id] });
    return id;
  }
  throw new Error("Could not register a protected name");
}

void view;
void rpc;
