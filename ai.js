// Computer players for Setback.
//
// Brian Berns' original game asks a server-side neural network (trained with
// Deep CFR) for every bid and play. Those weights are not published, so this
// page uses a self-contained Monte Carlo player instead: for each legal action
// it samples many possible layouts of the unseen cards (consistent with every
// card played so far and every suit a player is known to be void in), plays
// each layout out to the end of the deal with a fast heuristic policy, and
// picks the action with the best average outcome for its team, using the
// engine's own scoring (including the setback penalty and the game score).

import {
  Card, Rank, NUM_CARDS, NUM_SEATS, NUM_SUITS, Setback, Bid, gamePoints,
  seatIncr, partnerOf, teamOfSeat, otherTeam, Score,
  Auction, Trick, Playout, ClosedDeal, OpenDeal,
} from './engine.js';
import { judgeScore } from './rules.js';

/// Minimum simulated chance of making each bid before the computer will make
/// it (see chooseBid). Chosen for how the bidding feels to people rather than
/// for self-play strength, which is indifferent: with these, 3-bids fall from
/// 71% to 35% of deals and their set rate from 42% to 18%; a hand like
/// 7-5-2 of trump passes, and A-10 of trump bids 2 rather than 3.
const MIN_MAKE = { 2: 0.7, 3: 0.7, 4: 0.5 };
/// Chance of making a bid at which the computer bids it in preference to a
/// lower bid it could also make (people bid what they can make to keep the
/// contract away from the others).
const CONFIDENT = { 2: 0.7, 3: 0.85, 4: 0.8 };

// ------------------------------------------------------------------ helpers

function shuffleInPlace(items, rng) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = items[i]; items[i] = items[j]; items[j] = t;
  }
  return items;
}

/// How much a team gains by taking a trick that contains this card
/// (or loses by letting the other team take it).
export function secureValue(card, trump) {
  const rank = Card.rank(card);
  let v = gamePoints(rank);
  if (Card.suit(card) === trump) {
    if (rank === Rank.Jack) v += 6;      // the Jack point
    else if (rank <= Rank.Four) v += 3;  // probably the Low point
  }
  return v;
}

/// Would this card take the trick as it stands?
export function beatsTrick(card, trick, trump) {
  if (!trick.HighPlay) return true;
  const prev = trick.HighPlay.card;
  const suit = Card.suit(card), rank = Card.rank(card);
  const prevSuit = Card.suit(prev), prevRank = Card.rank(prev);
  if (suit === trump) return prevSuit !== trump || rank > prevRank;
  if (suit === prevSuit) return rank > prevRank;
  return false;
}

/// Highest trump rank that is neither in `hand` nor already played
/// (it might be in another hand or undealt; we cannot tell).
export function topOutstandingTrump(hand, playout) {
  const trump = playout.Trump;
  const gone = new Set();
  for (const c of hand) if (Card.suit(c) === trump) gone.add(Card.rank(c));
  for (const t of Playout.tricks(playout)) for (const c of t.Cards) if (Card.suit(c) === trump) gone.add(Card.rank(c));
  for (let r = Rank.Ace; r >= Rank.Two; r--) if (!gone.has(r)) return r;
  return 0;
}

/// Rough strength of a hand if the given suit were trump (used to choose a
/// trump suit for simulated bidders).
export function suitStrength(hand, suit) {
  let s = 0;
  for (const c of hand) {
    const r = Card.rank(c);
    if (Card.suit(c) === suit) {
      s += 2;
      if (r === Rank.Ace) s += 5;
      else if (r === Rank.King) s += 3;
      else if (r === Rank.Queen) s += 1.5;
      if (r === Rank.Jack) s += 3;
      if (r <= Rank.Three) s += 2.5;
      else if (r === Rank.Four) s += 1;
    } else {
      s += gamePoints(r) * 0.15;
    }
  }
  return s;
}

export function bestTrumpSuit(hand) {
  let best = -1, bestS = -Infinity;
  for (let suit = 0; suit < NUM_SUITS; suit++) {
    if (!hand.some((c) => Card.suit(c) === suit)) continue;
    const s = suitStrength(hand, suit);
    if (s > bestS) { bestS = s; best = suit; }
  }
  return best;
}

