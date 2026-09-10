// Single-player Setback: you (South) against three computer players.
import { Bid, Seat, SEAT_NAMES, TEAM_NAMES, TEAM_LONG_NAMES, teamOfSeat, seatIncr, Trick, Playout, OpenDeal, Game } from './engine.js';
import { chooseAction, chooseBid, choosePlay } from './ai.js';
import { coachBid, coachPlay, reviewBid, reviewPlay } from './coach.js';
import { newSeed, seededRng, replay } from './replay.js';
import { saveGameRecord } from './history.js';
import { judgeDeal, emptyStats, addDealStats } from './rules.js';
import { $, sleep, renderTable, resetTableCache, showScreen, showSheet, toast, dealSummaryHtml, gameOverHtml, rulesBlurb, tipHtml, nextTheme, themeLabel, soundOn, setSoundOn, cue, escapeHtml } from './view.js';

const USER = Seat.South;
const STORAGE_KEY = 'lis-setback-v2';
const OLD_KEY = 'lis-setback-v1';
const SETTINGS_KEY = 'lis-setback-settings-v1';
const rng = Math.random;
const NAMES = ['West', 'North (partner)', 'East', 'You'];
const COACH_NAMES = ['West', 'your partner', 'East', 'you'];

function load(key) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

let settings = Object.assign({ speed: 'normal', hints: false, coach: false }, load(SETTINGS_KEY) || {});
const hintsOn = () => settings.hints || settings.coach;
const saveSettings = () => store(SETTINGS_KEY, settings);

// Deals are seeded and every action is appended to `pers.log`, so a finished
// game is a move log (see replay.js) that can be saved and replayed.
function createDeal(log, dealer, seed = newSeed()) {
  if (log) log.push({ d: seed, l: dealer, t: Date.now() });
  return Game.create(seededRng(seed), dealer);
}
function nextDeal(game, allPass) {
  const seed = newSeed();
  if (allPass && pers.log && pers.log.length) pers.log[pers.log.length - 1].d = seed; // the pass that ended the auction carries the redeal
  else if (pers.log) pers.log.push({ d: seed, t: Date.now() });
  return Game.startNextDeal(seededRng(seed), game);
}

function freshState(seed = newSeed(), dealer = Seat.South) {
  const log = [];
  return {
    version: 2, gamesWon: [0, 0], finished: null, reason: null,
    game: createDeal(log, dealer, seed), log,
    stats: { game: emptyStats(), total: emptyStats() },
    scoreBefore: [0, 0],
  };
}
function validState(s) {
  try {
    return s && (s.version === 1 || s.version === 2) && Array.isArray(s.gamesWon) && s.game && s.game.Deal
      && s.game.Deal.ClosedDeal && Array.isArray(s.game.Deal.Hands) && s.game.Deal.Hands.length === 4
      && Array.isArray(s.game.Score);
  } catch { return false; }
}
let pers = load(STORAGE_KEY) || load(OLD_KEY);
if (!validState(pers)) pers = freshState();
if (pers.version === 1) {
  // carry over a v1 game; the game score before the current deal is the current score
  pers = { ...pers, version: 2, reason: null, stats: { game: emptyStats(), total: emptyStats() }, scoreBefore: pers.game.Score.slice() };
}
if (!Array.isArray(pers.log)) pers.log = null; // a game saved before logging existed cannot be recorded
const save = () => store(STORAGE_KEY, pers);

const timing = () => settings.speed === 'fast'
  ? { think: 120, bid: 260, play: 240, trickShow: 650, dealIn: 250 }
  : { think: 420, bid: 600, play: 520, trickShow: 1250, dealIn: 450 };

let numWorlds = 300;

const ui = { awaiting: null, hint: null, coach: null, coachRec: null, showTrick: null, trickWinner: null };

// ------------------------------------------------------------ tutorial
// A guided first hand: a fixed deal (you hold A K J 2 of clubs and a ten),
// short explanations at each new moment, and only the coach's choice tappable.
const TUT_SEED = 697;
const tut = { active: false, stage: 0, trickShown: false };
const tutSheet = (html) => showSheet(html + `<div class="actions"><button type="button" class="btn" data-action="go">Continue</button></div>`);

