import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const KEY_DIR = path.join(ROOT, ".keys");

export type Network = "testnet" | "mainnet";

export const config = {
  network: (process.env.NEAR_NETWORK ?? "testnet") as Network,
  rpcUrl: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com",
  /** FastNear neardata: one request returns a whole block with every transaction. */
  dataUrl: process.env.NEAR_DATA_URL ?? "https://testnet.neardata.xyz",
  /** Read-only mainnet RPC for the watch-only mode. */
  mainnetRpcUrl: process.env.NEAR_MAINNET_RPC_URL ?? "https://rpc.mainnet.fastnear.com",
  mainnetDataUrl: process.env.NEAR_MAINNET_DATA_URL ?? "https://mainnet.neardata.xyz",
  master: process.env.LEUKONET_MASTER ?? "",
  registry: process.env.LEUKONET_REGISTRY ?? "",
  port: Number(process.env.PORT ?? 8787),
  /** NEAR AI Cloud (OpenAI-compatible). Without a key, sentinels use template explanations. */
  nearAiKey: process.env.NEAR_AI_API_KEY ?? "",
  nearAiUrl: process.env.NEAR_AI_URL ?? "https://cloud-api.near.ai/v1",
  nearAiModel: process.env.NEAR_AI_MODEL ?? "anthropic/claude-haiku-5-5",
  /** Expose the attack buttons on the dashboard. */
  demoControls: (process.env.DEMO_CONTROLS ?? "1") === "1",
  /** Run background "normal" traffic so the map is alive and agents have a spending baseline. */
  normalTraffic: (process.env.NORMAL_TRAFFIC ?? "1") === "1",
  explorer: process.env.EXPLORER_URL ?? "https://testnet.nearblocks.io",
};

export interface StoredKey {
  accountId: string;
  privateKey: string;
}

/**
 * On a host without a .keys/ folder (Railway), keys come from LEUKONET_KEYS:
 * base64 of {"<name>": {"accountId": "...", "privateKey": "..."}}. Written by `npm run export-env`.
 */
const envKeys: Record<string, StoredKey> = (() => {
  try {
    return process.env.LEUKONET_KEYS ? JSON.parse(Buffer.from(process.env.LEUKONET_KEYS, "base64").toString()) : {};
  } catch {
    console.warn("LEUKONET_KEYS is set but could not be decoded");
    return {};
  }
})();

export function loadKey(name: string): StoredKey {
  if (envKeys[name] && !fs.existsSync(path.join(KEY_DIR, `${name}.json`))) return envKeys[name];
  const file = path.join(KEY_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing key file ${file}. Run "npm run setup" first.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function hasKey(name: string): boolean {
  return !!envKeys[name] || fs.existsSync(path.join(KEY_DIR, `${name}.json`));
}

export function saveKey(name: string, key: StoredKey) {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(path.join(KEY_DIR, `${name}.json`), JSON.stringify(key, null, 2), { mode: 0o600 });
}

export function requireDeployed() {
  if (!config.master || !config.registry) {
    throw new Error('LEUKONET_MASTER / LEUKONET_REGISTRY are not set. Run "npm run setup" first.');
  }
}
