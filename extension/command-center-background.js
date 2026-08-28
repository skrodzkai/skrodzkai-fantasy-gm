(function commandCenterBackground(root) {
  "use strict";

  const HEARTBEAT_TTL_MS = 3000;

  function extensionVersion(chromeApi) {
    return String(chromeApi.runtime.getManifest().version);
  }

  function createStateRouter(session, clock = () => Date.now()) {
    const fresh = (seenAt) => Number.isFinite(Number(seenAt)) && clock() - Number(seenAt) >= 0 && clock() - Number(seenAt) <= HEARTBEAT_TTL_MS;

    async function handleState(message, sender) {
      const tabId = Number(sender?.tab?.id);
      if (!Number.isInteger(tabId)) return false;
      const at = Number.isFinite(Number(message?.at)) ? Number(message.at) : clock();
      const role = message?.role;
      const stored = await session.get(["skz.runnerSeenAt", "skz.armSeenAt", "skz.armSnapshot", "skz.observerSnapshot"]);
      const update = {};

      if (role === "runner") {
        update["skz.runnerTabId"] = tabId;
        update["skz.runnerSeenAt"] = at;
        update["skz.heartbeatAt"] = at;
        update["skz.activeRole"] = role;
        if (message.snapshot) { update["skz.runnerSnapshot"] = message.snapshot; update["skz.snapshot"] = message.snapshot; }
        if (Array.isArray(message.board)) update["skz.board"] = message.board;
      } else if (role === "arm-owner") {
        update["skz.armTabId"] = tabId;
        update["skz.armSeenAt"] = at;
        if (message.snapshot) update["skz.armSnapshot"] = message.snapshot;
        if (!fresh(stored["skz.runnerSeenAt"])) {
          update["skz.heartbeatAt"] = at;
          update["skz.activeRole"] = role;
          const snapshot = message.snapshot ?? stored["skz.armSnapshot"];
          if (snapshot) update["skz.snapshot"] = snapshot;
        }
      } else if (role === "shadow") {
        update["skz.shadowTabId"] = tabId;
        update["skz.shadowSeenAt"] = at;
        if (message.snapshot) update["skz.shadowSnapshot"] = message.snapshot;
        if (!fresh(stored["skz.runnerSeenAt"]) && !fresh(stored["skz.armSeenAt"])) {
          update["skz.heartbeatAt"] = at;
          update["skz.activeRole"] = "shadow";
          if (message.snapshot) update["skz.snapshot"] = message.snapshot;
        }
      } else {
        if (message.snapshot) update["skz.observerSnapshot"] = message.snapshot;
        if (!fresh(stored["skz.runnerSeenAt"]) && !fresh(stored["skz.armSeenAt"])) {
          update["skz.heartbeatAt"] = at;
          update["skz.activeRole"] = "observer";
          const snapshot = message.snapshot ?? stored["skz.observerSnapshot"];
          if (snapshot) update["skz.snapshot"] = snapshot;
        }
      }
      await session.set(update);
      return true;
    }

    async function targetTab(command) {
      const stored = await session.get(["skz.runnerTabId", "skz.runnerSeenAt", "skz.armTabId", "skz.armSeenAt", "skz.shadowTabId", "skz.shadowSeenAt"]);
      const runner = fresh(stored["skz.runnerSeenAt"]) && Number.isInteger(Number(stored["skz.runnerTabId"])) ? Number(stored["skz.runnerTabId"]) : null;
      const armOwner = fresh(stored["skz.armSeenAt"]) && Number.isInteger(Number(stored["skz.armTabId"])) ? Number(stored["skz.armTabId"]) : null;
      const shadow = fresh(stored["skz.shadowSeenAt"]) && Number.isInteger(Number(stored["skz.shadowTabId"])) ? Number(stored["skz.shadowTabId"]) : null;
      if (command === "arm") return armOwner ?? runner;
      if (command === "export") return runner ?? armOwner ?? shadow;
      return runner;
    }

    async function removeTab(tabId) {
      const stored = await session.get(["skz.runnerTabId", "skz.armTabId", "skz.armSeenAt", "skz.armSnapshot", "skz.shadowTabId"]);
      const removed = [];
      const update = {};
      if (Number(stored["skz.runnerTabId"]) === tabId) {
        removed.push("skz.runnerTabId", "skz.runnerSeenAt", "skz.runnerSnapshot");
        if (fresh(stored["skz.armSeenAt"]) && stored["skz.armSnapshot"]) {
          update["skz.snapshot"] = stored["skz.armSnapshot"];
          update["skz.heartbeatAt"] = stored["skz.armSeenAt"];
          update["skz.activeRole"] = "arm-owner";
        }
      }
      if (Number(stored["skz.armTabId"]) === tabId) removed.push("skz.armTabId", "skz.armSeenAt", "skz.armSnapshot");
      if (Number(stored["skz.shadowTabId"]) === tabId) removed.push("skz.shadowTabId", "skz.shadowSeenAt", "skz.shadowSnapshot");
      if (removed.length) await session.remove(removed);
      if (Object.keys(update).length) await session.set(update);
    }

    return { handleState, targetTab, removeTab };
  }

  function register(chromeApi) {
    const router = createStateRouter(chromeApi.storage.session);
    let stateQueue = Promise.resolve();
    const enqueue = (task) => { stateQueue = stateQueue.then(task, task); return stateQueue; };

    async function openCommandCenter() {
      const stored = await chromeApi.storage.session.get("skz.popupWindowId");
      const popupWindowId = Number(stored["skz.popupWindowId"]);
      if (Number.isInteger(popupWindowId)) {
        try { await chromeApi.windows.update(popupWindowId, { focused:true }); return popupWindowId; }
        catch { await chromeApi.storage.session.remove("skz.popupWindowId"); }
      }
      const popup = await chromeApi.windows.create({ url:chromeApi.runtime.getURL("extension/command-center.html"), type:"popup", width:1180, height:780, focused:true });
      if (Number.isInteger(popup.id)) await chromeApi.storage.session.set({ "skz.popupWindowId":popup.id });
      return popup.id ?? null;
    }

    chromeApi.windows.onRemoved.addListener((windowId) => {
      void chromeApi.storage.session.get("skz.popupWindowId").then((stored) => {
        if (Number(stored["skz.popupWindowId"]) === windowId) return chromeApi.storage.session.remove("skz.popupWindowId");
        return undefined;
      });
    });
    chromeApi.tabs.onRemoved.addListener((tabId) => { void enqueue(() => router.removeTab(tabId)); });
    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "version_handshake") {
        sendResponse({ ok:true, version:extensionVersion(chromeApi) });
        return false;
      }
      if (message?.type === "state") {
        void enqueue(() => router.handleState(message, sender)).then((ok) => sendResponse({ ok })).catch((error) => sendResponse({ ok:false, error:String(error?.message ?? error) }));
        return true;
      }
      if (message?.type === "open_command_center") {
        void openCommandCenter().then((windowId) => sendResponse({ ok:Number.isInteger(windowId), windowId })).catch((error) => sendResponse({ ok:false, error:String(error?.message ?? error) }));
        return true;
      }
      if (message?.type !== "command") return false;
      void enqueue(() => router.targetTab(message.command)).then((tabId) => {
        if (!Number.isInteger(tabId)) { sendResponse({ ok:false, error:message.command === "arm" ? "no_yahoo_arm_tab" : "no_yahoo_runner_tab" }); return; }
        chromeApi.tabs.sendMessage(tabId, message).then(sendResponse).catch((error) => sendResponse({ ok:false, error:String(error?.message ?? error) }));
      });
      return true;
    });
  }

  root.SKRODZKaiCommandCenterBackground = { HEARTBEAT_TTL_MS, createStateRouter, extensionVersion };
  if (root.chrome) register(root.chrome);
})(globalThis);
