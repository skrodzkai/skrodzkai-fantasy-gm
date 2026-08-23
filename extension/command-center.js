/* global chrome */
"use strict";

let state = null;
let board = [];
let selectedIds = new Set();

const $ = (selector) => document.querySelector(selector);
const elements = {
  connection: $("[data-connection]"), statusGrid: $("[data-status-grid]"), banner: $("[data-banner]"),
  roster: $("[data-roster]"), rosterCount: $("[data-roster-count]"), composition: $("[data-composition]"), latest: $("[data-latest]"),
  ladder: $("[data-ladder]"), ladderState: $("[data-ladder-state]"), pinState: $("[data-pin-state]"), pinStateLabel: $("[data-pin-state-label]"),
  search: $("[data-search]"), results: $("[data-player-search]"), clearSearch: $("[data-clear-search]"), clearPin: $("[data-clear-pin]"), pin: $("[data-pin]"),
  opponent: $("[data-opponent]"), warnings: $("[data-warnings]"), warningCount: $("[data-warning-count]"), events: $("[data-events]"),
  topTarget: $("[data-top-target]"), arm: $("[data-arm]"), kill: $("[data-kill]"), export: $("[data-export]"),
};

function text(value, fallback = "—") { return value == null || value === "" ? fallback : String(value); }
function esc(value, fallback = "—") { return text(value, fallback).replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]); }
function command(name, payload = null) { void chrome.runtime.sendMessage({ type: "command", command: name, payload }); }
function buttonState(button, control) { button.disabled = Boolean(control?.disabled); if (control?.text) button.textContent = control.text; }

function renderSearch() {
  const liveBoard = board;
  const query = elements.search.value.trim().toUpperCase();
  const matches = liveBoard.filter((player) => !query || `${player.name} ${player.position} ${player.team} ${player.yahooId}`.toUpperCase().includes(query)).slice(0, 12);
  elements.results.replaceChildren(...matches.map((player) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `player-result ${selectedIds.has(String(player.yahooId)) ? "selected" : ""}`.trim();
    const name = document.createElement("strong"); name.textContent = text(player.name, `Yahoo ${player.yahooId}`);
    const meta = document.createElement("span"); meta.textContent = `${text(player.position)} · ${text(player.team)} · Y!${player.yahooId}`;
    button.append(name, meta);
    button.addEventListener("click", () => { const id = String(player.yahooId); if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); renderSearch(); });
    return button;
  }));
  if (!matches.length) elements.results.textContent = "No verified Yahoo IDs match.";
  elements.pin.disabled = selectedIds.size === 0;
}

