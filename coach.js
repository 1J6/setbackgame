// Coach mode: plain-language explanations of the computer's recommended bid or
// play, for learning while playing in single player. The recommendation itself
// comes from ai.js (Monte Carlo); this module only describes why it makes sense,
// using the same hand-reading heuristics the rollout policy uses.
import {
  Card, Rank, Bid, SUIT_CHARS, SUIT_NAMES, NUM_SEATS, gamePoints, partnerOf, teamOfSeat, otherTeam, Playout,
} from './engine.js';
import { beatsTrick, topOutstandingTrump, highestOfSuit, bestTrumpSuit, secureValue } from './ai.js';
import { RULES } from './rules.js';

const rankChar = (r) => (r === 10 ? '10' : 'JQKA'[r - 11] || String(r));
const isRed = (s) => s === 1 || s === 2;
const cardTag = (card) => {
  const s = Card.suit(card);
  return `<b class="${isRed(s) ? 'suit-red' : ''}">${rankChar(Card.rank(card))}${SUIT_CHARS[s]}</b>`;
};
const suitTag = (s) => `<b class="${isRed(s) ? 'suit-red' : ''}">${SUIT_CHARS[s]}</b>`;
const suitWord = (s) => SUIT_NAMES[s].toLowerCase();
const pts = (n) => `${n} game point${n === 1 ? '' : 's'}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (x) => (Math.round(x * 10) / 10).toFixed(1);

/// What a hand offers if `s` were trump, as a list of short phrases.
function suitFeatures(hand, s) {
  const trumps = hand.filter((c) => Card.suit(c) === s).sort((a, b) => Card.rank(b) - Card.rank(a));
  const ranks = trumps.map(Card.rank);
  const top = ranks[0], low = ranks[ranks.length - 1];
  const gp = hand.reduce((t, c) => t + gamePoints(Card.rank(c)), 0);
  const parts = [];
  if (top === Rank.Ace) parts.push(`the ${cardTag(trumps[0])} is almost certain to take High`);
  else if (top === Rank.King) parts.push(`the ${cardTag(trumps[0])} takes High unless the ace was dealt`);
  else if (top >= Rank.Queen) parts.push(`the ${cardTag(trumps[0])} could take High, but the ace and king may be out`);
  const jack = trumps.find((c) => Card.rank(c) === Rank.Jack);
  if (jack) parts.push(`the ${cardTag(jack)} is the Jack point if you can land it on a trick your side wins`);
  const lowCard = trumps[trumps.length - 1];
  if (trumps.length > 1 && low <= Rank.Three) parts.push(`the ${cardTag(lowCard)} is a good bet for Low`);
  else if (trumps.length > 1 && low <= Rank.Five) parts.push(`the ${cardTag(lowCard)} has a fair chance at Low`);
  if (trumps.length >= 3) parts.push(`${trumps.length} trumps let you draw the opponents' trumps`);
  if (gp >= 10) parts.push(`${pts(gp)} in hand give you a shot at Game`);
  return { parts, trumps, gp };
}

const list = (parts) => (parts.length ? parts.join('; ') : 'nothing in it is a sure point');

