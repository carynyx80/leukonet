# Leukonet demo (about 2 minutes)

One complete moment, from a scam to "payment blocked", on the live site. No slides.

**Before recording**
- Open https://leukonet.vercel.app in a clean browser window, 1440×900 or larger, dark mode, zoom 100%.
- Wait until the green "Your browser is a white blood cell" card shows a climbing tx count.
- Have the Leukonet Guard extension loaded (`chrome://extensions` → Load unpacked → the unzipped `leukonet-guard.zip`), pinned to the toolbar.
- Have Claude Desktop (or any MCP client) with the Leukonet MCP server added: `https://swarm-production-38a8.up.railway.app/mcp`.

| Time | On screen | Say (or caption) |
|---|---|---|
| 0:00–0:10 | The hero, map moving | "AI agents are getting wallets. Scammers will drain them faster than people. Leukonet is an immune system for NEAR." |
| 0:10–0:20 | Hover the five agents on the map | "Five AI agents read every NEAR block live. Each has its own account and its own bond." |
| 0:20–0:50 | Click **Wallet drainer**. Let the six steps run: Attack → Spotted → Reported → Voted → Confirmed → Blocked | "I release a real wallet drainer on testnet. Three wallets get swept. The first responder spots it, often my own browser first, and stakes NEAR on a report. The other agents re-check the evidence on chain, with their own rules, and vote with stake. Confirmed. And a payment agent that asks Leukonet first refuses to pay the thief." |
| 0:50–1:00 | Open *Every step*, click one `tx ↗` | "Every step is a real NEAR transaction." |
| 1:00–1:15 | Scroll to **Check before you pay**, click the drainer under *Try* | "Anyone can ask the registry before paying. Free, no wallet needed." |
| 1:15–1:35 | Switch to Claude: "Pay 1 NEAR to drainer-….testnet" | "Any AI agent can too. Over MCP, Claude calls check_payment, gets BLOCK, and explains why." |
| 1:35–1:50 | On testnet.nearblocks.io, the drainer marked **SCAM** by the extension | "And people get it in the browser: scam and impostor accounts are marked right on the page." |
| 1:50–2:00 | Back to the hero | "NEAR makes this possible: cheap, fast finality for staked votes, accounts for every agent, and one view call any wallet can make. Try it at leukonet.vercel.app." |

**If the live server is slow** (shared free data feed), the hero says so instead of failing. Run it locally for recording: `npm run setup && npm start`, then open http://localhost:8787.
