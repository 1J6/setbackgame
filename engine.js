// Setback rules engine.
// A function-for-function JavaScript port of Brian Berns' F# Setback engine
// (https://github.com/brianberns/Setback — PlayingCards + Setback projects).
// Module and function names follow the original so the two can be compared.

// ---------------------------------------------------------------- PlayingCards

export const Suit = { Clubs: 0, Diamonds: 1, Hearts: 2, Spades: 3 };
export const NUM_SUITS = 4;
export const SUIT_CHARS = ['♣', '♦', '♥', '♠'];
export const SUIT_LETTERS = 'CDHS';
export const SUIT_NAMES = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];

export const Rank = {
  Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8,
  Nine: 9, Ten: 10, Jack: 11, Queen: 12, King: 13, Ace: 14,
};
export const NUM_RANKS = 13;
export const MIN_RANK = 2;
export const RANK_CHARS = '23456789TJQKA';

export const NUM_CARDS = NUM_SUITS * NUM_RANKS; // 52

// A card is an integer 0..51: suit * 13 + (rank - 2). This matches
// Setback.Model.Card.toIndex in the original.
export const Card = {
  create: (rank, suit) => suit * NUM_RANKS + (rank - MIN_RANK),
  rank: (card) => (card % NUM_RANKS) + MIN_RANK,
  suit: (card) => Math.floor(card / NUM_RANKS),
  toString: (card) => RANK_CHARS[Card.rank(card) - MIN_RANK] + SUIT_CHARS[Card.suit(card)],
  fromString: (str) => {
    const r = RANK_CHARS.indexOf(str[0]);
    const s = SUIT_LETTERS.indexOf(str[1]) >= 0 ? SUIT_LETTERS.indexOf(str[1]) : SUIT_CHARS.indexOf(str[1]);
    if (r < 0 || s < 0) throw new Error('Bad card: ' + str);
    return Card.create(r + MIN_RANK, s);
  },
  allCards: Array.from({ length: NUM_CARDS }, (_, i) => i),
};

// Knuth shuffle, as in PlayingCards.Deck (Fable branch).
export const Deck = {
  shuffle(rng) {
    const items = Card.allCards.slice();
    const len = items.length;
    for (let i = 0; i <= len - 2; i++) {
      const j = i + Math.floor(rng() * (len - i));
      const t = items[i]; items[i] = items[j]; items[j] = t;
    }
    return { Cards: items };
  },
};

// ------------------------------------------------------------------- Setback

export const Setback = {
  numCardsPerHand: 6,
  numCardsPerDeal: 24,
  numDealPoints: 4,
  winThreshold: 11,
  numTeams: 2,
};

/// Value of a rank towards the Game point.
export function gamePoints(rank) {
  switch (rank) {
    case Rank.Ten: return 10;
    case Rank.Ace: return 4;
    case Rank.King: return 3;
    case Rank.Queen: return 2;
    case Rank.Jack: return 1;
    default: return 0;
  }
}

export const Bid = { Pass: 0, Two: 2, Three: 3, Four: 4 };
export const ALL_BIDS = [0, 2, 3, 4];
export const BID_NAMES = { 0: 'Pass', 2: 'Two', 3: 'Three', 4: 'Four' };

export const Seat = { West: 0, North: 1, East: 2, South: 3 };
export const NUM_SEATS = 4;
export const SEAT_NAMES = ['West', 'North', 'East', 'South'];
export const SEAT_CHARS = 'WNES';
export const seatIncr = (n, seat) => (seat + n) % NUM_SEATS;
export const seatNext = (seat) => seatIncr(1, seat);
export const seatCycle = (seat) => [0, 1, 2, 3].map((i) => seatIncr(i, seat));

export const Team = { EastWest: 0, NorthSouth: 1 };
export const TEAM_NAMES = ['E+W', 'N+S'];
export const TEAM_LONG_NAMES = ['East + West', 'North + South'];
export const teamOfSeat = (seat) => (seat === Seat.East || seat === Seat.West) ? Team.EastWest : Team.NorthSouth;
export const otherTeam = (team) => 1 - team;
export const partnerOf = (seat) => seatIncr(2, seat);