function render() {
  if (!state) return;
  document.querySelector(".connection")?.classList.add("live");
  elements.connection.textContent = "YAHOO LINK LIVE";
  const context = state.context ?? {};
  const statuses = [
    ["League", context.league], ["Room", context.roomId], ["Seat", context.seat], ["Round / Pick", context.round == null ? "— / —" : `R${context.round} / P${text(context.pick)}`],
    ["Clock", context.clockVerified ? context.clock ?? "--:--" : "--:-- · UNVERIFIED", "blue"], ["Armed", context.armed ? "YES" : "NO", context.armed ? "blue" : ""], ["Autodraft", context.autodraft ? "ON / BLOCKED" : "OFF", context.autodraft ? "red" : ""], ["Kill", context.kill ? "ENGAGED" : "READY", context.kill ? "red" : ""],
  ];
  elements.statusGrid.innerHTML = statuses.map(([label,value,kind=""]) => `<div class="stat"><label>${label}</label><strong class="${kind}">${esc(value)}</strong></div>`).join("");
  elements.banner.className = `banner ${state.kind ?? "neutral"}`; elements.banner.querySelector("strong").textContent = text(state.label,"LOCKED"); elements.banner.querySelector("span").textContent = text(state.detail,"Waiting for a verified draft surface.");

  const roster = Array.isArray(state.roster) ? state.roster : [];
  elements.roster.innerHTML = roster.map((slot) => `<div class="slot ${slot.player ? "" : "open"}"><span>${esc(slot.slot)}</span><b>${slot.player ? esc(slot.player.name) : "OPEN"}</b></div>`).join("");
  elements.rosterCount.textContent = `${roster.filter((slot) => slot.player).length} / ${roster.length || 15}`;
  const counts = roster.filter((slot) => slot.player).reduce((map,slot) => { const p = String(slot.player.position ?? "").toUpperCase(); map[p]=(map[p]??0)+1; return map; },{});
  elements.composition.innerHTML = ["QB","RB","WR","TE","K","DEF","IDP"].map((p) => `<span class="pill">${p} <b>${p === "IDP" ? (counts.D??0)+(counts.LB??0)+(counts.CB??0)+(counts.S??0) : counts[p]??0}</b></span>`).join("");
  elements.latest.textContent = text(state.latestText,"No confirmed selection yet.");

  const ladder = Array.isArray(state.recommendations) ? state.recommendations : [];
  elements.ladder.innerHTML = ladder.length ? ladder.slice(0,6).map((player,index) => `<div class="ladder-row ${player.manual ? "pinned" : ""}"><div class="rank">${player.manual ? "PIN" : index === 0 ? "GO" : `F${index}`}</div><div><div class="player">${esc(player.name,`Yahoo ${player.yahooId}`)}</div><div class="meta">${esc(player.position)} · ${esc(player.team)}</div><div class="reason">${esc(player.reason,"verified local ladder")}</div></div><div class="score">${esc(player.edge)}<br>${esc(player.confidence)}</div></div>`).join("") : `<div class="ladder-empty">Ladder resolves on our owned turn after Yahoo availability is validated.</div>`;
  elements.ladderState.textContent = text(state.ladderState,"BASELINE READY");
  elements.topTarget.textContent = ladder[0] ? `${text(ladder[0].name)} · ${text(ladder[0].position)} · ${text(ladder[0].edge)}` : "Waiting for Yahoo availability";
  elements.pinState.textContent = text(state.pinText,"No pin staged. Five verified fallbacks remain active.");
  elements.pinStateLabel.textContent = text(state.pinLabel,"BASELINE");
  elements.clearPin.disabled = !state.pinned;

  const info = state.between ?? {};
  const atRisk = Array.isArray(info.atRisk) && info.atRisk.length ? info.atRisk.map((entry) => esc(entry)).join(", ") : "Targets withheld until Yahoo availability is read.";
  elements.opponent.innerHTML = `<div class="window-grid"><div class="window-cell"><label>Current</label><strong>${esc(info.currentPick)}</strong></div><div class="window-cell"><label>Next ours</label><strong>${esc(info.nextPick)}</strong></div><div class="window-cell"><label>Between</label><strong>${esc(info.intervening)}</strong></div></div><div class="pressure"><strong>At risk:</strong> ${atRisk}</div><div class="manager-note">${esc(info.managerNote,"Public-room behavior only.")}</div>`;
  const warnings = Array.isArray(state.warnings) ? state.warnings : []; elements.warningCount.textContent=String(warnings.length); elements.warnings.innerHTML=warnings.length?warnings.map((warning)=>`<div class="warning ${warning.severity==="danger"?"danger":""}">● ${esc(warning.text??warning)}</div>`).join(""):`<div class="empty">No active warnings.</div>`;
  const events = Array.isArray(state.events) ? state.events : []; elements.events.innerHTML=events.length?events.map((event)=>`<div class="event">${esc(event.at)} <b>${esc(event.kind)}</b>${event.detail?` · ${esc(event.detail)}`:""}</div>`).join(""):`<div class="empty">No receipts yet.</div>`;
  buttonState(elements.arm,state.controls?.arm); buttonState(elements.kill,state.controls?.halt); buttonState(elements.export,state.controls?.export);
  renderSearch();
}

function updateConnection() {
  const connection = document.querySelector(".connection");
  const age = state?.at ? Date.now() - Number(state.at) : Infinity;
  const runnerMissing = age > 3000;
  connection?.classList.toggle("live", age <= 1500);
  elements.connection.textContent = age <= 1500 ? `LIVE ${(age / 1000).toFixed(1)}s` : age <= 3000 ? `STALE ${(age / 1000).toFixed(1)}s` : "NO YAHOO RUNNER";
  document.body.classList.toggle("offline", runnerMissing);
  if (runnerMissing) {
    [elements.arm, elements.kill, elements.export, elements.clearPin, elements.pin, elements.search, elements.clearSearch].forEach((control) => { control.disabled = true; });
  }
}

void chrome.storage.session.get(["skz.snapshot", "skz.board"]).then((stored) => {
  state = stored["skz.snapshot"] ?? null;
  board = Array.isArray(stored["skz.board"]) ? stored["skz.board"] : [];
  render(); updateConnection();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes["skz.snapshot"]) state = changes["skz.snapshot"].newValue ?? null;
  if (changes["skz.board"]) board = Array.isArray(changes["skz.board"].newValue) ? changes["skz.board"].newValue : [];
  render(); updateConnection();
});
setInterval(updateConnection, 500);
elements.search.addEventListener("input",renderSearch);
elements.clearSearch.addEventListener("click",()=>{elements.search.value="";selectedIds.clear();renderSearch();});
elements.arm.addEventListener("click",()=>command("arm"));
elements.kill.addEventListener("click",()=>command("kill"));
elements.export.addEventListener("click",()=>command("export"));
elements.clearPin.addEventListener("click",()=>command("clear_pin"));
elements.pin.addEventListener("click",()=>{const targets=board.filter((player)=>selectedIds.has(String(player.yahooId)));command("pin",{targets});selectedIds.clear();renderSearch();});