async function tutorialBeforeTurn(info) {
  const playing = !!info.Deal.Playout;
  if (!playing && tut.stage === 0) {
    tut.stage = 1;
    await tutSheet(`<h2>Your bid</h2>` +
      `<p>Each player bids once, in turn: Pass, 2, 3 or 4. A bid promises your team will take at least that many of the four points this deal. Fall short and you lose that many instead: you are <i>set back</i>. A bid of four cannot be outbid.</p>` +
      `<p>Look at your clubs: the ace is High, the jack is the Jack point, the deuce is a likely Low, and your ten is worth 10 toward Game. That is a hand to bid on. The coach has highlighted the bid to make; tap it.</p>`);
  } else if (playing && tut.stage === 1) {
    tut.stage = 2;
    const p = info.Deal.Playout;
    const iLead = p.CurrentTrick.Cards.length === 0 && p.Trump === null;
    await tutSheet(iLead
      ? `<h2>Your lead</h2><p>You won the bid, so you lead first, and the suit of your first card becomes trump for the whole deal.</p>` +
        `<p>Lead your highest club. The ace is certain to win High, and everyone must follow with a club if they have one, so it also pulls out their trumps. Tap the highlighted card.</p>`
      : `<h2>Play</h2><p>${escapeHtml(NAMES[p.Bidder].replace(' (partner)', ''))} won the bid and leads first; the suit of that first card is trump for the deal.</p>` +
        `<p>On each trick you must follow the suit led if you can, or play a trump. The highest trump wins the trick, otherwise the highest card of the suit led. The winner leads the next trick. Tap the highlighted card; the coach explains why.</p>`);
  }
}

async function tutorialAfterTrick(winnerSeat) {
  if (!tut.active || tut.trickShown) return;
  tut.trickShown = true;
  const who = winnerSeat === USER ? 'You' : NAMES[winnerSeat].replace(' (partner)', '');
  await tutSheet(`<h2>The trick</h2><p>${escapeHtml(who)} took that trick and lead${winnerSeat === USER ? '' : 's'} the next one.</p>` +
    `<p>The chips at the top show who holds each point so far: High, Low, Jack, and the running Game count. They can change hands until the deal ends, so a low trump is only safe once your side has taken the trick it was played in.</p>` +
    `<p>Keep tapping the highlighted card. Five more tricks to go.</p>`);
}

async function tutorialOutro() {
  tut.active = false;
  await tutSheet(`<h2>You have played a hand</h2>` +
    `<p>That is the whole game: bid, name trump with your lead, take the points, and keep score. First team to 11 wins, but only by bidding and making it on the deal that gets there; 15 wins any way; falling to -6 loses.</p>` +
    `<p>The coach stays on for the rest of this game, and from now on you can tap any legal card, not just its choice. Turn the coach off in the menu whenever you like.</p>`);
}

function vm() {
  const deal = pers.game.Deal;
  return {
    mySeat: USER, deal, handCounts: deal.Hands.map((h) => h.length), myHand: deal.Hands[USER],
    names: NAMES, connected: null, teamNames: TEAM_NAMES, teamShort: TEAM_NAMES,
    score: pers.game.Score, gamesWon: pers.gamesWon, sets: pers.stats.total.sets,
    showTrick: ui.showTrick, trickWinner: ui.trickWinner, awaiting: ui.awaiting, hint: ui.hint, coach: ui.coach,
    timerText: null, busy: false, prompt: null,
  };
}
const render = () => renderTable(vm());

// ---------------------------------------------------------------- menu

