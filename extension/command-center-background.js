(function commandCenterBackground(root) {
  "use strict";

  const HEARTBEAT_TTL_MS = 3000;
  const RELOAD_COOLDOWN_MS = 10000;
  const RUNTIME_BOOT_KEY = "skz.runtimeBoot";
  const RUNTIME_RELOAD_AT_KEY = "skz.runtimeReloadAt";
  const RUNTIME_FILES = Object.freeze([
    "manifest.json",
    "controller/yahoo-draft-controller.js",
    "controller/yahoo-mock-runner.js",
    "controller/yahoo-page-readers.js",
    "extension/command-center-background.js",
    "extension/command-center.css",
    "extension/command-center.html",
    "extension/command-center.js",
    "extension/yahoo-mock-board.js",
    "extension/yahoo-mock-extension.js",
    "extension/yahoo-real-shadow.js",
  ]);

  function extensionVersion(chromeApi) {
    return String(chromeApi.runtime.getManifest().version);
  }

  function hex(bytes) {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function sha256(value, cryptoApi = root.crypto, TextEncoderApi = root.TextEncoder) {
    const bytes = typeof value === "string" ? new TextEncoderApi().encode(value) : value;
    return hex(await cryptoApi.subtle.digest("SHA-256", bytes));
  }

  async function fetchRuntimeBytes(chromeApi, path) {
    const response = await fetch(chromeApi.runtime.getURL(path));
    if (!response?.ok) throw new Error(`runtime_file_unreadable:${path}`);
    return response.arrayBuffer();
  }

  async function runtimeDigest(chromeApi, readBytes = (path) => fetchRuntimeBytes(chromeApi, path), cryptoApi = root.crypto, TextEncoderApi = root.TextEncoder) {
    const entries = [];
    for (const path of RUNTIME_FILES) entries.push(`${path}:${await sha256(await readBytes(path), cryptoApi, TextEncoderApi)}`);
    return sha256(entries.join("\n"), cryptoApi, TextEncoderApi);
  }

  function validBootRecord(record, version = "") {
    return Boolean(
      record
      && String(record.version) === String(version)
      && /^[a-f0-9]{64}$/.test(String(record.digest ?? ""))
      && String(record.bootId ?? "").length >= 8
      && Number.isFinite(Number(record.bootedAt)),
    );
  }

  function createRuntimeAttestor(chromeApi, { clock = () => Date.now(), digest = () => runtimeDigest(chromeApi), randomId = () => root.crypto.randomUUID() } = {}) {
    let currentPromise = null;
    async function current() {
      if (currentPromise) return currentPromise;
      currentPromise = (async () => {
        const version = extensionVersion(chromeApi);
        const stored = await chromeApi.storage.session.get(RUNTIME_BOOT_KEY);
        const existing = stored[RUNTIME_BOOT_KEY];
        if (validBootRecord(existing, version)) return { ok:true, ...existing };
        const record = { version, digest:await digest(), bootId:String(randomId()), bootedAt:clock() };
        if (!validBootRecord(record, version)) throw new Error("runtime_attestation_invalid");
        await chromeApi.storage.session.set({ [RUNTIME_BOOT_KEY]:record });
        return { ok:true, ...record };
      })().catch((error) => {
        currentPromise = null;
        throw error;
      });
      return currentPromise;
    }
    return { current };
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
      } else {
        if (message.snapshot) update["skz.observerSnapshot"] = message.snapshot;
        if (!fresh(stored["skz.runnerSeenAt"]) && !fresh(stored["skz.armSeenAt"])) {
          update["skz.heartbeatAt"] = at;
          update["skz.activeRole"] = role === "shadow" ? "shadow" : "observer";
          const snapshot = message.snapshot ?? stored["skz.observerSnapshot"];
          if (snapshot) update["skz.snapshot"] = snapshot;
        }
      }
      await session.set(update);
      return true;
    }

    async function targetTab(command) {
      const stored = await session.get(["skz.runnerTabId", "skz.runnerSeenAt", "skz.armTabId", "skz.armSeenAt"]);
      const runner = fresh(stored["skz.runnerSeenAt"]) && Number.isInteger(Number(stored["skz.runnerTabId"])) ? Number(stored["skz.runnerTabId"]) : null;
      const armOwner = fresh(stored["skz.armSeenAt"]) && Number.isInteger(Number(stored["skz.armTabId"])) ? Number(stored["skz.armTabId"]) : null;
      if (command === "arm") return armOwner ?? runner;
      if (command === "export") return runner ?? armOwner;
      return runner;
    }

    async function removeTab(tabId) {
      const stored = await session.get(["skz.runnerTabId", "skz.armTabId", "skz.armSeenAt", "skz.armSnapshot"]);
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
      if (removed.length) await session.remove(removed);
      if (Object.keys(update).length) await session.set(update);
    }

    async function reloadGate(sender = {}) {
      const tabId = Number(sender?.tab?.id);
      let url;
      try { url = new URL(String(sender?.url ?? sender?.tab?.url ?? "")); }
      catch { return { ok:false, error:"reload_sender_url_invalid" }; }
      const permittedPath = url.protocol === "https:" && url.hostname === "football.fantasysports.yahoo.com"
        && (url.pathname === "/f1/mock_waiting"
          || url.pathname === "/f1/542830/settings"
          || url.pathname === "/f1/542830/draft"
          || url.pathname === "/f1/542830/3"
          || url.pathname === "/f1/542830/3/");
      if (!Number.isInteger(tabId) || !permittedPath) return { ok:false, error:"reload_sender_not_test_surface" };
      const stored = await session.get(["skz.runnerSeenAt", "skz.armSeenAt", "skz.armTabId", "skz.armSnapshot", RUNTIME_RELOAD_AT_KEY]);
      if (fresh(stored["skz.runnerSeenAt"])) return { ok:false, error:"reload_refused_runner_active" };
      if (fresh(stored["skz.armSeenAt"])) {
        if (Number(stored["skz.armTabId"]) !== tabId) return { ok:false, error:"reload_refused_other_arm_owner_active" };
        const context = stored["skz.armSnapshot"]?.context ?? {};
        if (context.armed || context.ownedTurn || context.autodraft) return { ok:false, error:"reload_refused_test_controls_active" };
      }
      const lastReloadAt = Number(stored[RUNTIME_RELOAD_AT_KEY] ?? 0);
      if (clock() - lastReloadAt < RELOAD_COOLDOWN_MS) return { ok:false, error:"reload_cooldown_active" };
      await session.set({ [RUNTIME_RELOAD_AT_KEY]:clock() });
      return { ok:true };
    }

    return { handleState, targetTab, removeTab, reloadGate };
  }

  function register(chromeApi) {
    void chromeApi.storage.session.setAccessLevel({ accessLevel:"TRUSTED_AND_UNTRUSTED_CONTEXTS" });
    const router = createStateRouter(chromeApi.storage.session);
    const attestor = createRuntimeAttestor(chromeApi);
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
        void attestor.current().then(sendResponse).catch((error) => sendResponse({ ok:false, error:String(error?.message ?? error) }));
        return true;
      }
      if (message?.type === "reload_extension") {
        void enqueue(() => router.reloadGate(sender)).then((result) => {
          sendResponse(result);
          if (result.ok) root.setTimeout(() => chromeApi.runtime.reload(), 50);
        }).catch((error) => sendResponse({ ok:false, error:String(error?.message ?? error) }));
        return true;
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

  root.SKRODZKaiCommandCenterBackground = {
    HEARTBEAT_TTL_MS,
    RELOAD_COOLDOWN_MS,
    RUNTIME_BOOT_KEY,
    RUNTIME_FILES,
    createStateRouter,
    createRuntimeAttestor,
    extensionVersion,
    runtimeDigest,
    sha256,
    validBootRecord,
    register,
  };
  if (root.chrome) register(root.chrome);
})(globalThis);
