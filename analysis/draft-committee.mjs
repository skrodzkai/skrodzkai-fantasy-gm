import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function packetsFromReceipt(receipt, selectedRounds = [], board = []) {
  const allowedRounds = new Set(selectedRounds);
  const picks = receipt.status?.picks ?? [];
  const boardById = new Map(board.map((player) => [player.yahooId, player]));
  return (receipt.runnerReceipts ?? [])
    .filter((entry) => entry.kind === "runner_turn_resolved")
    .filter((entry) => !allowedRounds.size || allowedRounds.has(Number(String(entry.turn).match(/^R(\d+)P/)?.[1])))
    .map((entry) => {
      const round = Number(String(entry.turn).match(/^R(\d+)P/)?.[1]);
      const decision = entry.decision;
      const packet = {
        roomId: receipt.roomId,
        seat: receipt.seat,
        turn: entry.turn,
        round,
        nextPick: decision.nextPick,
        interveningOpponentPicks: decision.interveningOpponentPicks,
        rosterBefore: picks.slice(0, round - 1).map(({ yahooId, name, position, team }) => ({ yahooId, name, position, team })),
        candidates: decision.targetYahooIds.map((yahooId) => {
          const leader = decision.positionLeaders.find((entry) => entry.player.yahooId === yahooId);
          const player = boardById.get(yahooId) ?? leader?.player ?? {};
          return {
            yahooId,
            name: player.name ?? null,
            team: player.team ?? null,
            position: player.position ?? null,
            rank: player.rank ?? null,
            vor: player.vor ?? null,
            adpEarliest: player.adpEarliest ?? player.adpHigh ?? null,
            adpLatest: player.adpLatest ?? player.adpLow ?? null,
            comparatorYahooId: leader?.comparator?.yahooId ?? null,
            comparatorVor: leader?.comparator?.vor ?? null,
            availability: leader?.bucket ?? null,
            rawDropoff: leader?.rawScore ?? null,
            adjustedDropoff: leader?.adjustedScore ?? null,
            rosterFloorPass: leader?.floorPass ?? true,
          };
        }),
        baselineOrder: decision.targetYahooIds,
        baselineChoice: decision.chosenYahooId,
      };
      return { packetId: stableHash(packet), ...packet };
    });
}

export function validateBallot(packet, ballot) {
  if (!ballot || ballot.packetId !== packet.packetId) return { valid: false, reason: "packet_mismatch" };
  if (!Array.isArray(ballot.rankedYahooIds) || ballot.rankedYahooIds.length !== packet.candidates.length) {
    return { valid: false, reason: "incomplete_target_ranking" };
  }
  const available = new Set(packet.candidates.map((candidate) => candidate.yahooId));
  const unique = new Set(ballot.rankedYahooIds);
  if (unique.size !== ballot.rankedYahooIds.length) return { valid: false, reason: "duplicate_target" };
  if (ballot.rankedYahooIds.some((id) => !available.has(id))) return { valid: false, reason: "unavailable_target" };
  return { valid: true };
}

export function mergeBallots(packet, codexBallot, fableBallot, options = {}) {
  const deadlineMs = options.deadlineMs ?? 15_000;
  const codexElapsedMs = options.codexElapsedMs;
  const fableElapsedMs = options.fableElapsedMs;
  const codex = validateBallot(packet, codexBallot);
  const fable = validateBallot(packet, fableBallot);
  if (!codex.valid || !fable.valid) {
    return { source: "baseline", reason: `invalid_ballot:${codex.reason ?? "ok"}:${fable.reason ?? "ok"}`, rankedYahooIds: packet.baselineOrder };
  }
  if (![codexElapsedMs, fableElapsedMs].every((value) => Number.isFinite(value) && value >= 0)) {
    return { source: "baseline", reason: "invalid_latency", rankedYahooIds: packet.baselineOrder };
  }
  if (codexElapsedMs > deadlineMs || fableElapsedMs > deadlineMs) {
    return { source: "baseline", reason: "committee_deadline_missed", rankedYahooIds: packet.baselineOrder };
  }
  const scores = new Map(packet.candidates.map((candidate) => [candidate.yahooId, 0]));
  for (const ballot of [codexBallot, fableBallot]) {
    ballot.rankedYahooIds.forEach((id, index) => scores.set(id, scores.get(id) + Math.max(0, ballot.rankedYahooIds.length - index)));
  }
  const baselineRank = new Map(packet.baselineOrder.map((id, index) => [id, index]));
  const rankedYahooIds = Array.from(scores.keys()).sort((left, right) =>
    scores.get(right) - scores.get(left) ||
    (baselineRank.get(left) ?? 999) - (baselineRank.get(right) ?? 999)
  );
  return {
    source: "committee",
    reason: codexBallot.rankedYahooIds[0] === fableBallot.rankedYahooIds[0] ? "top_choice_agreement" : "borda_consensus",
    rankedYahooIds,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  if (!args.receipts || !args.output) throw new Error("usage: node analysis/draft-committee.mjs --receipts a.json,b.json --output packets.json");
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const rounds = (args.rounds ?? "1,4,8,13").split(",").map(Number);
  if (args.board) await import(pathToFileURL(args.board).href);
  const board = globalThis.SKRODZKaiYahooMockBoard?.offense ?? [];
  const packets = args.receipts.split(",").flatMap((file) => packetsFromReceipt(JSON.parse(readFileSync(file, "utf8")), rounds, board));
  writeFileSync(args.output, `${JSON.stringify({ generatedAt: new Date().toISOString(), packets }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ packets: packets.length, rounds })}\n`);
}
