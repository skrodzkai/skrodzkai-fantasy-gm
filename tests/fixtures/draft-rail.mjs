// Existing _controlApi seam: observe production boot/status/command handlers
// without pretending this is a rendered browser or a Yahoo execution receipt.
export function makeDraftRail() {
  const state = { mode:"UNKNOWN", context:{}, label:"LOCKED", board:[], attestation:null, locked:false };
  const control = () => ({ disabled:true, textContent:"", addEventListener(_event, handler) { this.handler = handler; } });
  const rail = {
    controls:Object.fromEntries(["arm", "export", "halt", "dock", "reload"].map((name) => [name, control()])),
    getSnapshot:() => state,
    setMode:(mode) => { state.mode = mode; },
    setContext:(context) => { Object.assign(state.context, context); },
    render:(_kind, label, detail) => { Object.assign(state, { label, detail }); },
    lock:(detail, label = "EXTENSION RELOAD REQUIRED") => { Object.assign(state, { locked:true, label, detail }); rail.controls.arm.disabled = true; },
    isLocked:() => state.locked,
    setAttestation:(attestation) => { state.attestation = attestation; },
    setBoard:(board) => { state.board = board; },
    setManualHandler(handler) { rail.manual = handler; }, setPinned() {}, setPinOutcome() {},
    setReloadHandler() {}, setOpenHandler() {}, setExpanded() {}, setRoster() {}, setBetweenTurns() {}, setWarnings() {}, setRecommendations() {}, addEvent() {},
  };
  return { state, rail };
}