// Score: array of points indexed by team.
export const Score = {
  zero: () => [0, 0],
  create: (team, points) => team === 0 ? [points, 0] : [0, points],
  add: (a, b) => [a[0] + b[0], a[1] + b[1]],
  tryGetWinningTeam(score) {
    const max = Math.max(score[0], score[1]);
    if (max >= Setback.winThreshold) {
      if (score[0] === max && score[1] === max) return null;
      return score[0] === max ? 0 : 1;
    }
    return null;
  },
};

// ------------------------------------------------------------------- Auction

export const Auction = {
  /// Bids are stored in chronological order (the F# original stores them
  /// reversed; every consumer here accounts for that).
  create: (dealer) => ({ Dealer: dealer, Bids: [], HighBidder: null, HighBid: Bid.Pass }),

  isComplete: (auction) => auction.Bids.length === NUM_SEATS,

  currentBidder: (auction) => seatIncr(auction.Bids.length + 1, auction.Dealer),

  /// [seat, bid] pairs in chronological order.
  playerBids: (auction) => auction.Bids.map((bid, i) => [seatIncr(i + 1, auction.Dealer), bid]),

  legalBids(auction) {
    const bid = auction.HighBid;
    const out = [Bid.Pass];
    if (bid < Bid.Two) out.push(Bid.Two);
    if (bid < Bid.Three) out.push(Bid.Three);
    if (bid < Bid.Four) out.push(Bid.Four);
    else if (auction.Bids.length === NUM_SEATS - 1) out.push(Bid.Four); // dealer can steal a 4-bid
    return out;
  },

  addBid(bid, auction) {
    const bidder = Auction.currentBidder(auction);
    const pass = bid === Bid.Pass;
    return {
      Dealer: auction.Dealer,
      Bids: auction.Bids.concat([bid]),
      HighBidder: pass ? auction.HighBidder : bidder,
      HighBid: pass ? auction.HighBid : bid,
    };
  },
};

// --------------------------------------------------------------------- Trick

export const Trick = {
  /// Cards are stored in chronological order.
  create: (leader) => ({ Leader: leader, SuitLed: null, Cards: [], HighPlay: null }),

  currentPlayer: (trick) => seatIncr(trick.Cards.length, trick.Leader),

  highPlayer: (trick) => trick.HighPlay ? trick.HighPlay.seat : null,

  addPlay(trump, card, trick) {
    const suit = Card.suit(card), rank = Card.rank(card);
    let isHigh = true;
    if (trick.HighPlay) {
      const prev = trick.HighPlay.card;
      const prevSuit = Card.suit(prev), prevRank = Card.rank(prev);
      if (suit === trump) isHigh = prevSuit !== trump || rank > prevRank;
      else if (suit === prevSuit) isHigh = rank > prevRank;
      else isHigh = false;
    }
    return {
      Leader: trick.Leader,
      SuitLed: trick.SuitLed === null ? suit : trick.SuitLed,
      Cards: trick.Cards.concat([card]),
      HighPlay: isHigh ? { seat: Trick.currentPlayer(trick), card } : trick.HighPlay,
    };
  },

  isComplete: (trick) => trick.Cards.length === NUM_SEATS,

  /// [seat, card] pairs in chronological order.
  plays: (trick) => trick.Cards.map((card, i) => [seatIncr(i, trick.Leader), card]),
};

// ------------------------------------------------------------------- Playout

const voidBit = (seat, suit) => 1 << (seat * NUM_SUITS + suit);

