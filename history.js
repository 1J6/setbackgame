// Game history and personal stats, kept on this device.
//
// A record is a finished game as a move log (see replay.js) plus who sat
// where, so it can be replayed and reviewed later:
//   { id, t, mode: 'single'|'multi'|'quick', mySeat, names[4], teamNames[2],
//     moves[], winner, score[2], reason }
import { Bid, teamOfSeat, otherTeam, Playout, ClosedDeal } from './engine.js';
import { replay, apply, emptyState, movesArray } from './replay.js';

const KEY = 'lis-setback-history-v1';
const MAX = 30;

export function loadHistory() {
  try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

function store(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* full or private mode */ }
}

export function saveGameRecord(rec) {
  const list = loadHistory().filter((r) => r.id !== rec.id);
  list.unshift(rec);
  store(list.slice(0, MAX));
}

export function deleteGameRecord(id) { store(loadHistory().filter((r) => r.id !== id)); }
export function clearHistory() { store([]); }

/// All states of a game, one per move (states[k] is after k moves).
export function statesOf(moves) {
  const out = [emptyState()];
  for (const m of movesArray(moves)) {
    try { out.push(apply(out[out.length - 1], m)); } catch { break; }
  }
  return out;
}

/// Personal statistics across the saved games.
export function computeStats(list) {
  const s = {
    games: 0, won: 0, deals: 0, byMode: { single: 0, multi: 0, quick: 0 },
    bids: { won: 0, made: 0, set: 0 }, myPoints: 0, theirPoints: 0, bestScore: null,
  };
  for (const rec of list) {
    const team = teamOfSeat(rec.mySeat), opp = otherTeam(team);
    s.games++;
    if (rec.winner === team) s.won++;
    s.byMode[rec.mode] = (s.byMode[rec.mode] || 0) + 1;
    let st = emptyState();
    for (const m of movesArray(rec.moves)) {
      let next;
      try { next = apply(st, m); } catch { break; }
      if (next.lastDeal && next.lastDeal !== st.lastDeal && !next.lastDeal.allPass) {
        const j = next.lastDeal;
        s.deals++;
        s.myPoints += j.raw[team]; s.theirPoints += j.raw[opp];
        if (j.bidder === rec.mySeat) { s.bids.won++; if (j.set) s.bids.set++; else s.bids.made++; }
      }
      st = next;
    }
    if (rec.score && (s.bestScore === null || rec.score[team] > s.bestScore)) s.bestScore = rec.score[team];
  }
  return s;
}

export const fmtDate = (t) => {
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
