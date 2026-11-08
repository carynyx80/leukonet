// Bundles the extension into extension/dist (load it unpacked from there).
import { build } from "esbuild";
import fs from "node:fs";
const out = new URL("./dist/", import.meta.url).pathname;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await build({
  entryPoints: { background: "extension/src/background.ts", content: "extension/src/content.ts", popup: "extension/src/popup.ts" },
  bundle: true, format: "esm", target: "chrome114", outdir: out, minify: false, logLevel: "warning",
});
// The content script is injected as a classic script: no top-level import/export.
for (const f of ["manifest.json", "popup.html", "icon.png"]) fs.copyFileSync(new URL(`./${f}`, import.meta.url), out + f);
console.log("built extension/dist");
