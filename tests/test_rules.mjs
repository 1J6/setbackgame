import { judgeScore, judgeDeal, RULES } from '../rules.js';
let f = 0; const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { f++; console.log('FAIL', m, JSON.stringify(a), '!=', JSON.stringify(b)); } };
// bid to win
eq(judgeScore([11, 5], 0, true), { winner: 0, reason: 'bid' }, 'bidder made to 11 wins');
eq(judgeScore([11, 5], 1, true), { winner: null, reason: null }, 'non-bidder at 11 does not win');
eq(judgeScore([11, 5], 0, false), { winner: null, reason: null }, 'bidder at 11 but set (score would have dropped) does not win');
eq(judgeScore([12, 5], 1, false), { winner: null, reason: null }, 'garbage 12 does not win');
// fifteen
eq(judgeScore([15, 5], 1, false), { winner: 0, reason: 'fifteen' }, '15 any way wins');
eq(judgeScore([15, 5], 1, true), { winner: 0, reason: 'fifteen' }, '15 wins when other team bid but is below 11');
eq(judgeScore([15, 11], 1, true), { winner: 1, reason: 'bid' }, 'bidder made to 11 beats other reaching 15');
// minus six
eq(judgeScore([-6, 3], 0, false), { winner: 1, reason: 'minus' }, '-6 loses');
eq(judgeScore([-7, 15], 0, false), { winner: 1, reason: 'minus' }, '-7 loses (other also at 15)');
eq(judgeScore([3, -6], 1, false), { winner: 0, reason: 'minus' }, 'team 1 at -6 loses');
eq(judgeScore([10, 10], 0, true), { winner: null, reason: null }, '10 is not enough');
console.log(f === 0 ? 'RULES OK' : f + ' failures');
process.exit(f ? 1 : 0);
