/** Marks scam and impostor NEAR accounts on the page. Read-only: never changes forms or links. */
import { ACCOUNT_RE, type Verdict } from "./shared";

const MARK = "data-leukonet";
const style = document.createElement("style");
style.textContent = `
[${MARK}]{border-radius:4px;padding:0 3px;box-decoration-break:clone}
[${MARK}="scam"]{background:rgba(255,138,106,.18);outline:1px solid #ff8a6a;color:inherit}
[${MARK}="impostor"],[${MARK}="pending"]{background:rgba(242,198,109,.18);outline:1px dashed #f2c66d}
[${MARK}]::after{content:attr(data-leukonet-label);margin-left:4px;font:600 10px/1.6 ui-monospace,monospace;letter-spacing:.04em;padding:0 5px;border-radius:3px;vertical-align:1px}
[${MARK}="scam"]::after{background:#ff8a6a;color:#1a0702}
[${MARK}="impostor"]::after,[${MARK}="pending"]::after{background:#f2c66d;color:#1a1302}`;
document.documentElement.appendChild(style);

function textNodes(root: Node) {
  const out: Text[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest(`[${MARK}], script, style, textarea, input, [contenteditable="true"]`)) return NodeFilter.FILTER_REJECT;
      return /\.(testnet|near)\b/.test(n.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  while (walk.nextNode() && out.length < 2000) out.push(walk.currentNode as Text);
  return out;
}

async function scan() {
  const nodes = textNodes(document.body);
  const ids = new Set<string>();
  for (const n of nodes) for (const m of (n.nodeValue ?? "").matchAll(ACCOUNT_RE)) ids.add(m[0]);
  if (!ids.size) return 0;
  const verdicts: Verdict[] = await chrome.runtime.sendMessage({ type: "check", ids: [...ids].slice(0, 200) });
  const bad = new Map(verdicts.filter((v) => v.level === "scam" || v.level === "impostor" || v.level === "pending").map((v) => [v.account_id, v]));
  if (!bad.size) return 0;
  let marked = 0;
  for (const n of nodes) {
    const text = n.nodeValue ?? "";
    const parts: (string | Verdict)[] = [];
    let last = 0;
    for (const m of text.matchAll(ACCOUNT_RE)) {
      const v = bad.get(m[0]);
      if (!v) continue;
      parts.push(text.slice(last, m.index), v);
      last = m.index! + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(text.slice(last));
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (typeof p === "string") {
        frag.append(p);
        continue;
      }
      const span = document.createElement("span");
      span.setAttribute(MARK, p.level);
      span.setAttribute("data-leukonet-label", p.level === "scam" ? "SCAM" : p.level === "pending" ? "REPORTED" : "IMPOSTOR");
      span.title = p.level === "scam" ? `Leukonet: confirmed ${p.categories.join(", ")} · risk ${p.risk}/100. Do not pay.` : p.level === "pending" ? "Leukonet: a report is being voted on." : `Leukonet: imitates ${p.imitates}`;
      span.textContent = p.account_id;
      frag.append(span);
      marked++;
    }
    n.replaceWith(frag);
  }
  return marked;
}

let timer = 0;
const later = () => {
  clearTimeout(timer);
  timer = window.setTimeout(() => void scan().catch(() => 0), 800);
};
new MutationObserver(later).observe(document.body, { childList: true, subtree: true, characterData: true });
later();

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === "scan") {
    scan().then(reply, () => reply(0));
    return true;
  }
});