/// Explains a bid recommendation from ai.chooseBid. `names[seat]` are lower-case
/// phrases such as "your partner" or "West"; names[seat] for the user is "you".
export function coachBid(info, rec, names) {
  const { Hand: hand, Deal: deal, GameScore: score, Player: seat } = info;
  const auction = deal.Auction;
  const team = teamOfSeat(seat), opp = otherTeam(team);
  const hb = auction.HighBid, hbSeat = auction.HighBidder;
  const v = rec.values || {};
  const s = rec.trumpSuit !== undefined ? rec.trumpSuit : bestTrumpSuit(hand);
  const { parts } = suitFeatures(hand, s);
  const margin = (b) => (v[b] !== undefined && v[Bid.Pass] !== undefined ? v[b] - v[Bid.Pass] : null);

  let html, short;
  if (rec.bid === Bid.Pass) {
    if (hbSeat !== null && teamOfSeat(hbSeat) === team) {
      short = `${cap(names[hbSeat])} already holds the contract at ${hb} for your side, so bidding over a partner gains nothing and raises the risk of a set.`;
    } else if (hbSeat !== null) {
      short = `${cap(names[hbSeat])} bid ${hb}. Taking it away means promising ${hb + 1}, and your best suit ${suitTag(s)} (${list(parts)}) is not worth that. Let them try to make it: if they fall short they lose ${hb}.`;
    } else {
      short = `Your best suit is ${suitTag(s)} (${list(parts)}). That is not a safe promise of two points, and being set costs 2. ` +
        (seat === auction.Dealer ? 'As dealer, passing throws the hand in for a fresh deal.' : 'If someone else bids, you keep the chance to set them.');
    }
    const m = margin(Bid.Two);
    html = `Pass. ${short}` + (m !== null && m < 0 ? ` In the simulation, bidding 2 rated about ${fmt(-m)} points worse than passing.` : '');
    return { html, short };
  }

  const b = rec.bid;
  short = `${suitTag(s)} is your suit: ${list(parts)}.`;
  const extra = [];
  if (hbSeat !== null && teamOfSeat(hbSeat) === opp) extra.push(`It also takes the contract away from ${names[hbSeat]}.`);
  if (score[team] + b >= RULES.winBid && score[team] < RULES.winBid) extra.push(`Making it would take you to ${score[team] + b}, and you must bid and make it to win the game.`);
  else if (score[opp] >= 8) extra.push(`The opponents are at ${score[opp]}, so keeping the contract from them matters.`);
  const m = margin(b);
  if (m !== null && m > 0) {
    let line = `In the simulation, ${b} rated about ${fmt(m)} points better than passing`;
    if (b < Bid.Four && v[b + 1] !== undefined && v[b + 1] < v[b]) line += `, while ${b + 1} would risk a bigger set for little extra`;
    extra.push(line + '.');
  }
  const lead = highestOfSuit(hand, s);
  extra.push(`If you win the auction, lead the ${cardTag(lead)} to make ${suitWord(s)} trump.`);
  html = `Bid ${b}. ${short} ${extra.join(' ')}`;
  return { html, short };
}