async function showMenu() {
  let armNew = false;
  const html = () =>
    `<h2>Single player</h2>` +
    `<div class="actions">` +
    `<button type="button" class="btn row" data-action="coach"><span>Coach mode<small>Explains the recommended bid or card, then reviews your choice</small></span><span>${settings.coach ? 'On' : 'Off'}</span></button>` +
    `<button type="button" class="btn row" data-action="hints"><span>Hints only<small>★ marks the computer's choice, no explanation</small></span><span>${settings.hints ? 'On' : 'Off'}</span></button>` +
    `<button type="button" class="btn row" data-action="speed"><span>Speed</span><span>${settings.speed === 'fast' ? 'Fast' : 'Normal'}</span></button>` +
    `<button type="button" class="btn row" data-action="theme"><span>Table color</span><span>${themeLabel()}</span></button>` +
    `<button type="button" class="btn row" data-action="sound"><span>Sound &amp; vibration<small>A soft cue when it is your turn</small></span><span>${soundOn() ? 'On' : 'Off'}</span></button>` +
    `<a class="btn secondary row" href="rules.html" style="text-decoration:none;display:flex"><span>Rules of Setback</span><span>›</span></a>` +
    `<button type="button" class="btn secondary" data-action="home">Back to start (single / multiplayer)</button>` +
    `<button type="button" class="btn danger" data-action="newgame">${armNew ? 'Tap again to abandon this game' : 'Abandon this game and start over'}</button>` +
    `<button type="button" class="btn secondary" data-action="close">Close</button>` +
    `</div>` + rulesBlurb() +
    `<p class="credit">You play South; North is your partner. Heavily modified from Brian Berns' Setback ` +
    `<a href="https://github.com/brianberns/Setback" target="_blank" rel="noopener">rules engine</a>. ` +
    `The computer players use a Monte Carlo search that runs entirely on your phone. Progress is saved on this device.</p>` + tipHtml();
  while (true) {
    const action = await showSheet(html());
    if (action === 'hints') { settings.hints = !settings.hints; saveSettings(); if (ui.awaiting && hintsOn()) requestHint(); if (!hintsOn()) { ui.hint = null; render(); } continue; }
    if (action === 'coach') {
      settings.coach = !settings.coach; saveSettings();
      if (settings.coach) { if (ui.awaiting) requestHint(); }
      else { ui.coach = null; ui.coachRec = null; if (!settings.hints) ui.hint = null; render(); }
      continue;
    }
    if (action === 'speed') { settings.speed = settings.speed === 'fast' ? 'normal' : 'fast'; saveSettings(); continue; }
    if (action === 'theme') { nextTheme(); continue; }
    if (action === 'sound') { setSoundOn(!soundOn()); if (soundOn()) cue('turn'); continue; }
    if (action === 'home') { location.hash = ''; location.reload(); return; }
    if (action === 'newgame') {
      if (!armNew) { armNew = true; continue; }
      {
        pers.log = [];
        pers.game = createDeal(pers.log, seatIncr(1, pers.game.Deal.ClosedDeal.Auction.Dealer));
        pers.finished = null; pers.reason = null; pers.stats.game = emptyStats(); pers.scoreBefore = [0, 0];
        save();
        location.reload();
      }
      return;
    }
    return;
  }
}

// ------------------------------------------------------------ game flow

let hintToken = 0;
async function requestHint() {
  if (!hintsOn() || !ui.awaiting) return;
  const token = ++hintToken;
  await sleep(30);
  if (!ui.awaiting || token !== hintToken) return;
  const info = Game.currentInfoSet(pers.game);
  const playing = !!info.Deal.Playout;
  const rec = playing ? choosePlay(info, rng, numWorlds) : chooseBid(info, rng, numWorlds);
  if (!ui.awaiting || token !== hintToken) return;
  ui.hint = playing ? { card: rec.card } : { bid: rec.bid };
  if (settings.coach) {
    const c = playing ? coachPlay(info, rec, COACH_NAMES) : coachBid(info, rec, COACH_NAMES);
    ui.coach = c.html;
    ui.coachRec = { rec, short: c.short, playing };
  }
  render();
}

