/**
 * Writes the environment variables a hosted backend (e.g. Railway) needs into
 * .keys/hosted.env. The file holds private keys: it stays out of git and is
 * never printed. Paste its contents into your host's variables.
 */
import fs from "node:fs";
import path from "node:path";
import { KEY_DIR, config, loadKey } from "../config.js";
import { readDemoState } from "../swarm.js";
import { PERSONAS } from "../sentinel.js";

const names = ["master", ...PERSONAS.map((p) => `sentinel-${p.name}`)];
const keys = Object.fromEntries(names.map((n) => [n, loadKey(n)]));
const vars: Record<string, string> = {
  LEUKONET_MASTER: config.master,
  LEUKONET_REGISTRY: config.registry,
  LEUKONET_PROTECTED: readDemoState().protected.join(","),
  LEUKONET_KEYS: Buffer.from(JSON.stringify(keys)).toString("base64"),
};
const file = path.join(KEY_DIR, "hosted.env");
fs.writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
console.log(`Wrote ${Object.keys(vars).length} variables (${names.length} keys) to ${file}. Do not commit it.`);
