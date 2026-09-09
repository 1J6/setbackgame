import * as E from '../engine.js';
import * as AI from '../ai.js';

const { Card, Rank, Suit, Bid, Seat, Team, Auction, Trick, Playout, ClosedDeal, OpenDeal, Game, Score } = E;

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('FAIL:', msg); } }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); }

// seeded rng
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const C = (s) => Card.fromString(s);

// --- cards
eq(Card.toString(C('AS')), 'A♠', 'card str');
eq(Card.rank(C('TD')), 10, 'rank');
eq(Card.suit(C('TD')), Suit.Diamonds, 'suit');
eq(C('2C'), 0, '2C index'); eq(C('AS'), 51, 'AS index');

// --- auction
let a = Auction.create(Seat.South);
eq(Auction.currentBidder(a), Seat.West, 'first bidder is left of dealer');
eq(Auction.legalBids(a), [0, 2, 3, 4], 'legal bids initially');
a = Auction.addBid(Bid.Two, a);           // West bids 2
eq(Auction.legalBids(a), [0, 3, 4], 'after 2');
a = Auction.addBid(Bid.Pass, a);          // North passes
a = Auction.addBid(Bid.Four, a);          // East bids 4
eq(Auction.legalBids(a), [0, 4], 'dealer may steal 4');
eq(Auction.currentBidder(a), Seat.South, 'dealer bids last');
a = Auction.addBid(Bid.Four, a);          // South steals
assert(Auction.isComplete(a), 'auction complete');
eq(a.HighBidder, Seat.South, 'steal takes high bidder');
eq(a.HighBid, 4, 'high bid 4');
// non-dealer cannot bid 4 over 4
let a2 = Auction.create(Seat.South);
a2 = Auction.addBid(Bid.Four, a2);
eq(Auction.legalBids(a2), [0], 'north cannot outbid 4');
a2 = Auction.addBid(Bid.Pass, a2);
eq(Auction.legalBids(a2), [0], 'east cannot outbid 4');
a2 = Auction.addBid(Bid.Pass, a2);
eq(Auction.legalBids(a2), [0, 4], 'dealer steal available');
eq(Auction.playerBids(a2), [[0, 4], [1, 0], [2, 0]], 'playerBids chronological');

// --- trick
let t = Trick.create(Seat.North);
const trump = Suit.Spades;
t = Trick.addPlay(trump, C('KH'), t);
t = Trick.addPlay(trump, C('AH'), t);
t = Trick.addPlay(trump, C('2S'), t);   // low trump beats ace of hearts
t = Trick.addPlay(trump, C('AD'), t);   // off suit
assert(Trick.isComplete(t), 'trick complete');
eq(t.HighPlay.seat, Seat.South, '2S (South) wins');
eq(t.SuitLed, Suit.Hearts, 'suit led');

