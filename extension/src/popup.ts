import { check, sentence, settings } from "./shared";

const $ = (id: string) => document.getElementById(id)!;
const TITLES = { scam: "Do not pay", pending: "Report open", impostor: "Possible impostor", clean: "No confirmed threats", unknown: "Registry unreachable" };

settings().then((s) => {
  $("reg").textContent = s.registry.replace(/^registry\./, "");
  ($("site") as HTMLAnchorElement).href = s.site;
});

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = ($("q") as HTMLInputElement).value.trim().toLowerCase();
  if (!id) return;
  $("title").textContent = "Checking…";
  $("msg").textContent = id;
  $("out").className = "out";
  $("out").hidden = false;
  const v = await check(id);
  $("out").className = `out ${v.level}`;
  $("title").textContent = TITLES[v.level];
  $("msg").textContent = `${v.account_id}: ${sentence(v)}`;
});

$("scan").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  let marked = 0;
  try {
    marked = await chrome.tabs.sendMessage(tab.id, { type: "scan" });
  } catch {
    // Not a page the scanner runs on by default: inject it once, with your click as permission.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await new Promise((r) => setTimeout(r, 1500));
    marked = await chrome.tabs.sendMessage(tab.id, { type: "scan" }).catch(() => 0);
  }
  $("scanned").hidden = false;
  $("scanned").textContent = marked ? `${marked} risky account${marked === 1 ? "" : "s"} marked` : "Nothing risky on this page";
});