async function userAction(info) {
  cue('turn');
  if (tut.active) await tutorialBeforeTurn(info);
  let legal = info.LegalActions;
  if (tut.active && legal.length > 1) {
    // only the coach's choice can be tapped during the guided hand
    const playing = !!info.Deal.Playout;
    const rec = playing ? choosePlay(info, rng, numWorlds) : chooseBid(info, rng, numWorlds);
    const c = playing ? coachPlay(info, rec, COACH_NAMES) : coachBid(info, rec, COACH_NAMES);
    ui.hint = playing ? { card: rec.card } : { bid: rec.bid };
    ui.coach = c.html;
    ui.coachRec = { rec, short: c.short, playing };
    legal = legal.filter((a) => (playing ? a.card === rec.card : a.bid === rec.bid));
  }
  return new Promise((resolve) => {
    ui.awaiting = {
      type: info.Deal.Playout ? 'play' : 'bid',
      legal,
      resolve: (a) => {
        let review = null;
        if (settings.coach && ui.coachRec) {
          const { rec, short, playing } = ui.coachRec;
          review = playing ? reviewPlay(rec, a.card, short) : reviewBid(rec, a.bid, short);
        }
        ui.awaiting = null; ui.hint = null; ui.coach = review; ui.coachRec = null; hintToken++;
        resolve(a);
      },
    };
    render();
    if (!tut.active) requestHint();
  });
}

async function aiAction(info) {
  render();
  await sleep(timing().think);
  const t0 = performance.now();
  const { action } = chooseAction(info, rng, numWorlds);
  const dt = performance.now() - t0;
  // More sampled worlds play measurably better (300 beat 100 worlds 57-43 in
  // self-play), so grow the budget while decisions stay quick on this device.
  if (dt > 400 && numWorlds > 32) numWorlds = Math.max(32, Math.floor(numWorlds * 0.7));
  else if (dt < 200 && numWorlds < 800) numWorlds = Math.min(800, Math.floor(numWorlds * 1.25));
  return action;
}

async function applyAction(action) {
  if (pers.log) pers.log.push(action.bid !== undefined ? { b: action.bid, t: Date.now() } : { c: action.card, t: Date.now() });
  const before = pers.game;
  pers.game = Game.addAction(action, pers.game);
  save();
  const t = timing();
  if (action.bid !== undefined) { render(); await sleep(t.bid); return; }
  const pBefore = before.Deal.ClosedDeal.Playout;
  const trump = pBefore.Trump === null ? Math.floor(action.card / 13) : pBefore.Trump;
  const trickAfter = Trick.addPlay(trump, action.card, pBefore.CurrentTrick);
  if (Trick.isComplete(trickAfter)) {
    ui.showTrick = trickAfter; render();
    await sleep(t.play);
    ui.trickWinner = trickAfter.HighPlay.seat; render();
    await sleep(t.trickShow);
    if (tut.active && !tut.trickShown) await tutorialAfterTrick(trickAfter.HighPlay.seat);
    ui.showTrick = null; ui.trickWinner = null; render();
  } else {
    render();
    await sleep(t.play);
  }
}

async function runDeal() {
  render();
  if (Playout.numCardsPlayed(pers.game.Deal.ClosedDeal.Playout || { CompletedTricks: [], CurrentTrick: null }) === 0
      && pers.game.Deal.ClosedDeal.Auction.Bids.length === 0) {
    await sleep(timing().dealIn);
  }
  while (!OpenDeal.isComplete(pers.game.Deal)) {
    const info = Game.currentInfoSet(pers.game);
    const action = info.Player === USER ? await userAction(info) : await aiAction(info);
    await applyAction(action);
  }
  const cd = pers.game.Deal.ClosedDeal;
  ui.coach = null; ui.coachRec = null;
  render();
  if (cd.Auction.HighBid === Bid.Pass) {
    await toast('Everyone passed — dealing again', 1500);
    return null;
  }
  const judged = judgeDeal(pers.scoreBefore, cd);
  if (!pers.dealCounted) {
    addDealStats(pers.stats.game, judged);
    addDealStats(pers.stats.total, judged);
    pers.dealCounted = true;
    save();
  }
  await showSheet(dealSummaryHtml(judged, NAMES.map((n) => n.replace(' (partner)', '')), TEAM_LONG_NAMES) +
    `<div class="actions"><button type="button" class="btn" data-action="next">${judged.winner === null ? 'Next deal' : 'See result'}</button></div>`);
  if (tut.active) await tutorialOutro();
  return judged;
}

