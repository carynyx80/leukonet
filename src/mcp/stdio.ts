/**
 * Leukonet MCP server over stdio, for Claude Desktop, Claude Code, Cursor or any MCP client:
 *   { "command": "npx", "args": ["tsx", "/path/to/leukonet/src/mcp/stdio.ts"] }
 * Optional env: LEUKONET_REGISTRY, NEAR_RPC_URL, EXPLORER_URL.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLeukonetMcp } from "./server.js";

await createLeukonetMcp().connect(new StdioServerTransport());