export const Playout = {
  create: (bidder) => ({
    Bidder: bidder,
    Trump: null,
    CurrentTrick: Trick.create(bidder),
    CompletedTricks: [], // chronological
    Voids: 0,            // bitmask over (seat, suit)
    HighTrump: null,     // { rank, team }
    LowTrump: null,      // { rank, team }
    JackTrumpTeam: null,
    GameScore: Score.zero(),
  }),

  numCardsPlayed: (p) => p.CompletedTricks.length * NUM_SEATS + (p.CurrentTrick ? p.CurrentTrick.Cards.length : 0),

  isComplete: (p) => Playout.numCardsPlayed(p) === Setback.numCardsPerDeal,

  currentPlayer: (p) => Trick.currentPlayer(p.CurrentTrick),

  isVoid: (p, seat, suit) => (p.Voids & voidBit(seat, suit)) !== 0,

  legalPlays(hand, p) {
    const trick = p.CurrentTrick;
    if (trick.SuitLed === null) return hand.slice();
    const trump = p.Trump, suitLed = trick.SuitLed;
    if (hand.some((c) => Card.suit(c) === suitLed)) {
      return hand.filter((c) => Card.suit(c) === trump || Card.suit(c) === suitLed);
    }
    return hand.slice();
  },

  _updateDealPoints(trick, takerTeam, p) {
    const trump = p.Trump;
    const trumpRanks = [];
    let points = 0;
    for (const card of trick.Cards) {
      const r = Card.rank(card);
      if (Card.suit(card) === trump) trumpRanks.push(r);
      points += gamePoints(r);
    }
    let high = p.HighTrump, low = p.LowTrump, jack = p.JackTrumpTeam;
    if (trumpRanks.length > 0) {
      const mx = Math.max(...trumpRanks), mn = Math.min(...trumpRanks);
      if (high === null || mx > high.rank) high = { rank: mx, team: takerTeam };
      if (low === null || mn < low.rank) low = { rank: mn, team: takerTeam };
      if (trumpRanks.includes(Rank.Jack)) jack = takerTeam;
    }
    return {
      ...p,
      HighTrump: high,
      LowTrump: low,
      JackTrumpTeam: jack,
      GameScore: Score.add(p.GameScore, Score.create(takerTeam, points)),
    };
  },

  _completeTrick(trick, p) {
    const completed = p.CompletedTricks.concat([trick]);
    const taker = trick.HighPlay.seat;
    const p2 = Playout._updateDealPoints(trick, teamOfSeat(taker), p);
    return {
      ...p2,
      CompletedTricks: completed,
      CurrentTrick: completed.length < Setback.numCardsPerHand ? Trick.create(taker) : null,
    };
  },

  addPlay(card, p) {
    const suit = Card.suit(card);
    // establish trump if necessary
    const trump = p.Trump === null ? suit : p.Trump;
    const p1 = { ...p, Trump: trump };
    // play card on the current trick
    const trick0 = p1.CurrentTrick;
    const player = Trick.currentPlayer(trick0);
    const trick = Trick.addPlay(trump, card, trick0);
    let p2 = Trick.isComplete(trick)
      ? Playout._completeTrick(trick, p1)
      : { ...p1, CurrentTrick: trick };
    // update voids
    const suitLed = trick.SuitLed;
    if (suit !== suitLed && suit !== trump) {
      p2 = { ...p2, Voids: p2.Voids | voidBit(player, suitLed) };
    }
    return p2;
  },

  /// All tricks in chronological order, including the current one (if any).
  tricks: (p) => p.CurrentTrick ? p.CompletedTricks.concat([p.CurrentTrick]) : p.CompletedTricks.slice(),

  /// Deal points (High, Low, Jack, Game) per team, before any setback penalty.
  getRawDealScore(p) {
    const score = Score.zero();
    if (p.HighTrump) score[p.HighTrump.team] += 1;
    if (p.LowTrump) score[p.LowTrump.team] += 1;
    if (p.JackTrumpTeam !== null) score[p.JackTrumpTeam] += 1;
    const g = p.GameScore;
    if (g[0] > g[1]) score[0] += 1;
    else if (g[1] > g[0]) score[1] += 1;
    return score;
  },

  /// Which team currently holds each deal point (null if nobody yet).
  pointHolders(p) {
    const g = p.GameScore;
    return {
      High: p.HighTrump ? p.HighTrump.team : null,
      Low: p.LowTrump ? p.LowTrump.team : null,
      Jack: p.JackTrumpTeam,
      Game: g[0] > g[1] ? 0 : g[1] > g[0] ? 1 : null,
    };
  },
};

// ---------------------------------------------------------------- ClosedDeal

export const ClosedDeal = {
  create: (dealer) => ({ Auction: Auction.create(dealer), Playout: null }),

  dealer: (deal) => deal.Auction.Dealer,

  trump: (deal) => deal.Playout ? deal.Playout.Trump : null,

  isComplete: (deal) => deal.Playout ? Playout.isComplete(deal.Playout) : Auction.isComplete(deal.Auction),

  currentPlayer: (deal) => deal.Playout ? Playout.currentPlayer(deal.Playout) : Auction.currentBidder(deal.Auction),

  addBid(bid, deal) {
    const auction = Auction.addBid(bid, deal.Auction);
    let playout = null;
    if (Auction.isComplete(auction) && auction.HighBidder !== null) {
      playout = Playout.create(auction.HighBidder);
    }
    return { Auction: auction, Playout: playout };
  },

  addPlay(card, deal) {
    if (!deal.Playout) throw new Error('No playout');
    return { Auction: deal.Auction, Playout: Playout.addPlay(card, deal.Playout) };
  },

  /// Deal score per team, including the setback penalty if applicable.
  getDealScore(deal) {
    const highBid = deal.Auction.HighBid;
    if (highBid === Bid.Pass && !deal.Playout) return Score.zero();
    const p = deal.Playout;
    const nBid = highBid;
    const raw = Playout.getRawDealScore(p);
    const bidderTeam = teamOfSeat(p.Bidder);
    if (raw[bidderTeam] < nBid) {
      const s = raw.slice();
      s[bidderTeam] = -nBid;
      return s;
    }
    return raw;
  },
};