export function highestOfSuit(hand, suit) {
  let best = -1;
  for (const c of hand) if (Card.suit(c) === suit && (best < 0 || Card.rank(c) > Card.rank(best))) best = c;
  return best;
}

// ----------------------------------------------------------- rollout policy

/// Quick heuristic choice of a card for rollouts.
function policyPlay(hand, playout, seat) {
  const legal = Playout.legalPlays(hand, playout);
  if (legal.length === 1) return legal[0];
  const trump = playout.Trump;
  const trick = playout.CurrentTrick;

  // Leading
  if (trick.Cards.length === 0) {
    if (trump === null) {
      return highestOfSuit(hand, bestTrumpSuit(hand));
    }
    const myTrumps = legal.filter((c) => Card.suit(c) === trump);
    if (myTrumps.length > 0) {
      const top = myTrumps.reduce((a, b) => (Card.rank(b) > Card.rank(a) ? b : a));
      if (Card.rank(top) > topOutstandingTrump(hand, playout)) return top; // sure winner: draw trump
    }
    // lead junk: low, off-suit, worthless
    let best = null, bestCost = Infinity;
    for (const c of legal) {
      const cost = secureValue(c, trump) * 2 + (Card.suit(c) === trump ? 4 : 0) + Card.rank(c) / 20;
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return best;
  }

  // Following
  const partner = partnerOf(seat);
  const highSeat = trick.HighPlay.seat;
  const last = trick.Cards.length === NUM_SEATS - 1;
  const winners = legal.filter((c) => beatsTrick(c, trick, trump));
  let trickValue = 0;
  for (const c of trick.Cards) trickValue += secureValue(c, trump);

  const junk = () => {
    let best = null, bestCost = Infinity;
    for (const c of legal) {
      const cost = secureValue(c, trump) * 2 + (Card.suit(c) === trump ? 3 : 0) + Card.rank(c) / 20;
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return best;
  };

  if (highSeat === partner) {
    const pc = trick.HighPlay.card;
    const partnerStrong = last
      || (Card.suit(pc) === trump && Card.rank(pc) >= Rank.Jack)
      || (Card.suit(pc) === trump && Card.rank(pc) > topOutstandingTrump(hand, playout));
    if (partnerStrong) {
      // feed points to partner, but keep big trumps for winning tricks
      let best = null, bestV = -Infinity;
      for (const c of legal) {
        let v = secureValue(c, trump);
        if (Card.suit(c) === trump && Card.rank(c) >= Rank.Queen) v -= 5;
        else if (Card.suit(c) === trump && v === 0) v -= 1;
        v -= Card.rank(c) / 40;
        if (v > bestV) { bestV = v; best = c; }
      }
      return best;
    }
    return junk();
  }

  // an opponent is winning
  if (winners.length > 0) {
    const cost = (c) => {
      const r = Card.rank(c);
      if (Card.suit(c) !== trump) return r;
      return 20 + r + (r === Rank.Jack ? 15 : 0) + (r <= Rank.Three ? 8 : 0);
    };
    const nonTrumpWinners = winners.filter((c) => Card.suit(c) !== trump);
    if (last) {
      if (nonTrumpWinners.length > 0) {
        return nonTrumpWinners.reduce((a, b) => (Card.rank(b) < Card.rank(a) ? b : a));
      }
      // only trumps win: take the Jack point if we can, otherwise the cheapest trump
      const jack = winners.find((c) => Card.rank(c) === Rank.Jack);
      if (jack) return jack;
      return winners.reduce((a, b) => (cost(b) < cost(a) ? b : a));
    }
    const cheapest = winners.reduce((a, b) => (cost(b) < cost(a) ? b : a));
    const sure = Card.suit(cheapest) === trump && Card.rank(cheapest) > topOutstandingTrump(hand, playout);
    if (trickValue >= 3 || Card.suit(cheapest) !== trump || sure) return cheapest;
    return junk();
  }
  return junk();
}

// -------------------------------------------------------- determinization

/// Samples a full layout of hands consistent with what `seat` knows.
function sampleHands(seat, hand, closedDeal, rng) {
  const p = closedDeal.Playout;
  const seen = new Uint8Array(NUM_CARDS);
  const need = [6, 6, 6, 6];
  for (const c of hand) seen[c] = 1;
  if (p) {
    for (const t of Playout.tricks(p)) {
      for (const [s, c] of Trick.plays(t)) { seen[c] = 1; need[s]--; }
    }
  }
  need[seat] = 0;
  const pool = [];
  for (let c = 0; c < NUM_CARDS; c++) if (!seen[c]) pool.push(c);

  for (let attempt = 0; attempt < 40; attempt++) {
    shuffleInPlace(pool, rng);
    const hands = [[], [], [], []];
    const left = need.slice();
    let remaining = left[0] + left[1] + left[2] + left[3];
    const strict = attempt < 30;
    for (let i = 0; i < pool.length && remaining > 0; i++) {
      const c = pool[i], suit = Card.suit(c);
      // eligible seats
      let n = 0; const elig = [];
      for (let s = 0; s < NUM_SEATS; s++) {
        if (left[s] > 0 && !(strict && p && Playout.isVoid(p, s, suit))) { elig.push(s); n++; }
      }
      if (n === 0) continue; // this card stays undealt
      const s = elig[Math.floor(rng() * n)];
      hands[s].push(c); left[s]--; remaining--;
    }
    if (remaining === 0) {
      hands[seat] = hand.slice();
      return hands;
    }
  }
  throw new Error('Could not sample a consistent deal');
}

// ------------------------------------------------------------- simulation

/// Plays the rest of the deal with the rollout policy; returns the deal score.
function rolloutDeal(deal) {
  let d = deal;
  while (!OpenDeal.isComplete(d)) {
    const seat = OpenDeal.currentPlayer(d);
    const card = policyPlay(d.Hands[seat], d.ClosedDeal.Playout, seat);
    d = OpenDeal.addPlay(card, d);
  }
  return ClosedDeal.getDealScore(d.ClosedDeal);
}

/// Utility of a deal outcome for `team`, given the game score before the deal
/// and which team held the contract (house rules: bid out at 11, 15 any way,
/// lose at -6).
function utility(dealScore, gameScore, team, bidderTeam) {
  const opp = otherTeam(team);
  const after = Score.add(gameScore, dealScore);
  const made = dealScore[bidderTeam] > 0;
  const { winner } = judgeScore(after, bidderTeam, made);
  let u = dealScore[team] - dealScore[opp];
  if (winner === team) u += 8;
  else if (winner === opp) u -= 8;
  return u;
}

// ---------------------------------------------------------------- bidding

/// Simulates the deal with `bidder` winning the auction at `bid`, leading
/// the highest card of the best-looking suit (or `firstCard` if given).
function simulateContract(dealer, hands, bidder, bid, firstCard) {
  // Build the closed deal as if the auction had ended with this bidder/bid:
  // everyone passes except the bidder. (addBid does not check legality, and
  // the rollout policy never looks at the auction, so this is sufficient.)
  let closed = ClosedDeal.create(dealer);
  for (let i = 0; i < NUM_SEATS; i++) {
    const seat = seatIncr(i + 1, dealer);
    closed = ClosedDeal.addBid(seat === bidder ? bid : Bid.Pass, closed);
  }
  let deal = { ClosedDeal: closed, Hands: hands.map((h) => h.slice()) };
  const lead = firstCard !== undefined ? firstCard : highestOfSuit(hands[bidder], bestTrumpSuit(hands[bidder]));
  deal = OpenDeal.addPlay(lead, deal);
  return rolloutDeal(deal);
}

/// Chooses a bid. Returns { bid, values } where values maps bid -> mean utility.
export function chooseBid(infoSet, rng, numWorlds = 64, opts = {}) {
  const { Player: seat, Hand: hand, Deal: deal, GameScore: gameScore } = infoSet;
  const auction = deal.Auction;
  const legal = Auction.legalBids(auction);
  if (legal.length === 1) return { bid: legal[0], values: { 0: 0 } };
  const team = teamOfSeat(seat);
  const dealer = auction.Dealer;

  const worlds = [];
  for (let i = 0; i < numWorlds; i++) worlds.push(sampleHands(seat, hand, deal, rng));

  // Evaluate each candidate trump suit for us; keep raw scores per world.
  const suits = [];
  for (let s = 0; s < NUM_SUITS; s++) if (hand.some((c) => Card.suit(c) === s)) suits.push(s);
  let bestSuit = suits[0], bestMean = -Infinity, bestScores = null;
  for (const s of suits) {
    const lead = highestOfSuit(hand, s);
    const scores = worlds.map((hands) => simulateContract(dealer, hands, seat, Bid.Two, lead));
    const mean = scores.reduce((a, ds) => a + ds[team] - ds[otherTeam(team)], 0) / scores.length;
    if (mean > bestMean) { bestMean = mean; bestSuit = s; bestScores = scores; }
  }

  const values = {};
  for (const bid of legal) {
    if (bid === Bid.Pass) continue;
    let total = 0;
    for (const ds of bestScores) {
      // ds was scored as a 2-bid; re-apply the penalty for this bid
      const raw = ds[team] < 0 ? null : ds; // if set at 2, we'd be set at anything higher too
      let adj;
      if (raw === null) adj = [0, 0], adj[team] = -bid, adj[otherTeam(team)] = ds[otherTeam(team)];
      else if (ds[team] < bid) adj = [0, 0], adj[team] = -bid, adj[otherTeam(team)] = ds[otherTeam(team)];
      else adj = ds;
      total += utility(adj, gameScore, team, team);
    }
    values[bid] = total / bestScores.length;
  }

  // Soundness gate: a bid needs a real chance of being made, whatever the
  // game situation says about blocking. (Self-play is indifferent to this;
  // humans are not: bidding 2 on three small trumps reads as reckless, and a
  // four purely to block made games a slog.)
  const pMake = {};
  for (const bid of legal) {
    if (bid === Bid.Pass) continue;
    pMake[bid] = bestScores.filter((ds) => ds[team] >= bid).length / bestScores.length;
    const min = (opts.minMake || MIN_MAKE)[bid];
    if (min !== undefined && pMake[bid] < min) values[bid] = -Infinity;
  }

  // Value of passing
  let passTotal = 0;
  if (auction.HighBidder !== null) {
    const b = auction.HighBidder, hb = auction.HighBid;
    for (const hands of worlds) passTotal += utility(simulateContract(dealer, hands, b, hb), gameScore, team, teamOfSeat(b));
    // a real bidder holds a better hand than a random one
    passTotal += worlds.length * (teamOfSeat(b) === team ? 0.6 : -0.6);
  } else if (seat === dealer) {
    passTotal = 0; // everyone passed: deal is thrown in
  } else {
    // assume the next player bids two
    const nxt = seatIncr(1, seat);
    for (const hands of worlds) passTotal += utility(simulateContract(dealer, hands, nxt, Bid.Two), gameScore, team, teamOfSeat(nxt));
    passTotal *= 0.7; // they might well pass too
  }
  values[Bid.Pass] = passTotal / worlds.length;

  // Candidates: sound bids that beat passing. Among them, bid what the hand
  // can confidently make (a higher bid scores no more, but it keeps the
  // contract away from the others), else the best-valued one.
  const conf = opts.conf || CONFIDENT;
  let best = Bid.Pass, bestV = values[Bid.Pass];
  for (const bid of legal) {
    if (bid === Bid.Pass) continue;
    if (values[bid] > bestV + 0.05) { bestV = values[bid]; best = bid; }
  }
  if (best !== Bid.Pass) {
    for (const bid of legal) {
      if (bid === Bid.Pass || bid <= best) continue;
      if (values[bid] > values[Bid.Pass] + 0.05 && pMake[bid] >= conf[bid]) best = bid;
    }
  }
  return { bid: best, values, trumpSuit: bestSuit, pMake };
}

// ---------------------------------------------------------------- playing

/// Chooses a card. Returns { card, values } where values maps card -> mean utility.
export function choosePlay(infoSet, rng, numWorlds = 64, opts = {}) {
  const { Player: seat, Hand: hand, Deal: deal, GameScore: gameScore } = infoSet;
  const p = deal.Playout;
  const legal = Playout.legalPlays(hand, p);
  if (legal.length === 1) return { card: legal[0], values: { [legal[0]]: 0 } };
  const team = teamOfSeat(seat);
  const bidderTeam = teamOfSeat(p.Bidder);


  // The opening lead names trump, and the conventional lead is the top card
  // of the suit (it draws trumps and secures High); restricting the candidates
  // to the highest card of each suit tested as strength-neutral in self-play
  // and avoids odd-looking low leads.
  let cands = legal;
  if (p.Trump === null) {
    const tops = new Set();
    for (let s = 0; s < NUM_SUITS; s++) { const h = highestOfSuit(hand, s); if (h >= 0) tops.add(h); }
    cands = legal.filter((c) => tops.has(c));
  }

  const worlds = [];
  for (let i = 0; i < numWorlds; i++) worlds.push(sampleHands(seat, hand, deal, rng));

  const values = {};
  let best = cands[0], bestV = -Infinity;
  for (const card of cands) {
    let total = 0;
    for (const hands of worlds) {
      let d = { ClosedDeal: deal, Hands: hands };
      d = OpenDeal.addPlay(card, d);
      total += utility(rolloutDeal(d), gameScore, team, bidderTeam);
    }
    const v = total / worlds.length;
    values[card] = v;
    if (v > bestV + 1e-9) { bestV = v; best = card; }
  }

  // Near-equal candidates (the rollouts often rate the ace and king of trump
  // identically): prefer what the rollout policy would do, otherwise the
  // higher card when leading and the cheaper card when following.
  // Leading a sure-winner trump is what people expect; it gets a wider window
  // (about a sixth of a point) since half of the search's deviations from it
  // are within noise anyway.
  const pol = policyPlay(hand, p, seat);
  const leading = p.CurrentTrick.Cards.length === 0;
  const sureTrumpLead = leading && p.Trump !== null && Card.suit(pol) === p.Trump && Card.rank(pol) > topOutstandingTrump(hand, p);
  const eps = opts.tieEps !== undefined ? opts.tieEps : sureTrumpLead ? 0.15 : 0.02;
  const ties = cands.filter((c) => values[c] >= bestV - eps);
  if (ties.length > 1) {
    if (ties.includes(pol)) best = pol;
    else {
      best = ties.reduce((a, b) => ((leading ? Card.rank(b) > Card.rank(a) : Card.rank(b) < Card.rank(a)) ? b : a));
    }
  }
  return { card: best, values };
}

/// Chooses any action for the given information set.
export function chooseAction(infoSet, rng, numWorlds, opts = {}) {
  if (infoSet.Deal.Playout) {
    const r = choosePlay(infoSet, rng, numWorlds, opts);
    return { action: { card: r.card }, values: r.values };
  }
  const r = chooseBid(infoSet, rng, numWorlds, opts);
  return { action: { bid: r.bid }, values: r.values };
}

/// A weak baseline player (rollout policy only), used for testing.
export function policyAction(infoSet, rng) {
  if (infoSet.Deal.Playout) {
    return { card: policyPlay(infoSet.Hand, infoSet.Deal.Playout, infoSet.Player) };
  }
  // naive bidding: bid two on a decent hand, otherwise pass
  const legal = Auction.legalBids(infoSet.Deal.Auction);
  const s = suitStrength(infoSet.Hand, bestTrumpSuit(infoSet.Hand));
  let want = Bid.Pass;
  if (s >= 20) want = Bid.Four; else if (s >= 15) want = Bid.Three; else if (s >= 10) want = Bid.Two;
  while (want !== Bid.Pass && !legal.includes(want)) want = want === Bid.Four ? Bid.Three : want === Bid.Three ? Bid.Two : Bid.Pass;
  return { bid: want };
}
