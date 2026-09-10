// Replay viewer: steps through a saved game on the normal table, with the
// coach commenting on the moves you made.
import { OpenDeal, Game, Card, SUIT_CHARS, SUIT_NAMES, teamOfSeat } from './engine.js';
import { chooseBid, choosePlay } from './ai.js';
import { coachBid, coachPlay, reviewBid, reviewPlay } from './coach.js';
import { $, renderTable, resetTableCache, showScreen, setSheet, escapeHtml, explainSummary } from './view.js';
import { statesOf } from './history.js';

const rng = Math.random;
let R = null; // { rec, states, moves, k, coachCache, onExit }

function coachNames(rec) {
  const me = rec.mySeat, partner = (me + 2) % 4;
  return [0, 1, 2, 3].map((s) => (s === me ? 'you' : s === partner ? 'your partner' : rec.names[s]));
}

/// Coach text for step k: explains the recommended action at states[k] when
/// it was your turn, and reviews the move you actually made.
function coachAt(k) {
  if (R.coachCache[k] !== undefined) return R.coachCache[k];
  const st = R.states[k], move = R.moves[k];
  let html = null;
  if (st.game && (st.phase === 'auction' || st.phase === 'playout') && move && OpenDeal.currentPlayer(st.game.Deal) === R.rec.mySeat) {
    const info = Game.currentInfoSet(st.game);
    if (info.LegalActions.length > 1) {
      const names = coachNames(R.rec);
      if (st.phase === 'playout' && move.c !== undefined) {
        const rec = choosePlay(info, rng, 150);
        const c = coachPlay(info, rec, names);
        const rv = reviewPlay(rec, Number(move.c), c.short);
        html = rv ? rv : `You played the coach's choice. ${c.html.replace(/^Play the [^.]+\. /, '')}`;
        R.hintCache[k] = { card: rec.card };
      } else if (st.phase === 'auction' && move.b !== undefined) {
        const rec = chooseBid(info, rng, 150);
        const c = coachBid(info, rec, names);
        const rv = reviewBid(rec, Number(move.b), c.short);
        html = rv ? rv : `You chose the coach's bid. ${c.html.replace(/^(Pass|Bid \d)\. /, '')}`;
      }
    }
  }
  R.coachCache[k] = html;
  return html;
}

function summaryAt(st) {
  if (st.phase === 'dealOver' && st.lastDeal) return explainSummary(st.lastDeal, R.rec.teamNames);
  if (st.phase === 'gameOver') return `<b>Game over.</b> ${escapeHtml(R.rec.teamNames[st.winner])} win ${st.game.Score[0]}–${st.game.Score[1]}.`;
  return null;
}

function render() {
  const { rec, states, moves } = R;
  const k = R.k;
  const st = states[k];
  if (!st.game) return;
  const deal = st.game.Deal;
  const p = deal.ClosedDeal.Playout;
  // show a just-completed trick when the last move finished one
  let showTrick = null, trickWinner = null;
  const prev = states[k - 1];
  if (p && prev && prev.game && prev.game.Deal.ClosedDeal.Playout && st.dealNo === prev.dealNo) {
    const before = prev.game.Deal.ClosedDeal.Playout.CompletedTricks.length;
    if (p.CompletedTricks.length > before) { showTrick = p.CompletedTricks[p.CompletedTricks.length - 1]; trickWinner = showTrick.HighPlay.seat; }
  }
  const names = rec.names.map((n, s) => (s === rec.mySeat && n !== 'You' ? `${n} (you)` : n));
  const teamShort = rec.teamNames.map((n) => (n.includes(' + ')
    ? n.split(' + ').map((x) => x[0]).join('+')                                   // "East + West" -> "E+W"
    : n.split(' & ').map((x) => (x.length > 9 ? x.slice(0, 8) + '…' : x)).join(' & ')));
  const coach = coachAt(k);
  const summary = summaryAt(st);
  const hint = R.hintCache[k] || null;
  renderTable({
    mySeat: rec.mySeat, deal, handCounts: deal.Hands.map((h) => h.length), myHand: deal.Hands[rec.mySeat],
    names, connected: null, teamNames: teamShort, teamShort, score: st.game.Score, gamesWon: null, sets: null,
    showTrick, trickWinner, awaiting: null, hint, timerText: null, busy: true,
    prompt: `Move ${k} of ${moves.length} · Deal ${st.dealNo + 1}`, coach: coach || summary,
  });
  $('replayPos').textContent = `${k} / ${moves.length}`;
  $('replayPrev').disabled = k <= 1;
  $('replayNext').disabled = k >= moves.length;
}

function go(k) { R.k = Math.max(1, Math.min(R.moves.length, k)); render(); }

/// Index of the next/previous deal boundary from k.
function dealStep(dir) {
  const { states } = R;
  let k = R.k + dir;
  while (k > 1 && k < states.length && states[k].dealNo === states[R.k].dealNo) k += dir;
  if (dir < 0) { while (k > 1 && states[k - 1].dealNo === states[k].dealNo) k--; } // first move of that deal
  go(k);
}

export function openReplay(rec, onExit) {
  const moves = rec.moves || [];
  R = { rec, moves, states: statesOf(moves), k: 1, coachCache: {}, hintCache: {}, onExit };
  showScreen('table');
  resetTableCache();
  setSheet(null);
  $('chatBtn').hidden = true;
  $('replayBar').hidden = false;
  $('hand').onclick = null;
  $('bidPanel').onclick = null;
  $('menuBtn').onclick = () => exitReplay();
  $('replayPrev').onclick = () => go(R.k - 1);
  $('replayNext').onclick = () => go(R.k + 1);
  $('replayPrevDeal').onclick = () => dealStep(-1);
  $('replayNextDeal').onclick = () => dealStep(1);
  $('replayExit').onclick = () => exitReplay();
  // start at the first move you could act on, so the review is immediate
  let k = 1;
  while (k < moves.length && !(R.states[k].game && (R.states[k].phase === 'auction' || R.states[k].phase === 'playout')
    && OpenDeal.currentPlayer(R.states[k].game.Deal) === rec.mySeat)) k++;
  go(Math.min(k, moves.length));
}

export function exitReplay() {
  $('replayBar').hidden = true;
  $('coach').hidden = true;
  const cb = R && R.onExit;
  R = null;
  if (cb) cb();
}
