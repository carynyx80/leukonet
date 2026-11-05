/**
 * Normal background traffic: a steady payroll agent paying two suppliers.
 * It keeps the threat map alive and gives the rogue-agent detector a baseline
 * of honest behaviour that must NOT be flagged.
 */
import { hasKey, loadKey, saveKey } from "../config.js";
import { accountFor, accountFromKey, actions, balanceOf, near, newKeyPair, serial, transfer } from "../near.js";
import { addDemoAccounts } from "../swarm.js";
import type { Hub } from "../hub.js";

async function ensure(label: string, amount: bigint) {
  const name = `sim-${label}`;
  if (hasKey(name)) {
    const k = loadKey(name);
    if ((await balanceOf(k.accountId)) !== null) return accountFromKey(k.accountId, k.privateKey);
  }
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
  saveKey(name, { accountId: id, privateKey: kp.toString() });
  addDemoAccounts(id);
  return accountFromKey(id, kp.toString());
}

export async function startNormalTraffic(hub: Hub, everyMs = 20_000) {
  try {
    const agent = await ensure("steady-agent", near(0.3));
    const shops = [await ensure("supplier-a", near(0.01)), await ensure("supplier-b", near(0.01))];
    hub.log(`normal traffic: ${agent.accountId} pays suppliers every ${everyMs / 1000}s`);
    let i = 0;
    const tick = async () => {
      try {
        const bal = (await balanceOf(agent.accountId)) ?? 0n;
        if (bal > near(0.02)) {
          await transfer(agent, shops[i++ % 2].accountId, near(0.002));
        } else {
          // Suppliers send it back so the loop costs nothing but gas.
          for (const s of shops) {
            const b = (await balanceOf(s.accountId)) ?? 0n;
            if (b > near(0.012)) await transfer(s, agent.accountId, b - near(0.01));
          }
        }
      } catch (e: any) {
        hub.log(`normal traffic paused: ${e.message}`, "warn");
      }
      setTimeout(tick, everyMs);
    };
    setTimeout(tick, 2000);
  } catch (e: any) {
    hub.log(`normal traffic disabled: ${e.message}`, "warn");
  }
}
