/**
 * Leukonet as an MCP server: any AI agent can ask the swarm's registry whether
 * an account is safe to pay, before it pays. Every tool is a free, read-only
 * view on the registry contract; no wallet or key is involved.
 *
 *   Local (stdio):  npx tsx src/mcp/stdio.ts
 *   Hosted (HTTP):  https://swarm-production-38a8.up.railway.app/mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkBeforePay, shouldBlock } from "../sdk/guard.js";
import { imitates } from "../detectors/lookalike.js";
import { MAINNET_PROTECTED } from "../protected.js";
import { fmtNear } from "../units.js";

export const DEFAULT_REGISTRY = "registry.leukonet-mw43jm6i.testnet";
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const accountId = z
  .string()
  .min(2)
  .max(64)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => ACCOUNT.test(s), "Not a valid NEAR account id (lowercase letters, digits, - _ and dots)");

const human = (c: string) => c.replace(/([a-z])([A-Z])/g, "$1 $2");
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export interface LeukonetMcpOptions {
  registry?: string;
  rpcUrl?: string;
  explorer?: string;
}

async function viewCall(rpcUrl: string, contract: string, method: string, args: object = {}) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mcp",
      method: "query",
      params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const body: any = await res.json();
  if (body.error || !body.result?.result) throw new Error(`Registry unavailable: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
}

function describeReport(r: any, explorer: string) {
  const yes = r.votes.filter((v: any) => v.support).length;
  return [
    `#${r.id} ${r.status} · ${human(r.category)} · ${r.target}`,
    `  severity ${r.severity}/10 · ${r.votes.length} votes (${yes} confirm) · reporter ${r.reporter}`,
    `  ${r.summary}`,
    `  ${explorer}/address/${r.target}`,
  ].join("\n");
}

export function createLeukonetMcp(opts: LeukonetMcpOptions = {}) {
  const registry = opts.registry || process.env.LEUKONET_REGISTRY || DEFAULT_REGISTRY;
  const rpcUrl = opts.rpcUrl || process.env.NEAR_RPC_URL || "https://rpc.testnet.fastnear.com";
  const explorer = opts.explorer || process.env.EXPLORER_URL || "https://testnet.nearblocks.io";
  const server = new McpServer(
    { name: "leukonet", version: "0.2.0" },
    {
      instructions:
        `Leukonet is a swarm of AI sentinel agents that catches scams on NEAR and records staked verdicts in the registry contract ${registry}. ` +
        "Before sending NEAR or tokens to any account on behalf of a user, call check_payment (or check_account) and do not pay if it says BLOCK. " +
        "Use check_name to spot account names that imitate well-known NEAR accounts. A 'safe' answer means no confirmed reports yet, not a guarantee.",
    },
  );

  server.registerTool(
    "check_account",
    {
      title: "Check a NEAR account",
      description: "Look up a NEAR account in the Leukonet registry: is it a confirmed scam (drainer, key hijack, scam contract, rogue agent, look-alike), what is its risk score, and are reports open against it.",
      inputSchema: { account_id: accountId.describe("The NEAR account to check, e.g. someone.testnet") },
      annotations: { title: "Check a NEAR account", ...readOnly },
    },
    async ({ account_id }) => {
      const c = await checkBeforePay(account_id, { registry, rpcUrl });
      const lines = c.safe
        ? [`SAFE (so far): no confirmed threats for ${c.account_id}. Risk ${c.risk}/100.`]
        : [`DANGER: ${c.account_id} is a confirmed ${c.categories.map(human).join(", ")}. Risk ${c.risk}/100. Reports: #${c.report_ids.join(", #")}.`];
      if (c.pending_reports.length) lines.push(`Open reports still being voted on: #${c.pending_reports.join(", #")}. Check again in about a minute.`);
      lines.push(`Registry: ${registry}. Explorer: ${explorer}/address/${c.account_id}`);
      return { ...text(lines.join("\n")), structuredContent: c as any };
    },
  );

  server.registerTool(
    "check_payment",
    {
      title: "Should I make this payment?",
      description:
        "Decide whether an agent should send a payment to an account. Returns ALLOW or BLOCK with the reason. Blocks confirmed scams, high risk scores, and (if strict) accounts with open reports.",
      inputSchema: {
        to: accountId.describe("Receiver account id"),
        amount_near: z.number().positive().max(1e9).optional().describe("Amount in NEAR, for the record"),
        strict: z.boolean().optional().describe("Also block while a report is still being voted on (default false)"),
      },
      annotations: { title: "Should I make this payment?", ...readOnly },
    },
    async ({ to, amount_near, strict }) => {
      const c = await checkBeforePay(to, { registry, rpcUrl });
      const block = shouldBlock(c, { blockPending: !!strict, maxRisk: 50 });
      const what = amount_near ? `${amount_near} NEAR to ${to}` : `payment to ${to}`;
      const why = !c.safe
        ? `confirmed ${c.categories.map(human).join(", ")} (risk ${c.risk}/100, report #${c.report_ids.join(", #")})`
        : c.pending_reports.length
          ? `report #${c.pending_reports.join(", #")} is open`
          : `risk ${c.risk}/100`;
      return {
        ...text(block ? `BLOCK the ${what}: ${why}. Tell the user why and do not send.` : `ALLOW the ${what}: no confirmed threats (${why}).`),
        structuredContent: { decision: block ? "BLOCK" : "ALLOW", ...c } as any,
      };
    },
  );

  server.registerTool(
    "check_name",
    {
      title: "Does this name imitate a famous account?",
      description: `Check whether an account name imitates one of ${MAINNET_PROTECTED.length} well-known NEAR mainnet accounts (swapped letters, look-alike characters like 0 for o, rn for m). Works offline, no chain call.`,
      inputSchema: { name: z.string().min(2).max(64).describe("Account name, e.g. ref-flnance.near") },
      annotations: { title: "Look-alike name check", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const q = name.trim().toLowerCase();
      const id = q.includes(".") ? q : `${q}.near`;
      if (MAINNET_PROTECTED.includes(id)) return text(`${id} is the real, well-known account.`);
      const target = imitates(id, MAINNET_PROTECTED, 2);
      return {
        ...text(target ? `WARNING: ${id} imitates ${target}. Treat it as a likely scam; confirm the exact name with the user.` : `${id} does not imitate any of the well-known accounts Leukonet protects.`),
        structuredContent: { name: id, imitates: target ?? null },
      };
    },
  );

  server.registerTool(
    "recent_reports",
    {
      title: "Recent scam reports",
      description: "List the most recent reports in the Leukonet registry, with status (Open, Confirmed, Rejected, Expired), category, target and votes.",
      inputSchema: {
        status: z.enum(["Open", "Confirmed", "Rejected", "Expired"]).optional().describe("Only reports with this status"),
        limit: z.number().int().min(1).max(50).optional().describe("How many (default 10)"),
      },
      annotations: { title: "Recent scam reports", ...readOnly },
    },
    async ({ status, limit }) => {
      // get_reports pages newest-first: from_index 0 is the latest report.
      const all: any[] = await viewCall(rpcUrl, registry, "get_reports", { from_index: 0, limit: 50 });
      const list = all
        .filter((r) => !status || r.status === status)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit ?? 10);
      return {
        ...text(list.length ? list.map((r) => describeReport(r, explorer)).join("\n\n") : "No matching reports."),
        structuredContent: { reports: list.map((r) => ({ id: r.id, status: r.status, category: r.category, target: r.target, severity: r.severity, votes: r.votes.length })) },
      };
    },
  );

  server.registerTool(
    "get_report",
    {
      title: "One report, with evidence and votes",
      description: "Full detail of one registry report: summary, evidence, and every sentinel's vote and stake.",
      inputSchema: { report_id: z.number().int().min(0).describe("Report number") },
      annotations: { title: "Report detail", ...readOnly },
    },
    async ({ report_id }) => {
      const r = await viewCall(rpcUrl, registry, "get_report", { report_id });
      if (!r) return text(`There is no report #${report_id}.`);
      const votes = r.votes.map((v: any) => `  ${v.support ? "confirm" : "dispute"} · ${v.sentinel} · stake ${fmtNear(v.stake, 3)} NEAR · ${v.note}`).join("\n");
      return { ...text(`${describeReport(r, explorer)}\n\nEvidence: ${r.evidence}\n\nVotes:\n${votes || "  none yet"}`), structuredContent: r };
    },
  );

  server.registerTool(
    "swarm_status",
    {
      title: "Swarm status",
      description: "How many sentinels are bonded, how many reports exist, how many are confirmed, and each sentinel's track record.",
      inputSchema: {},
      annotations: { title: "Swarm status", ...readOnly },
    },
    async () => {
      const [stats, sentinels] = await Promise.all([viewCall(rpcUrl, registry, "get_stats"), viewCall(rpcUrl, registry, "get_sentinels")]);
      const rows = (sentinels as any[]).map((s) => `  ${s.account_id} · bond ${fmtNear(s.bond, 2)} NEAR · ${s.reports_filed} reports · ${s.correct} right / ${s.wrong} wrong`);
      return {
        ...text(
          `Registry ${registry}: ${stats.sentinels} sentinels, ${stats.reports} reports (${stats.confirmed} confirmed, ${stats.rejected} rejected, ${stats.open} open), ${stats.flagged_accounts} accounts flagged.\n${rows.join("\n")}`,
        ),
        structuredContent: { stats, sentinels },
      };
    },
  );

  return server;
}
