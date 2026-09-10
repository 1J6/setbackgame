// Multiplayer game state as a move log.
//
// A room stores an append-only list of small moves instead of the game state:
//   { d: seed, l?: dealer, t }   deal: the first deal of a game (with the dealer),
//                                the next deal after a finished one, or a rematch
//   { b: bid, t, d?: seed }      a bid; the seed is required when the bid ends an
//                                all-pass auction, because the hand is redealt
//   { c: card, t }               a card played
// `t` is the store's clock when the move was made. Every phone replays the log
// through the (deterministic) engine to get the current state; the shuffle is
// driven by the seed so all phones deal identical hands. Moves are appended one
// per slot, so a phone that acts on a stale state finds its slot taken.
import { Bid, seatIncr, OpenDeal, Game } from './engine.js';
import { judgeDeal, emptyStats, addDealStats } from './rules.js';

/// Small deterministic PRNG (mulberry32) for seeded shuffles.
export function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const newSeed = () => Math.floor(Math.random() * 4294967296);

/// The store may hand back the move list as an array or as an object keyed by
/// index; normalise to a dense array, stopping at the first gap.
export function movesArray(m) {
  if (!m) return [];
  const out = [];
  for (let i = 0; ; i++) {
    const x = m[i];
    if (x === undefined || x === null) break;
    out.push(x);
  }
  return out;
}

export function emptyState() {
  return {
    seq: 0, game: null, phase: 'none', dealNo: -1, gameNo: 0,
    scoreBefore: [0, 0], lastDeal: null, winner: null, reason: null, notice: null, lastT: 0,
    stats: { game: emptyStats(), total: { ...emptyStats(), games: [0, 0] } },
  };
}

const cloneStats = (s) => ({
  game: { points: s.game.points.slice(), sets: s.game.sets.slice() },
  total: { points: s.total.points.slice(), sets: s.total.sets.slice(), games: s.total.games.slice() },
});

/// Applies one move. Returns a new state; throws with a reason if the move is
/// not legal in this state (used for validation before appending).
export function apply(st, move) {
  if (!move || typeof move !== 'object') throw new Error('malformed move');
  const t = Number(move.t) || 0;
  const next = { ...st, stats: cloneStats(st.stats), seq: st.seq + 1, lastT: t, notice: null };

  if (move.b !== undefined) {
    if (st.phase !== 'auction') throw new Error('not bidding');
    const bid = Number(move.b);
    const info = Game.currentInfoSet(st.game);
    if (!info.LegalActions.some((a) => a.bid === bid)) throw new Error('illegal bid');
    let g = Game.addAction({ bid }, st.game);
    if (OpenDeal.isComplete(g.Deal) && g.Deal.ClosedDeal.Auction.HighBid === Bid.Pass) {
      if (move.d === undefined) throw new Error('all-pass redeal needs a seed');
      g = Game.startNextDeal(seededRng(Number(move.d)), g);
      next.dealNo = st.dealNo + 1;
      next.notice = { id: t, text: 'Everyone passed — dealing again' };
      next.phase = 'auction';
    } else {
      next.phase = g.Deal.ClosedDeal.Playout ? 'playout' : 'auction';
    }
    next.game = g;
    return next;
  }

  if (move.c !== undefined) {
    if (st.phase !== 'playout') throw new Error('not playing');
    const card = Number(move.c);
    const info = Game.currentInfoSet(st.game);
    if (!info.LegalActions.some((a) => a.card === card)) throw new Error('illegal card');
    const g = Game.addAction({ card }, st.game);
    next.game = g;
    if (OpenDeal.isComplete(g.Deal)) {
      const judged = judgeDeal(st.scoreBefore, g.Deal.ClosedDeal);
      next.lastDeal = judged;
      addDealStats(next.stats.game, judged);
      addDealStats(next.stats.total, judged);
      if (judged.winner !== null) {
        next.phase = 'gameOver';
        next.winner = judged.winner;
        next.reason = judged.reason;
        next.stats.total.games[judged.winner] += 1;
      } else {
        next.phase = 'dealOver';
      }
    } else {
      next.phase = 'playout';
    }
    return next;
  }

  if (move.d !== undefined) {
    const rng = seededRng(Number(move.d));
    if (st.phase === 'none' || st.phase === 'gameOver') {
      // first deal of a game, or a rematch with the same seats
      const dealer = move.l !== undefined ? Number(move.l)
        : st.game ? seatIncr(1, st.game.Deal.ClosedDeal.Auction.Dealer) : 0;
      if (!(dealer >= 0 && dealer < 4)) throw new Error('bad dealer');
      next.game = Game.create(rng, dealer);
      next.gameNo = st.phase === 'gameOver' ? st.gameNo + 1 : st.gameNo;
      next.stats.game = emptyStats();
      next.scoreBefore = [0, 0];
    } else if (st.phase === 'dealOver') {
      next.game = Game.startNextDeal(rng, st.game);
      next.scoreBefore = next.game.Score.slice();
    } else {
      throw new Error('cannot deal now');
    }
    next.dealNo = st.dealNo + 1;
    next.phase = 'auction';
    next.lastDeal = null;
    next.winner = null;
    next.reason = null;
    return next;
  }

  throw new Error('unknown move');
}

/// null if the move is legal in this state, otherwise the reason.
export function validate(st, move) {
  try { apply(st, move); return null; } catch (e) { return e.message; }
}

/// Replays a move list from scratch. Stops at the first illegal move (which
/// only happens if the log was tampered with) and reports it.
export function replay(moves) {
  let st = emptyState();
  for (const m of movesArray(moves)) {
    try { st = apply(st, m); } catch (e) { st.corrupt = e.message; break; }
  }
  return st;
}