// --- full deal with known hands: check scoring
// Dealer South; hands: W,N,E,S
const hands = [
  ['AS', 'JS', 'TH', '3C', '4D', '9H'].map(C), // West
  ['KS', '2S', 'AH', 'TC', '5D', '8H'].map(C), // North
  ['QS', '3S', 'KH', 'TD', '6D', '7H'].map(C), // East
  ['9S', '4S', 'QH', 'JC', 'AD', '2H'].map(C), // South
];
let deal = OpenDeal.fromHands(Seat.South, hands);
deal = OpenDeal.addBid(Bid.Three, deal);  // West bids 3
deal = OpenDeal.addBid(Bid.Pass, deal);
deal = OpenDeal.addBid(Bid.Pass, deal);
deal = OpenDeal.addBid(Bid.Pass, deal);
eq(OpenDeal.currentPlayer(deal), Seat.West, 'bidder leads');
eq(deal.ClosedDeal.Playout.Bidder, Seat.West, 'bidder');
// West leads AS -> trump spades. N: 2S, E: 3S, S: 4S
deal = OpenDeal.addPlay(C('AS'), deal);
eq(deal.ClosedDeal.Playout.Trump, Suit.Spades, 'trump established');
eq(Playout.legalPlays(deal.Hands[Seat.North], deal.ClosedDeal.Playout).map(Card.toString).sort(), ['2♠', 'K♠'], 'must follow trump');
deal = OpenDeal.addPlay(C('2S'), deal);
deal = OpenDeal.addPlay(C('3S'), deal);
deal = OpenDeal.addPlay(C('4S'), deal);
let p = deal.ClosedDeal.Playout;
eq(p.CompletedTricks.length, 1, 'one trick done');
eq(p.HighTrump, { rank: 14, team: Team.EastWest }, 'high so far A to EW');
eq(p.LowTrump, { rank: 2, team: Team.EastWest }, 'low so far 2 to EW');
eq(p.GameScore, [4, 0], 'game points: ace = 4');
eq(Playout.currentPlayer(p), Seat.West, 'winner leads');
// West leads JS; North KS wins; East QS; South 9S
deal = OpenDeal.addPlay(C('JS'), deal);
deal = OpenDeal.addPlay(C('KS'), deal);
deal = OpenDeal.addPlay(C('QS'), deal);
deal = OpenDeal.addPlay(C('9S'), deal);
p = deal.ClosedDeal.Playout;
eq(p.JackTrumpTeam, Team.NorthSouth, 'NS captured jack');
eq(p.GameScore, [4, 1 + 3 + 2], 'game points after trick 2');
eq(Playout.currentPlayer(p), Seat.North, 'North leads trick 3');
// North leads AH; East KH; South QH; West TH (W follows hearts)
deal = OpenDeal.addPlay(C('AH'), deal);
deal = OpenDeal.addPlay(C('KH'), deal);
deal = OpenDeal.addPlay(C('QH'), deal);
deal = OpenDeal.addPlay(C('TH'), deal);
p = deal.ClosedDeal.Playout;
eq(p.GameScore, [4, 6 + 4 + 3 + 2 + 10], 'NS take big heart trick');
// North leads TC; East (no clubs: TD,6D,7H) plays 7H -> void in clubs recorded; South JC; West 3C
deal = OpenDeal.addPlay(C('TC'), deal);
eq(Playout.legalPlays(deal.Hands[Seat.East], deal.ClosedDeal.Playout).length, 3, 'east may play anything');
deal = OpenDeal.addPlay(C('7H'), deal);
assert(Playout.isVoid(deal.ClosedDeal.Playout, Seat.East, Suit.Clubs), 'east void in clubs');
assert(!Playout.isVoid(deal.ClosedDeal.Playout, Seat.East, Suit.Hearts), 'east not void in hearts');
deal = OpenDeal.addPlay(C('JC'), deal);
deal = OpenDeal.addPlay(C('3C'), deal);
p = deal.ClosedDeal.Playout;
eq(p.CompletedTricks[3].HighPlay.seat, Seat.South, 'JC beats TC');
eq(Playout.currentPlayer(p), Seat.South, 'south leads');
// South leads AD; West 4D; North 5D; East TD
deal = OpenDeal.addPlay(C('AD'), deal);
deal = OpenDeal.addPlay(C('4D'), deal);
deal = OpenDeal.addPlay(C('5D'), deal);
deal = OpenDeal.addPlay(C('TD'), deal);
// South leads 2H; West 9H; North 8H; East 6D (void hearts? East has 6D only -> plays 6D, void in hearts recorded)
deal = OpenDeal.addPlay(C('2H'), deal);
deal = OpenDeal.addPlay(C('9H'), deal);
deal = OpenDeal.addPlay(C('8H'), deal);
deal = OpenDeal.addPlay(C('6D'), deal);
assert(OpenDeal.isComplete(deal), 'deal complete');
p = deal.ClosedDeal.Playout;
eq(p.CurrentTrick, null, 'no current trick');
const raw = Playout.getRawDealScore(p);
// High: A♠ EW; Low: 2♠ EW (taken by West); Jack: NS; Game: EW 4 + 0 + ... let's compute
console.log('raw score', raw, 'game pts', p.GameScore);
const ds = ClosedDeal.getDealScore(deal.ClosedDeal);
console.log('deal score (West bid 3)', ds);
assert(ds[Team.EastWest] === (raw[0] >= 3 ? raw[0] : -3), 'setback penalty applied correctly');

