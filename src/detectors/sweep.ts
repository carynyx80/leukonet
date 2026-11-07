import type { Tx } from "../blocks.js";
import { fmtNear } from "../units.js";
import type { ChainView, Detector, Finding, Thresholds } from "./types.js";

interface Sweep {
  tx: string;
  from: string;
  to: string;
  amount: bigint;
  remaining: bigint;
  height: number;
  publicKey: string;
}

/** A transfer that takes at least `share` of the sender's balance. */
async function asSweep(tx: Tx, chain: ChainView, share: number): Promise<Sweep | null> {
  if (tx.signer === tx.receiver) return null;
  const amount = tx.actions.reduce((s, a) => s + (a.kind === "Transfer" ? a.deposit ?? 0n : 0n), 0n);
  // Below 0.01 NEAR nothing worth stealing moved; skip without any lookup.
  if (amount < 10n ** 22n) return null;
  // The transfer is debited when the transaction is processed; neardata gives us that balance directly.
  const remaining = tx.signerBalanceAfter ?? (await chain.balance(tx.signer));
  if (remaining === null) return null;
  const total = amount + remaining;
  if (Number((amount * 1000n) / total) / 1000 < share) return null;
  return { tx: tx.hash, from: tx.signer, to: tx.receiver, amount, remaining, height: tx.height, publicKey: tx.publicKey };
}

/**
 * Key hijack: a new full-access key is added to an account and that same key
 * then moves most of the balance to someone else.
 */
export function keyHijackDetector(t: Thresholds): Detector {
  const recentKeys = new Map<string, { key: string; height: number; tx: string }[]>();

  return {
    name: "key_hijack",
    async inspect(tx, chain) {
      for (const a of tx.actions) {
        if (a.kind === "AddKey" && a.fullAccess && a.publicKey && tx.signer === tx.receiver) {
          const list = recentKeys.get(tx.receiver) ?? [];
          list.push({ key: a.publicKey, height: tx.height, tx: tx.hash });
          recentKeys.set(tx.receiver, list.filter((k) => tx.height - k.height <= t.hijackWindow));
        }
      }
      const added = recentKeys.get(tx.signer)?.find((k) => k.key === tx.publicKey && tx.height - k.height <= t.hijackWindow);
      if (!added || !tx.actions.some((a) => a.kind === "Transfer")) return [];
      // Fresh keys used once at account creation are normal: require the key to be added after the account existed.
      if (added.tx === tx.hash) return [];
      const sweep = await asSweep(tx, chain, t.sweepShare);
      if (!sweep) return [];
      recentKeys.delete(tx.signer);
      const f: Finding = {
        target: sweep.to,
        category: "KeyHijack",
        severity: 9,
        reason: `${sweep.to} received ${fmtNear(sweep.amount)} NEAR swept from ${sweep.from} with a key added ${tx.height - added.height} blocks earlier`,
        evidence: {
          txs: [added.tx, sweep.tx],
          height: tx.height,
          victim: sweep.from,
          newKey: added.key,
          amount: sweep.amount.toString(),
          remaining: sweep.remaining.toString(),
          blocksAfterKey: tx.height - added.height,
        },
        detector: "key_hijack",
      };
      return [f];
    },
    async verify(f, chain) {
      const e = f.evidence;
      if (!e?.txs?.length || e.blocksAfterKey > t.hijackWindow) return false;
      const share = Number(BigInt(e.amount)) / (Number(BigInt(e.amount)) + Number(BigInt(e.remaining)));
      if (share < t.sweepShare) return false;
      return chain.txMatches(e.txs[1], e.victim, f.target);
    },
  };
}

/** Drainer: one account receives full-balance sweeps from several different victims. */
export function drainerDetector(t: Thresholds, windowBlocks = 600): Detector {
  const swept = new Map<string, Sweep[]>();
  const reported = new Set<string>();

  return {
    name: "drainer",
    async inspect(tx, chain) {
      if (reported.has(tx.receiver)) return [];
      const sweep = await asSweep(tx, chain, t.sweepShare);
      if (!sweep) return [];
      const list = (swept.get(sweep.to) ?? []).filter((s) => sweep.height - s.height <= windowBlocks && s.from !== sweep.from);
      list.push(sweep);
      swept.set(sweep.to, list);
      if (list.length < t.drainerVictims) return [];
      reported.add(sweep.to);
      const total = list.reduce((s, x) => s + x.amount, 0n);
      const f: Finding = {
        target: sweep.to,
        category: "Drainer",
        severity: 9,
        reason: `${sweep.to} swept ${fmtNear(total)} NEAR from ${list.length} accounts within ${sweep.height - list[0].height} blocks`,
        evidence: {
          txs: list.map((s) => s.tx),
          height: tx.height,
          victims: list.map((s) => s.from),
          shares: list.map((s) => Number((s.amount * 1000n) / (s.amount + s.remaining)) / 1000),
          total: total.toString(),
        },
        detector: "drainer",
      };
      return [f];
    },
    async verify(f, chain) {
      const e = f.evidence;
      if (!Array.isArray(e?.victims) || new Set(e.victims).size < t.drainerVictims) return false;
      if (!e.shares.every((s: number) => s >= t.sweepShare)) return false;
      const checks = await Promise.all(e.txs.map((h: string, i: number) => chain.txMatches(h, e.victims[i], f.target)));
      return checks.every(Boolean);
    },
  };
}
