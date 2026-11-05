# Leukonet

**An immune system for NEAR.** Five AI sentinel agents read every NEAR block as it lands, catch scams as they happen, and stake NEAR on their verdicts in an onchain registry. Any wallet or agent can call `is_safe(account)` before it pays someone.

Built for **NEAR HACKATHON 2026**.
Tracks: **AI Security & Defense**, **AI Swarms**, **Agent Economy**, **Open Innovation**.

| | |
|---|---|
| Registry contract (testnet) | [`registry.leukonet-mw43jm6i.testnet`](https://testnet.nearblocks.io/address/registry.leukonet-mw43jm6i.testnet) |
| Stack | Rust (near-sdk 5) · TypeScript (near-api-js 7) · React · FastNear neardata · NEAR AI Cloud |
| License | MIT |

---

## The problem

AI agents are starting to hold wallets and pay each other. Wallet drainers, stolen keys, fake airdrop contracts and look-alike account names already take money from people. They will take it from agents faster, because agents pay without hesitating. Warnings about scam accounts today live in Discord threads and X posts, hours after the money is gone. Nothing machine-readable answers "should I pay this account?" while it still matters.

## What Leukonet does

1. **Watch.** The swarm follows the chain head in real time, about one block a second, scanning every transaction on testnet.
2. **Flag.** Each sentinel specialises in one threat. When it sees one, it files a report in the registry contract and **stakes NEAR** on it.
3. **Verify.** The other sentinels re-check the evidence on chain with their **own thresholds** and vote with their own stake. If the swarm disagrees, the wrong side loses its stake to the right side. False accusations cost money.
4. **Protect.** Confirmed threats go into a public registry. One free view call, `is_safe(account_id)`, tells a wallet or agent whether to pay.
5. **Remember.** Once a scam contract is confirmed, its code hash goes into **immune memory**. The same code deployed under any new name is caught on sight.

On testnet the whole loop takes about **10–15 seconds** from the attack to the onchain verdict. That's measured in our runs: drainer 10s, key hijack 14s, scam contract 14s, and a scam-code redeploy caught from memory 9s.

### The five sentinels

| Sentinel | Specialty | What it catches |
|---|---|---|
| `neutrophil` | first responder | **Drainer**: one account receives full-balance sweeps from 3+ wallets. **Key hijack**: a newly added full-access key empties its own account. |
| `macrophage` | contracts | **Malicious contract**: newly deployed code exposing lure methods (`claim_airdrop`, `verify_wallet`, …), or code already in immune memory. |
| `nk-cell` | agents | **Rogue agent**: an account with a steady payment pattern suddenly pays a new payee ≥10× its median. |
| `t-helper` | names, coordinator | **Look-alike**: a new account one edit or homoglyph away from a protected name (`leuk0net-pay` vs `leukonet-pay`). It also closes finished votes. |
| `b-cell` | sceptic | Files nothing. Re-checks every report with the strictest thresholds, so it is the sentinel most likely to vote against. |

Each sentinel is its **own NEAR account** with its own bond. They share no keys.

## How NEAR is used

- **Registry contract** (`contracts/registry`, Rust). Bonds, staked reports, staked votes, finalisation with stake redistribution, and the public `is_safe` view. Everything happens onchain: every flag, vote and verdict has a transaction hash.
- **Named sub-accounts.** Each sentinel and each demo actor is a sub-account of one master (`neutrophil.leukonet-….testnet`).
- **Access keys as a signal.** Key-hijack detection relies on NEAR's access-key model. A transfer signed by a full-access key added minutes earlier is the signature of a phished seed phrase.
- **Account naming.** Look-alike detection uses NEAR's human-readable names and the `testnet` registrar.
- **FastNear neardata.** One request returns a whole block, with every transaction and each signer's post-transaction balance, so the swarm keeps up with ~1s blocks.
- **NEAR AI Cloud** (optional). When `NEAR_AI_API_KEY` is set, the reporting sentinel turns the evidence into one plain-English sentence, which is stored onchain as the report summary.

## Try it: judge walkthrough

You need Node ≥ 20 and Rust (with `rustup`). Everything runs on **testnet** and is free.

```bash
git clone <this repo> && cd leukonet
npm install
npm run setup        # creates a testnet account via the faucet, builds + deploys the registry,
                     # creates 5 sentinel accounts with bonds, registers a protected name
npm run build:web
npm start            # swarm + threat map on http://localhost:8787
```

Then, in the browser at `http://localhost:8787`:

| Do this | You should see |
|---|---|
| Open the page | **Threat map**: grey particles are live testnet transactions flowing in. The block number in the header ticks up about once a second. |
| Click **Launch an attack → Wallet drainer** | The timeline shows three wallets being swept, each with a `tx ↗` link. |
| Wait ~10–20 s | A **Drainer** report appears in *Reports in the registry*. Five vote chips turn ✓ one by one; on the map, cyan lines run from each sentinel to the drainer. Status becomes **Confirmed**. |
| Look at the attack panel | **Payment blocked**: the guarded agent refused to pay the drainer. |
| Paste the drainer's account into **Check before you pay** | `Do not pay … Drainer · risk 90/100`. |
| Run **Airdrop scam contract** twice | First run: caught by `malicious_contract` (lure methods). The code hash appears in **Immune memory**. Second run: same code, new name, caught by `immune_memory`. |
| Try **Key hijack**, **Rogue AI agent**, **Look-alike account** | Each is caught by its specialist and confirmed onchain. |

The same from the terminal (with `npm start` running):

```bash
npm run attack -- drainer            # also: key_hijack, malicious_contract, rogue_agent, lookalike
npm run check -- <account.testnet>   # ✗ <account>: Drainer (risk 90/100, reports 0)
npm run example:guarded-agent        # pays a safe supplier, refuses the latest confirmed threat
npm test                             # 7 contract tests (Rust) + 7 detector tests (TypeScript)
```

Or check the deployed registry directly, without installing anything:

```bash
curl -s https://rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"registry.leukonet-mw43jm6i.testnet","method_name":"get_stats","args_base64":"e30="}}' \
  | python3 -c "import json,sys; print(bytes(json.load(sys.stdin)['result']['result']).decode())"
```

## Use it from your wallet or agent

```ts
import { guarded, checkBeforePay, LeukonetBlocked } from "./src/sdk/guard";

const opts = { registry: "registry.leukonet-mw43jm6i.testnet" };

const check = await checkBeforePay("someone.testnet", opts);
// { safe: false, risk: 90, categories: ["Drainer"], report_ids: [0], pending_reports: [] }

await guarded("someone.testnet", opts, () => pay("someone.testnet", amount)); // throws LeukonetBlocked
```

`guarded` wraps any payment function. Options: `blockPending: true` also refuses while a report is still being voted on, and `maxRisk` sets the risk threshold.

## Contract interface

| Method | Kind | What it does |
|---|---|---|
| `register_sentinel()` | payable | Join the swarm by locking a bond (≥ 0.2 NEAR on the demo deployment). |
| `flag(target, category, severity, summary, evidence)` | payable | Open a report, staking ≥ 0.02 NEAR. If a report on the same account and category is already open, this counts as a supporting vote. |
| `vote(report_id, support, note)` | payable | Confirm or dispute an open report with stake. One vote per sentinel. |
| `finalize(report_id)` | call | Anyone can close a report once the 20s window ends, or early once ≥ 3 sentinels agree unanimously. Confirmed needs ≥ 66% of the stake. Winners split the losers' stake pro rata; with too few votes, everyone is refunded. |
| `is_safe(account_id)` | view | `{ safe, risk, categories, report_ids, pending_reports }` |
| `get_reports`, `get_report`, `get_sentinels`, `get_verdicts`, `get_stats`, `get_config` | view | Everything the dashboard shows. |
| `clear_verdict`, `set_config` | owner | Override for a proven false positive, and tuning. |

Events are logged as `EVENT_JSON` (`flagged`, `voted`, `finalized`, `sentinel_joined`).

## Architecture

```
 testnet blocks ──► BlockStream (neardata, ~1 block/s, retries, RPC fallback)
                        │
                        ▼
             detectors: drainer · key_hijack · malicious_contract(+memory) · rogue_agent · lookalike
                        │ finding
                        ▼
   owner sentinel ──explain (NEAR AI)──► flag + stake ──►  registry contract  ◄── is_safe() ── wallets / agents
                                                             ▲          │
   other sentinels ── re-check evidence, own thresholds ── vote + stake  │
   t-helper ──────────────────────────────────────────────── finalize ───┘
                        │
                        ▼
            Hub ──SSE──► React threat map (web/)
```

```
contracts/registry   Rust registry contract + unit tests
contracts/bait       ~1.6 KB raw-wasm fake airdrop used by the simulator (testnet only)
src/stream.ts        real-time block streamer
src/detectors/       the five detectors (pure, unit-tested)
src/sentinel.ts      sentinel personas, filing and voting
src/swarm.ts         orchestration, registry polling, immune memory
src/sim/             attack simulator and normal background traffic
src/sdk/guard.ts     checkBeforePay / guarded
src/main.ts          server: swarm + SSE + static dashboard
web/                 React dashboard
examples/            guarded payment agent
test/                detector tests
```

## Safety and honesty notes

- **Simulated attacks only touch demo accounts.** The attack simulator only creates and moves funds between sub-accounts of the demo's own master account, plus one look-alike top-level name it registers itself. It returns the funds afterwards by deleting the throwaway accounts.
- **The swarm doesn't accuse strangers.** By default (`FLAG_SCOPE=demo`) sentinels only stake on accounts that belong to the demo. Suspicious patterns on public testnet appear on the dashboard as *observed* and are never reported onchain. Setting `FLAG_SCOPE=all` lifts this.
- **The detectors are heuristics.** They're tuned to the attack patterns they target. Staking and independent re-checking exist so that the swarm can disagree and a single bad call costs its maker. The contract owner can clear a proven false positive.
- **NEAR AI is optional.** Without `NEAR_AI_API_KEY`, report summaries use each detector's own one-line reason.
- **Mainnet watch mode** (`WATCH_MAINNET=1`) scans mainnet read-only against well-known names and never writes.

## Hackathon disclosure

All code in this repository was written during the NEAR HACKATHON window, starting from an empty repository, with AI assistance (Claude Code). Libraries used: `near-sdk`, `near-api-js`, `react`, `vite`, `dotenv`, `tsx`. Data comes from FastNear (neardata, RPC). It is not derived from any earlier project.
