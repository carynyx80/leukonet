import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const FILE = path.join(ROOT, "data", "immune-memory.json");

interface MemoryFile {
  /** code hash -> report id that confirmed it malicious */
  knownBadCode: Record<string, number>;
}

/**
 * Immune memory: once the swarm confirms a contract is malicious, its code hash
 * is remembered, so the same code is caught instantly wherever it is deployed next.
 */
export class ImmuneMemory {
  private data: MemoryFile = { knownBadCode: {} };
  constructor() {
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch {
      /* first run */
    }
  }
  knownBad = () => new Map(Object.entries(this.data.knownBadCode));
  remember(codeHash: string, reportId: number): boolean {
    if (this.data.knownBadCode[codeHash] !== undefined) return false;
    this.data.knownBadCode[codeHash] = reportId;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.data, null, 2));
    return true;
  }
  size = () => Object.keys(this.data.knownBadCode).length;
}
