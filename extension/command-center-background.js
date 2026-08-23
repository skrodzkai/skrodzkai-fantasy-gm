/* global chrome */
"use strict";

async function openCommandCenter() {
  const stored = await chrome.storage.session.get("skz.popupWindowId");
  const popupWindowId = Number(stored["skz.popupWindowId"]);
  if (Number.isInteger(popupWindowId)) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return popupWindowId;
    } catch {
      await chrome.storage.session.remove("skz.popupWindowId");
    }
  }
  const popup = await chrome.windows.create({
    url: chrome.runtime.getURL("extension/command-center.html"),
    type: "popup",
    width: 1180,
    height: 780,
    focused: true,
  });
  if (Number.isInteger(popup.id)) await chrome.storage.session.set({ "skz.popupWindowId": popup.id });
  return popup.id ?? null;
}

chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get("skz.popupWindowId").then((stored) => {
    if (Number(stored["skz.popupWindowId"]) === windowId) return chrome.storage.session.remove("skz.popupWindowId");
    return undefined;
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "state" && Number.isInteger(sender.tab?.id)) {
    const update = { "skz.tabId":sender.tab.id, "skz.snapshot":message.snapshot };
    if (Array.isArray(message.board)) update["skz.board"] = message.board;
    void chrome.storage.session.set(update);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "open_command_center") {
    void openCommandCenter().then((windowId) => sendResponse({ ok: Number.isInteger(windowId), windowId }));
    return true;
  }
  if (message?.type !== "command") return false;
  void chrome.storage.session.get("skz.tabId").then((stored) => {
    const tabId = Number(stored["skz.tabId"]);
    if (!Number.isInteger(tabId)) { sendResponse({ ok: false, error: "no_yahoo_draft_tab" }); return; }
    chrome.tabs.sendMessage(tabId, message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  });
  return true;
});