// ------------------------------------------------------------------ OpenDeal

export const OpenDeal = {
  fromHands: (dealer, hands) => ({ ClosedDeal: ClosedDeal.create(dealer), Hands: hands.map((h) => h.slice()) }),

  /// Deals six cards to each player, one at a time, starting left of the dealer.
  fromDeck(dealer, deck) {
    const hands = [[], [], [], []];
    for (let i = 0; i < Setback.numCardsPerDeal; i++) {
      const seat = seatIncr((i + 1) % NUM_SEATS, dealer);
      hands[seat].push(deck.Cards[i]);
    }
    for (const h of hands) h.sort((a, b) => a - b);
    return OpenDeal.fromHands(dealer, hands);
  },

  isComplete: (deal) => ClosedDeal.isComplete(deal.ClosedDeal),

  currentPlayer: (deal) => ClosedDeal.currentPlayer(deal.ClosedDeal),

  addBid: (bid, deal) => ({ ClosedDeal: ClosedDeal.addBid(bid, deal.ClosedDeal), Hands: deal.Hands }),

  addPlay(card, deal) {
    const seat = OpenDeal.currentPlayer(deal);
    const hands = deal.Hands.slice();
    if (!hands[seat].includes(card)) throw new Error('Card not in hand');
    hands[seat] = hands[seat].filter((c) => c !== card);
    return { ClosedDeal: ClosedDeal.addPlay(card, deal.ClosedDeal), Hands: hands };
  },

  addAction: (action, deal) => action.bid !== undefined ? OpenDeal.addBid(action.bid, deal) : OpenDeal.addPlay(action.card, deal),
};

// ------------------------------------------------------------ InformationSet

/// Actions are { bid } during the auction and { card } during the playout.
export const InformationSet = {
  legalActions(hand, deal) {
    if (!deal.Playout) return Auction.legalBids(deal.Auction).map((bid) => ({ bid }));
    return Playout.legalPlays(hand, deal.Playout).map((card) => ({ card }));
  },
  create(player, hand, deal, gameScore) {
    return { Player: player, Hand: hand, Deal: deal, GameScore: gameScore, LegalActions: InformationSet.legalActions(hand, deal) };
  },
};

// ---------------------------------------------------------------------- Game

export const Game = {
  _createDeal: (rng, dealer) => OpenDeal.fromDeck(dealer, Deck.shuffle(rng)),

  create: (rng, dealer) => ({ Deal: Game._createDeal(rng, dealer), Score: Score.zero() }),

  currentInfoSet(game) {
    const deal = game.Deal;
    const player = OpenDeal.currentPlayer(deal);
    return InformationSet.create(player, deal.Hands[player], deal.ClosedDeal, game.Score);
  },

  tryGetWinningTeam: (game) => Score.tryGetWinningTeam(game.Score),

  /// Takes the given action; at the end of a deal the score is updated.
  addAction(action, game) {
    const deal = OpenDeal.addAction(action, game.Deal);
    let score = game.Score;
    if (OpenDeal.isComplete(deal)) {
      score = Score.add(score, ClosedDeal.getDealScore(deal.ClosedDeal));
    }
    return { Deal: deal, Score: score };
  },

  startNextDeal(rng, game) {
    const dealer = seatIncr(1, game.Deal.ClosedDeal.Auction.Dealer);
    return { Deal: Game._createDeal(rng, dealer), Score: game.Score };
  },
};

/// Phase of a deal: 'auction' | 'playout' | 'complete'.
export function dealPhase(closedDeal) {
  if (ClosedDeal.isComplete(closedDeal)) return 'complete';
  return closedDeal.Playout ? 'playout' : 'auction';
}
