// Move-log replay: a full game appended move by move must replay to the same
// state, illegal moves must be rejected, and dealing from a seed must be
// deterministic.
import * as E from '../engine.js';
import * as AI from '../ai.js';
import { replay, apply, validate, movesArray, emptyState, seededRng } from '../replay.js';
const { Game, OpenDeal, Bid, Card } = E;

let fails = 0;
const assert = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const rng = seededRng(99);

// seeded shuffle is deterministic
const g1 = Game.create(seededRng(12345), 2), g2 = Game.create(seededRng(12345), 2);
eq(g1.Deal.Hands, g2.Deal.Hands, 'same seed, same hands');
assert(JSON.stringify(Game.create(seededRng(12346), 2).Deal.Hands) !== JSON.stringify(g1.Deal.Hands), 'different seed, different hands');

// play two full games through the log, one move at a time
const moves = [];
let st = emptyState();
let t = 1000;
const push = (m) => { m.t = t++; const why = validate(st, m); assert(why === null, `move rejected: ${why} ${JSON.stringify(m)}`); st = apply(st, m); moves.push(m); };
assert(validate(st, { b: 2, t }) !== null, 'cannot bid before a deal');
assert(validate(st, { c: 5, t }) !== null, 'cannot play before a deal');
push({ d: 7, l: 1 });
eq(st.phase, 'auction', 'first deal starts the auction');
eq(st.game.Deal.ClosedDeal.Auction.Dealer, 1, 'dealer from the move');
let games = 0, allPass = 0, dealsSeen = 0;
while (games < 2) {
  if (st.phase === 'dealOver') { dealsSeen++; assert(validate(st, { c: 0, t }) !== null, 'no play at dealOver'); push({ d: Math.floor(rng() * 1e9) }); continue; }
  if (st.phase === 'gameOver') {
    games++;
    assert(validate(st, { b: 0, t }) !== null, 'no bid at gameOver');
    if (games < 2) { const prevDealer = st.game.Deal.ClosedDeal.Auction.Dealer; push({ d: Math.floor(rng() * 1e9) }); eq(st.game.Deal.ClosedDeal.Auction.Dealer, (prevDealer + 1) % 4, 'rematch dealer rotates'); eq(st.gameNo, 1, 'game number'); eq(st.game.Score, [0, 0], 'rematch resets the score'); }
    continue;
  }
  const info = Game.currentInfoSet(st.game);
  const act = info.LegalActions.length === 1 ? info.LegalActions[0] : AI.policyAction(info, rng);
  if (act.bid !== undefined) {
    const a = st.game.Deal.ClosedDeal.Auction;
    const m = { b: act.bid };
    if (act.bid === Bid.Pass && a.HighBid === Bid.Pass && a.Bids.length === 3) {
      assert(validate(st, { b: 0, t }) !== null, 'all-pass needs a seed');
      m.d = Math.floor(rng() * 1e9); allPass++;
    }
    // an illegal bid is refused
    const bad = [0, 2, 3, 4].find((b) => !info.LegalActions.some((x) => x.bid === b));
    if (bad !== undefined) assert(validate(st, { b: bad, t }) !== null, 'illegal bid refused');
    push(m);
  } else {
    const hand = st.game.Deal.Hands[info.Player];
    const notLegal = hand.find((c) => !info.LegalActions.some((x) => x.card === c));
    if (notLegal !== undefined) assert(validate(st, { c: notLegal, t }) !== null, 'card not legal refused');
    const notHeld = [...Array(52).keys()].find((c) => !hand.includes(c));
    assert(validate(st, { c: notHeld, t }) !== null, 'card not held refused');
    push({ c: act.card });
  }
}
assert(dealsSeen > 3, 'several deals played');
console.log(`log: ${moves.length} moves, ${dealsSeen + 2} deals, ${allPass} all-pass redeals, ${JSON.stringify(moves).length} bytes total (${(JSON.stringify(moves).length / moves.length).toFixed(0)} per move)`);

// replaying the whole log from scratch gives the same state
const re = replay(moves);
eq(re.seq, st.seq, 'seq');
eq(re.phase, st.phase, 'phase');
eq(re.game.Score, st.game.Score, 'score');
eq(re.stats, st.stats, 'stats');
eq(re.game.Deal.Hands, st.game.Deal.Hands, 'hands');
assert(!re.corrupt, 'no corruption');

// object-keyed and gapped logs normalise; a tampered log stops at the bad move
const obj = {}; moves.forEach((m, i) => { obj[String(i)] = m; });
eq(replay(obj).seq, st.seq, 'object-keyed log');
const gapped = { 0: moves[0], 1: moves[1], 3: moves[3] };
eq(movesArray(gapped).length, 2, 'stops at gap');
const tampered = moves.slice(0, 5).concat([{ c: 999, t: 1 }]);
assert(replay(tampered).corrupt, 'tampered log flagged');
eq(replay(tampered).seq, 5, 'state before the bad move kept');

if (fails) { console.error(`${fails} replay test(s) failed`); process.exit(1); }
console.log('REPLAY OK');
