// Single-player Setback: you (South) against three computer players.
import { Bid, Seat, SEAT_NAMES, TEAM_NAMES, TEAM_LONG_NAMES, teamOfSeat, seatIncr, Trick, Playout, OpenDeal, Game } from './engine.js';
import { chooseAction, chooseBid, choosePlay } from './ai.js';
import { coachBid, coachPlay, reviewBid, reviewPlay } from './coach.js';
import { judgeDeal, emptyStats, addDealStats } from './rules.js';
import { $, sleep, renderTable, resetTableCache, showScreen, showSheet, toast, dealSummaryHtml, gameOverHtml, rulesBlurb, tipHtml } from './view.js';

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

function freshState() {
  return {
    version: 2, gamesWon: [0, 0], finished: null, reason: null,
    game: Game.create(rng, Seat.South),
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
const save = () => store(STORAGE_KEY, pers);

const timing = () => settings.speed === 'fast'
  ? { think: 120, bid: 260, play: 240, trickShow: 650, dealIn: 250 }
  : { think: 420, bid: 600, play: 520, trickShow: 1250, dealIn: 450 };

let numWorlds = 300;

const ui = { awaiting: null, hint: null, coach: null, coachRec: null, showTrick: null, trickWinner: null };

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
  const html = () =>
    `<h2>Single player</h2>` +
    `<div class="actions">` +
    `<button type="button" class="btn row" data-action="coach"><span>Coach mode<small>Explains the recommended bid or card, then reviews your choice</small></span><span>${settings.coach ? 'On' : 'Off'}</span></button>` +
    `<button type="button" class="btn row" data-action="hints"><span>Hints only<small>★ marks the computer's choice, no explanation</small></span><span>${settings.hints ? 'On' : 'Off'}</span></button>` +
    `<button type="button" class="btn row" data-action="speed"><span>Speed</span><span>${settings.speed === 'fast' ? 'Fast' : 'Normal'}</span></button>` +
    `<a class="btn secondary row" href="rules.html" style="text-decoration:none;display:flex"><span>Rules of Setback</span><span>›</span></a>` +
    `<button type="button" class="btn secondary" data-action="home">Back to start (single / multiplayer)</button>` +
    `<button type="button" class="btn danger" data-action="newgame">Abandon this game and start over</button>` +
    `<button type="button" class="btn secondary" data-action="close">Close</button>` +
    `</div>` + rulesBlurb() +
    `<p class="credit">You play South; North is your partner. Rules and scoring follow ` +
    `<a href="https://www.bernsrite.com/Setback/" target="_blank" rel="noopener">Brian Berns' Setback</a>, whose F# game engine ` +
    `(<a href="https://github.com/brianberns/Setback" target="_blank" rel="noopener">source</a>) this page ports to JavaScript. ` +
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
    if (action === 'home') { location.hash = ''; location.reload(); return; }
    if (action === 'newgame') {
      if (confirm('Abandon the current game and start a new one? Running totals are kept.')) {
        pers.game = Game.create(rng, seatIncr(1, pers.game.Deal.ClosedDeal.Auction.Dealer));
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

function userAction(info) {
  return new Promise((resolve) => {
    ui.awaiting = {
      type: info.Deal.Playout ? 'play' : 'bid',
      legal: info.LegalActions,
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
    requestHint();
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
  return judged;
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
      }
      render();
      await showSheet(gameOverHtml(winner, pers.reason, TEAM_LONG_NAMES, pers.game.Score, pers.stats.game, pers.stats.total, pers.gamesWon, teamOfSeat(USER)) +
        `<div class="actions"><button type="button" class="btn" data-action="next">New game</button></div>`);
      pers.game = Game.create(rng, seatIncr(1, pers.game.Deal.ClosedDeal.Auction.Dealer));
      pers.finished = null; pers.reason = null; pers.stats.game = emptyStats(); pers.scoreBefore = [0, 0]; pers.dealCounted = false;
      save();
      resetTableCache();
      return;
    }
    pers.game = Game.startNextDeal(rng, pers.game);
    pers.scoreBefore = pers.game.Score.slice();
    pers.dealCounted = false;
    save();
  }
}

export async function startSingle() {
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
    while (true) await runGame();
  } catch (err) {
    console.error(err);
    const action = await showSheet(`<h2>Something went wrong</h2><p class="sub">${String(err && err.message || err)}</p>` +
      `<div class="actions"><button type="button" class="btn" data-action="reset">Reset the game</button></div>`);
    if (action === 'reset') { pers = freshState(); save(); location.reload(); }
  }
}