// --- random full games: invariants
const rng = mulberry32(12345);
let games = 0, deals = 0, allPass = 0;
const t0 = Date.now();
for (let g = 0; g < 300; g++) {
  let game = Game.create(rng, g % 4);
  let dealsThisGame = 0;
  while (true) {
    const info = Game.currentInfoSet(game);
    assert(info.LegalActions.length > 0, 'legal actions non-empty');
    // random play, but bid mostly Pass/Two so games actually end
    let act = info.LegalActions[Math.floor(rng() * info.LegalActions.length)];
    if (act.bid !== undefined && act.bid > 2 && rng() < 0.9) act = info.LegalActions[0];
    if (act.card !== undefined) assert(info.Hand.includes(act.card), 'card in hand');
    game = Game.addAction(act, game);
    if (OpenDeal.isComplete(game.Deal)) {
      deals++;
      const cd = game.Deal.ClosedDeal;
      if (cd.Auction.HighBid === 0) allPass++;
      else {
        const r = Playout.getRawDealScore(cd.Playout);
        assert(r[0] + r[1] <= 4 && r[0] + r[1] >= 2, 'raw points between 2 and 4: ' + r); // high+low always awarded
        for (const h of game.Deal.Hands) assert(h.length === 0, 'all cards played');
      }
      const w = Game.tryGetWinningTeam(game);
      if (w !== null) { games++; break; }
      if (++dealsThisGame > 400) break;
      game = Game.startNextDeal(rng, game);
    }
  }
}
console.log(`random play: ${games} games, ${deals} deals, ${allPass} all-pass, ${Date.now() - t0}ms`);

// --- AI smoke + timing
const rng2 = mulberry32(777);
let game = Game.create(rng2, 0);
let nBid = 0, nPlay = 0, tBid = 0, tPlay = 0;
while (nPlay < 60) {
  const info = Game.currentInfoSet(game);
  const s = Date.now();
  const { action } = AI.chooseAction(info, rng2, 64);
  const dt = Date.now() - s;
  if (action.bid !== undefined) { nBid++; tBid += dt; } else { nPlay++; tPlay += dt; }
  assert(info.LegalActions.some((la) => JSON.stringify(la) === JSON.stringify(action)), 'AI action legal');
  game = Game.addAction(action, game);
  if (OpenDeal.isComplete(game.Deal)) {
    if (Game.tryGetWinningTeam(game) !== null) game = Game.create(rng2, 1);
    else game = Game.startNextDeal(rng2, game);
  }
}
console.log(`AI timing: bids ${nBid} avg ${(tBid / Math.max(1, nBid)).toFixed(1)}ms; plays ${nPlay} avg ${(tPlay / nPlay).toFixed(1)}ms`);

// --- strength: MC AI (E+W) vs policy baseline (N+S)
const rng3 = mulberry32(2024);
let ewWins = 0; const N = parseInt(process.argv[2] || '40');
const t1 = Date.now();
for (let g = 0; g < N; g++) {
  let gm = Game.create(rng3, g % 4);
  while (true) {
    const info = Game.currentInfoSet(gm);
    let act;
    if (info.LegalActions.length === 1) act = info.LegalActions[0];
    else if (E.teamOfSeat(info.Player) === Team.EastWest) act = AI.chooseAction(info, rng3, 32).action;
    else act = AI.policyAction(info, rng3);
    gm = Game.addAction(act, gm);
    if (OpenDeal.isComplete(gm.Deal)) {
      const w = Game.tryGetWinningTeam(gm);
      if (w !== null) { if (w === Team.EastWest) ewWins++; break; }
      gm = Game.startNextDeal(rng3, gm);
    }
  }
}
console.log(`strength: MC AI won ${ewWins}/${N} vs baseline (${Date.now() - t1}ms)`);

console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