/// Explains a play recommendation from ai.choosePlay.
export function coachPlay(info, rec, names) {
  const { Hand: hand, Deal: deal, Player: seat } = info;
  const p = deal.Playout, trick = p.CurrentTrick, trump = p.Trump;
  const c = rec.card;
  const legal = Playout.legalPlays(hand, p);
  const v = rec.values || {};
  const partner = partnerOf(seat);
  const r = Card.rank(c), s = Card.suit(c);
  let why;

  if (legal.length === 1) {
    why = hand.length === 1 ? 'It is your last card.' :
      `It is your only legal card: you must follow ${suitTag(trick.SuitLed)} or play a trump, and this is all you have.`;
    return { html: `Play the ${cardTag(c)}. ${why}`, short: why };
  }

  if (trick.Cards.length === 0) {
    if (trump === null) {
      const { parts } = suitFeatures(hand, s);
      why = `Leading it makes ${suitWord(s)} trump: ${list(parts)}.`;
      if (c === highestOfSuit(hand, s)) why += ' Leading your top trump first pulls a trump from everyone and locks in High.';
    } else if (s === trump) {
      const top = topOutstandingTrump(hand, p);
      if (r > top) why = 'It is the highest trump still out, so it cannot lose. Leading it pulls a trump from everyone and protects your High and Jack.';
      else why = `Leading trump makes the others spend theirs${top ? ` (the ${rankChar(top)} of trump may still be out)` : ''} and clears the way for your other cards.`;
    } else if (secureValue(c, trump) === 0) {
      why = 'A card nobody minds losing: no game points at stake, and it keeps your trumps and tens for tricks that matter.';
    } else {
      why = `It is likely to win this trick unless someone trumps, and ${pts(gamePoints(r))} toward Game is worth the risk.`;
    }
  } else {
    const highSeat = trick.HighPlay.seat, pc = trick.HighPlay.card;
    const last = trick.Cards.length === NUM_SEATS - 1;
    const wins = beatsTrick(c, trick, trump);
    const trickPts = trick.Cards.reduce((t, x) => t + gamePoints(Card.rank(x)), 0);
    const jackIn = trick.Cards.some((x) => Card.suit(x) === trump && Card.rank(x) === Rank.Jack);
    const lowIn = trick.Cards.some((x) => Card.suit(x) === trump && Card.rank(x) <= Rank.Four);
    const worth = [];
    if (trickPts) worth.push(pts(trickPts));
    if (jackIn) worth.push('the Jack point');
    if (lowIn) worth.push('a likely Low');
    const worthText = worth.length ? worth.join(' and ') : 'nothing much';

    if (highSeat === partner) {
      const what = [];
      if (gamePoints(r)) what.push(pts(gamePoints(r)));
      if (s === trump && r === Rank.Jack) what.push('the Jack point');
      else if (s === trump && r <= Rank.Four) what.push('a likely Low');
      if (what.length) {
        why = `${cap(names[partner])} is winning with the ${cardTag(pc)}${last ? ' and you play last, so the trick is safe' : ''}. ` +
          `Feed it ${what.join(' and ')}: points count for your side no matter which of you takes the trick.`;
      } else {
        why = `${cap(names[partner])} is winning${last ? '' : `, but an opponent could still beat the ${cardTag(pc)}`}. ` +
          'Throw a worthless card and keep your tens and trumps for a trick that needs them.';
      }
    } else if (wins) {
      const sure = s === trump && r > topOutstandingTrump(hand, p);
      if (last) why = `You play last, so the ${cardTag(c)} takes the trick for certain, and it is the cheapest card that does. The trick holds ${worthText}.`;
      else if (sure) why = `It is the highest trump still out, so it wins no matter what follows. The trick holds ${worthText}.`;
      else if (trickPts >= 3 || jackIn) why = `It beats the ${cardTag(pc)} from ${names[highSeat]} as things stand, and the trick holds ${worthText}, which is worth fighting for.`;
      else if (secureValue(c, trump) === 0) why = `It beats the ${cardTag(pc)} from ${names[highSeat]} as things stand, and it costs nothing if someone overtakes it.`;
      else why = `It beats the ${cardTag(pc)} from ${names[highSeat]} as things stand. If someone overtakes it you lose its ${pts(gamePoints(r))}, but the simulation rates that chance as worth taking.`;
      if (s === trump && r === Rank.Jack) why += ' Winning with the jack also banks the Jack point.';
    } else {
      const winners = legal.filter((x) => beatsTrick(x, trick, trump));
      const give = gamePoints(r) ? `only ${pts(gamePoints(r))}` : 'nothing';
      if (winners.length === 0) {
        why = `Nothing in your hand beats the ${cardTag(pc)}, so give away as little as you can: the ${cardTag(c)} carries ${give}.`;
      } else {
        const w = winners.reduce((a, x) => (secureValue(x, trump) + Card.rank(x) / 20 < secureValue(a, trump) + Card.rank(a) / 20 ? x : a));
        why = `You could take this trick with the ${cardTag(w)}, but it holds ${worthText}${last ? '' : ' and could still be overtaken'}. ` +
          `The simulation rates keeping the ${cardTag(w)} for a later trick higher, and the ${cardTag(c)} is the cheapest card to let go: it gives away ${give}.`;
      }
    }
  }

  // the most expensive alternative, when it is clearly worse
  let worst = null, worstGap = 0;
  for (const x of legal) {
    if (x === c || v[x] === undefined || v[c] === undefined) continue;
    const gap = v[c] - v[x];
    if (gap > worstGap) { worstGap = gap; worst = x; }
  }
  let html = `Play the ${cardTag(c)}. ${why}`;
  if (worst !== null && worstGap >= 0.75) {
    html += ` Playing the ${cardTag(worst)} instead rated about ${fmt(worstGap)} points worse` +
      (gamePoints(Card.rank(worst)) ? `, mostly by handing over its ${pts(gamePoints(Card.rank(worst)))}.` : '.');
  }
  return { html, short: why };
}

/// After the user acts: compares their choice with the recommendation.
export function reviewPlay(rec, chosen, short) {
  if (chosen === rec.card) return null;
  const v = rec.values || {};
  const gap = (v[rec.card] || 0) - (v[chosen] || 0);
  if (gap < 0.25) return `You played the ${cardTag(chosen)}; the ${cardTag(rec.card)} rated about the same. Fine choice.`;
  return `You played the ${cardTag(chosen)}. The ${cardTag(rec.card)} rated about ${fmt(gap)} points better: ${short}`;
}

export function reviewBid(rec, chosen, short) {
  if (chosen === rec.bid) return null;
  const v = rec.values || {};
  const gap = (v[rec.bid] || 0) - (v[chosen] || 0);
  const name = (b) => (b === Bid.Pass ? 'passing' : `bidding ${b}`);
  if (gap < 0.25) return `You chose ${name(chosen)}; ${name(rec.bid)} rated about the same. Fine choice.`;
  return `You chose ${name(chosen)}. ${cap(name(rec.bid))} rated about ${fmt(gap)} points better: ${short}`;
}
