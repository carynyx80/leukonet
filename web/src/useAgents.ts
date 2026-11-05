import { useEffect, useRef, useState } from "react";
import type { Ev } from "./useSwarm";

export type Mood = "watching" | "alert" | "staking" | "checking" | "closing";

export interface AgentMind {
  mood: Mood;
  thought: string;
  at: number;
  /** Transactions this agent has looked at since the page opened. */
  seen: number;
  /** Recent actions, newest first. */
  log: { text: string; at: number; tone: "info" | "alert" | "good" | "bad" }[];
}

const shortId = (id: string) => (id.length > 30 ? `${id.slice(0, 16)}…${id.slice(-11)}` : id);
const n = (x: number) => x.toLocaleString();

/** Which agent looks at which kind of transaction (mirrors the map). */
const RESPONSIBLE: Record<string, string[]> = {
  Transfer: ["neutrophil", "nk-cell"],
  AddKey: ["neutrophil"],
  DeployContract: ["macrophage"],
  CreateAccount: ["t-helper"],
};

/**
 * Turns the raw event stream into what each agent is doing and "thinking",
 * in plain English. Idle agents narrate what they are scanning; an action
 * (spotting, staking, voting) holds the spotlight for a few seconds.
 */
export function useAgents(names: string[], subscribe: (fn: (e: Ev) => void) => () => void, memorySize: number) {
  const minds = useRef<Record<string, AgentMind>>({});
  const [, force] = useState(0);
  const memRef = useRef(memorySize);
  memRef.current = memorySize;

  for (const name of names) {
    if (!minds.current[name]) minds.current[name] = { mood: "watching", thought: "Waking up…", at: 0, seen: 0, log: [] };
  }

  useEffect(() => {
    const act = (name: string, mood: Mood, thought: string, tone: AgentMind["log"][number]["tone"] = "info") => {
      const m = minds.current[name];
      if (!m) return;
      m.mood = mood;
      m.thought = thought;
      m.at = Date.now();
      m.log = [{ text: thought, at: Date.now(), tone }, ...m.log].slice(0, 6);
    };
    const idle = (name: string, thought: string) => {
      const m = minds.current[name];
      if (!m) return;
      if (Date.now() - m.at < 6000) return; // keep the spotlight on recent actions
      m.mood = "watching";
      m.thought = thought;
    };

    let pending = false;
    const kick = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        force((x) => x + 1);
      });
    };

    let blockTxs: Ev[] = [];
    return subscribe((e) => {
      if (e.type === "tx") {
        blockTxs.push(e);
        for (const k of e.kinds as string[]) {
          for (const who of RESPONSIBLE[k] ?? ["b-cell"]) if (minds.current[who]) minds.current[who].seen++;
        }
      }
      if (e.type === "block") {
        const kinds = (k: string) => blockTxs.filter((t) => t.kinds.includes(k)).length;
        const transfers = kinds("Transfer");
        const deploys = kinds("DeployContract");
        const creates = kinds("CreateAccount");
        const keys = kinds("AddKey");
        const h = n(e.height);
        idle(
          "neutrophil",
          transfers || keys
            ? `Block ${h}: following ${transfers} transfer${transfers === 1 ? "" : "s"}${keys ? ` and ${keys} new key${keys === 1 ? "" : "s"}` : ""} for sweeps`
            : `Block ${h}: no money moving. Still watching.`,
        );
        idle("macrophage", deploys ? `Block ${h}: reading the code of ${deploys} new contract${deploys === 1 ? "" : "s"}` : `Block ${h}: no new contracts to inspect`);
        idle("nk-cell", transfers ? `Comparing ${transfers} payment${transfers === 1 ? "" : "s"} with each agent's habits` : `Learning spending habits. Nothing unusual.`);
        idle("t-helper", creates ? `Block ${h}: checking ${creates} new name${creates === 1 ? "" : "s"} against protected ones` : `No new names in block ${h}`);
        idle("b-cell", `Holding ${memRef.current} remembered scam code${memRef.current === 1 ? "" : "s"}. Ready to double-check.`);
        blockTxs = [];
        kick();
      }
      if (e.type === "finding" && e.scope === "filed") {
        act(e.sentinel, "alert", `Spotted a ${e.category.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}: ${shortId(e.target)}`, "alert");
        kick();
      }
      if (e.type === "explain") {
        // the explanation belongs to whichever agent is currently alert
        const who = Object.entries(minds.current).find(([, m]) => m.mood === "alert");
        if (who) {
          who[1].thought = e.text;
          kick();
        }
      }
      if (e.type === "chain") {
        if (e.action === "flag") {
          act(e.sentinel, e.ok ? "staking" : "alert", e.ok ? `Reported #${e.reportId} and staked 0.02 NEAR on it` : `Could not file the report: ${e.error}`, e.ok ? "alert" : "bad");
        } else if (e.action === "vote") {
          act(
            e.sentinel,
            "checking",
            e.ok
              ? e.support
                ? `Re-checked the evidence on #${e.reportId} myself. Confirmed, staked 0.02.`
                : `Re-checked #${e.reportId} with my own thresholds. Not convinced, voted against.`
              : `Vote on #${e.reportId} failed: ${e.error}`,
            e.ok ? (e.support ? "good" : "bad") : "bad",
          );
        } else if (e.action === "finalize" && e.ok) {
          act(e.sentinel, "closing", `Closed report #${e.reportId}. The verdict is onchain.`, "good");
        }
        kick();
      }
      if (e.type === "memory") {
        act("b-cell", "staking", `Remembered new scam code ${e.codeHash.slice(0, 8)}… for good`, "good");
        kick();
      }
    });
  }, [subscribe]);

  return minds.current;
}
