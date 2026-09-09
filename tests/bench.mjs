import * as E from '../engine.js';
import * as AI from '../ai.js';
const { Game, OpenDeal, Team } = E;
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const N = parseInt(process.argv[2] || '100'); const W = parseInt(process.argv[3] || '200'); const mode = process.argv[4] || 'baseline';
const rng = mulberry32(99);
let ewWins = 0, deals = 0, maxMs = 0, totMs = 0, nDec = 0;
const t1 = Date.now();
for (let g = 0; g < N; g++) {
  let gm = Game.create(rng, g % 4);
  while (true) {
    const info = Game.currentInfoSet(gm);
    let act;
    if (info.LegalActions.length === 1) act = info.LegalActions[0];
    else if (E.teamOfSeat(info.Player) === Team.EastWest) { const s = performance.now(); act = AI.chooseAction(info, rng, W).action; const d = performance.now() - s; maxMs = Math.max(maxMs, d); totMs += d; nDec++; }
    else act = mode === 'baseline' ? AI.policyAction(info, rng) : AI.chooseAction(info, rng, parseInt(mode)).action;
    gm = Game.addAction(act, gm);
    if (OpenDeal.isComplete(gm.Deal)) {
      deals++;
      const w = Game.tryGetWinningTeam(gm);
      if (w !== null) { if (w === Team.EastWest) ewWins++; break; }
      gm = Game.startNextDeal(rng, gm);
    }
  }
}
console.log(`MC(${W}) as E+W vs ${mode}: won ${ewWins}/${N} (${(100*ewWins/N).toFixed(0)}%), ${deals} deals, avg decision ${(totMs/nDec).toFixed(1)}ms max ${maxMs.toFixed(0)}ms, total ${Date.now()-t1}ms`);
