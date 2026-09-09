// House scoring rules layered on top of the engine's deal scoring.
//
//  * A team wins when it has 11 or more points AND it was the bidding team on
//    the deal just played and made its bid ("bid to win"). Reaching 11 on
//    garbage points does not end the game.
//  * A team that reaches 15 points any way wins.
//  * A team that falls to -6 points loses immediately.
//  * If the bidding team makes its bid to reach 11 on the same deal the other
//    team reaches 15, the bidding team wins.

import { Bid, Score, Playout, ClosedDeal, teamOfSeat, otherTeam } from './engine.js';

export const RULES = { winBid: 11, winAny: 15, loseAt: -6 };

/// Decides whether a game is over given the score after a deal.
/// `bidderTeam` / `made` describe the deal just played (made = bid was met).
export function judgeScore(score, bidderTeam, made) {
  for (let t = 0; t < 2; t++) {
    if (score[t] <= RULES.loseAt) return { winner: otherTeam(t), reason: 'minus' };
  }
  if (made && bidderTeam !== null && score[bidderTeam] >= RULES.winBid) {
    return { winner: bidderTeam, reason: 'bid' };
  }
  for (let t = 0; t < 2; t++) {
    if (score[t] >= RULES.winAny) return { winner: t, reason: 'fifteen' };
  }
  return { winner: null, reason: null };
}

/// Summarises a completed deal: points, setback, resulting score, and whether
/// the game ended. `scoreBefore` is the game score before this deal.
export function judgeDeal(scoreBefore, closedDeal) {
  const auction = closedDeal.Auction;
  if (auction.HighBid === Bid.Pass || !closedDeal.Playout) {
    return {
      allPass: true, dealScore: [0, 0], raw: [0, 0], scoreAfter: scoreBefore.slice(),
      bidderTeam: null, bidder: null, bid: 0, made: false, set: false, winner: null, reason: null,
      holders: null, gamePoints: [0, 0], trump: null,
    };
  }
  const p = closedDeal.Playout;
  const raw = Playout.getRawDealScore(p);
  const dealScore = ClosedDeal.getDealScore(closedDeal);
  const bidderTeam = teamOfSeat(p.Bidder);
  const set = raw[bidderTeam] < auction.HighBid;
  const scoreAfter = Score.add(scoreBefore, dealScore);
  const { winner, reason } = judgeScore(scoreAfter, bidderTeam, !set);
  return {
    allPass: false, dealScore, raw, scoreAfter, bidderTeam, bidder: p.Bidder, bid: auction.HighBid,
    made: !set, set, winner, reason,
    holders: Playout.pointHolders(p), gamePoints: p.GameScore.slice(), trump: p.Trump,
  };
}

/// Running statistics for a team pair.
export const emptyStats = () => ({ points: [0, 0], sets: [0, 0] });

export function addDealStats(stats, judged) {
  if (judged.allPass) return stats;
  stats.points[0] += judged.raw[0];
  stats.points[1] += judged.raw[1];
  if (judged.set) stats.sets[judged.bidderTeam] += 1;
  return stats;
}

/// One-line explanation of how a game ended.
export function explainEnd(reason, winner, teamNames, score) {
  const loser = otherTeam(winner);
  switch (reason) {
    case 'bid': return `${teamNames[winner]} bid and made it to reach ${score[winner]}.`;
    case 'fifteen': return `${teamNames[winner]} reach ${score[winner]} points.`;
    case 'minus': return `${teamNames[loser]} fall to ${score[loser]} and lose.`;
    default: return '';
  }
}

/// Note shown on the deal summary when a team is at 11+ but has not bid out.
export function pendingNote(score, teamNames) {
  const notes = [];
  for (let t = 0; t < 2; t++) {
    if (score[t] >= RULES.winBid && score[t] < RULES.winAny) {
      notes.push(`${teamNames[t]} have ${score[t]} but must bid and make it (or reach ${RULES.winAny}) to win.`);
    }
  }
  return notes.join(' ');
}
