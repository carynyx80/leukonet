import { check, sentence } from "./shared";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "leukonet-check", title: "Check “%s” with Leukonet", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const id = (info.selectionText ?? "").trim().toLowerCase();
  if (!id) return;
  const v = await check(id);
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: v.level === "scam" ? `Leukonet: do not pay ${id}` : v.level === "impostor" ? `Leukonet: possible impostor` : `Leukonet: ${id}`,
    message: sentence(v),
    priority: v.level === "scam" || v.level === "impostor" ? 2 : 0,
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "check" || !Array.isArray(msg.ids)) return;
  Promise.all(msg.ids.slice(0, 200).map((id: string) => check(id))).then(reply);
  return true; // async reply
});