/// Saves the finished game to the device history if its log replays cleanly.
function recordGame(winner) {
  if (!pers.log || !pers.log.length) return;
  const chk = replay(pers.log);
  if (chk.corrupt || !chk.game || JSON.stringify(chk.game.Score) !== JSON.stringify(pers.game.Score)) {
    console.warn('history: the game log did not replay to the final score; not saved');
    return;
  }
  saveGameRecord({
    id: 's' + Date.now(), t: Date.now(), mode: 'single', mySeat: USER,
    names: ['West', 'North', 'East', 'You'], teamNames: TEAM_LONG_NAMES,
    moves: pers.log, winner, score: pers.game.Score.slice(), reason: pers.reason,
  });
}

async function runGame() {
  while (true) {
    let judged = null;
    if (pers.finished === null) judged = await runDeal();
    const winner = pers.finished !== null ? pers.finished : judged ? judged.winner : null;
    if (winner !== null) {
      if (pers.finished === null) {
        pers.finished = winner;
        pers.reason = judged.reason;
        pers.gamesWon[winner] += 1;
        save();
        recordGame(winner);
      }
      render();
      await showSheet(gameOverHtml(winner, pers.reason, TEAM_LONG_NAMES, pers.game.Score, pers.stats.game, pers.stats.total, pers.gamesWon, teamOfSeat(USER)) +
        `<div class="actions"><button type="button" class="btn" data-action="next">New game</button></div>`);
      pers.log = [];
      pers.game = createDeal(pers.log, seatIncr(1, pers.game.Deal.ClosedDeal.Auction.Dealer));
      pers.finished = null; pers.reason = null; pers.stats.game = emptyStats(); pers.scoreBefore = [0, 0]; pers.dealCounted = false;
      save();
      resetTableCache();
      return;
    }
    pers.game = nextDeal(pers.game, judged === null);
    pers.scoreBefore = pers.game.Score.slice();
    pers.dealCounted = false;
    save();
  }
}

export async function startSingle(opts = {}) {
  if (opts.tutorial) {
    pers = freshState(TUT_SEED, Seat.West); // West deals: North bids first, you bid third
    save();
    tut.active = true; tut.stage = 0; tut.trickShown = false;
    settings.coach = true; saveSettings();
  }
  showScreen('table');
  resetTableCache();
  $('hand').onclick = (e) => {
    const btn = e.target.closest('[data-card]');
    if (!btn || !ui.awaiting || ui.awaiting.type !== 'play') return;
    const legal = ui.awaiting.legal.find((a) => a.card === Number(btn.dataset.card));
    if (legal) ui.awaiting.resolve(legal);
  };
  $('bidPanel').onclick = (e) => {
    const btn = e.target.closest('[data-bid]');
    if (!btn || btn.disabled || !ui.awaiting || ui.awaiting.type !== 'bid') return;
    const legal = ui.awaiting.legal.find((a) => a.bid === Number(btn.dataset.bid));
    if (legal) ui.awaiting.resolve(legal);
  };
  $('menuBtn').onclick = () => { if ($('overlay').hidden) showMenu(); };

  try {
    if (opts.tutorial) {
      render();
      await tutSheet(`<h2>Learn to play</h2>` +
        `<p>Setback is a trick-taking card game for four in two teams. You sit at the bottom, South; North, across the table, is your partner.</p>` +
        `<p>Each deal has three parts: <b>bid</b> for how many of the four points your team will take, <b>play</b> six tricks, then <b>score</b>. ` +
        `The four points are <b>High</b> and <b>Low</b> (the highest and lowest trump in play), <b>Jack</b> (the jack of trump), and <b>Game</b> (the most card points taken in tricks: tens count 10, aces 4, kings 3, queens 2, jacks 1).</p>` +
        `<p>The coach will explain each move and highlight what to tap. Let's deal.</p>`);
    }
    while (true) await runGame();
  } catch (err) {
    console.error(err);
    const action = await showSheet(`<h2>Something went wrong</h2><p class="sub">${String(err && err.message || err)}</p>` +
      `<div class="actions"><button type="button" class="btn" data-action="reset">Reset the game</button></div>`);
    if (action === 'reset') { pers = freshState(); save(); location.reload(); }
  }
}
