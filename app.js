// Setback entry point: start screen, then single- or multi-player.
import { setScreenHtml, $, tipHtml, applyTheme, getTheme, escapeHtml, armTap } from './view.js';
import { teamOfSeat } from './engine.js';
import { loadHistory, computeStats, clearHistory, fmtDate } from './history.js';
import { openReplay } from './replayview.js';
import { startSingle } from './single.js';
import { startMulti } from './multi.js';
import { makeStore } from './store.js';

function homeHtml(multiNote) {
  // three static cards: the ace, jack and deuce of trump, i.e. High, Jack and Low
  const card = (rank, cls) =>
    `<span class="card ${cls}" aria-hidden="true"><span class="corner tl">${rank}<small>♠</small></span>` +
    `<span class="pip">${cls ? rank : '♠'}</span><span class="corner br">${rank}<small>♠</small></span></span>`;
  return `<div class="panel home">` +
    `<div class="fan">${card('2', '')}${card('A', '')}${card('J', 'face')}</div>` +
    `<h1>Setback</h1>` +
    `<div class="tagline">Auction Pitch for four</div>` +
    `<p class="sub">Bid, name trump, and take High, Low, Jack and Game.</p>` +
    `<div class="actions">` +
    `<button type="button" class="btn big" data-action="single">Single player<small>Three computer players, with an optional coach</small></button>` +
    `<button type="button" class="btn big secondary" data-action="multi">Multiplayer<small>Quick play with anyone, or friends with a code</small></button>` +
    `</div>` +
    (multiNote ? `<p class="error">${multiNote}</p>` : '') +
    `<p class="credit"><a href="#history" data-action="history">History &amp; stats</a> &nbsp;·&nbsp; <a href="rules.html">Rules of Setback</a> &nbsp;·&nbsp; ` +
    `Heavily modified from Brian Berns' Setback <a href="https://github.com/brianberns/Setback" target="_blank" rel="noopener">rules engine</a></p>` +
    tipHtml() +
    `</div>`;
}

async function goMulti(joinCode) {
  let storeImpl = null;
  try { storeImpl = await makeStore(); } catch (err) { console.error(err); }
  if (!storeImpl) {
    setScreenHtml(homeHtml('Multiplayer is not set up on this site yet (no Firebase configuration).'));
    bindHome();
    return;
  }
  await startMulti(storeImpl, joinCode);
}

function bindHome() {
  $('screen').onclick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'single') { location.hash = '#single'; startSingle(); }
    if (btn.dataset.action === 'multi') { location.hash = '#multi'; goMulti(null); }
    if (btn.dataset.action === 'history') { e.preventDefault(); location.hash = '#history'; showHistory(); }
  };
}

function showHome() {
  location.hash = '';
  setScreenHtml(homeHtml(''));
  bindHome();
}

/// History & stats screen: saved games on this device, tap one to replay it.
function showHistory() {
  const list = loadHistory();
  const s = computeStats(list);
  const pct = s.games ? Math.round((100 * s.won) / s.games) : 0;
  const stat = (v, l) => `<div class="stat"><span class="v">${v}</span><span class="l">${l}</span></div>`;
  const modeName = { single: 'single player', multi: 'with friends', quick: 'quick play' };
  const rows = list.map((r, i) => {
    const team = teamOfSeat(r.mySeat), won = r.winner === team;
    const sc = r.score ? `${r.score[team]} to ${r.score[1 - team]}` : '';
    return `<li><button type="button" data-open="${i}"><span class="res ${won ? 'won' : ''}">${won ? 'Won' : 'Lost'}</span>` +
      `<span class="who">${escapeHtml(r.teamNames[team])}<small>vs ${escapeHtml(r.teamNames[1 - team])} · ${sc} · ${modeName[r.mode] || r.mode}</small></span>` +
      `<span class="when">${fmtDate(r.t)}</span></button></li>`;
  }).join('');
  setScreenHtml(`<div class="panel"><button type="button" class="link-btn" data-action="home">‹ Back</button><h1>History</h1>` +
    (s.games
      ? `<div class="stats">${stat(s.games, 'games')}${stat(pct + '%', 'won')}${stat(s.deals, 'deals')}` +
        `${stat(s.bids.won, 'bids won')}${stat(s.bids.won ? Math.round((100 * s.bids.made) / s.bids.won) + '%' : '–', 'bids made')}` +
        `${stat(s.deals ? (s.myPoints / s.deals).toFixed(1) : '–', 'pts per deal')}</div>`
      : `<p class="sub">Finished games are saved here on this device. Open one to step through it move by move with the coach.</p>`) +
    `<h3>Games <span class="sub">(${list.length})</span></h3>` +
    (list.length ? `<ul class="games">${rows}</ul>` : `<p class="sub">None yet. Play a game to the end and it will appear here.</p>`) +
    (list.length ? `<div class="actions"><button type="button" class="btn danger" data-action="clear">Clear history</button></div>` : '') +
    `</div>`);
  $('screen').onclick = (e) => {
    const b = e.target.closest('[data-open],[data-action]');
    if (!b) return;
    if (b.dataset.open !== undefined) { openReplay(list[Number(b.dataset.open)], () => showHistory()); return; }
    if (b.dataset.action === 'home') showHome();
    if (b.dataset.action === 'clear' && armTap(b, 'Tap again to clear')) { clearHistory(); showHistory(); }
  };
}

async function main() {
  applyTheme(getTheme());
  const hash = location.hash || '';
  if (hash === '#history') { showHistory(); return; }
  const join = hash.match(/^#join=([A-Za-z0-9]{5})$/);
  const kv = new URLSearchParams(location.search).get('local') === '1' ? sessionStorage : localStorage;
  const savedRoom = (() => { try { return JSON.parse(kv.getItem('lis-setback-room') || 'null'); } catch { return null; } })();
  if (join) { await goMulti(join[1].toUpperCase()); return; }
  if (hash === '#single') { startSingle(); return; }
  if (hash === '#multi' || savedRoom) { await goMulti(null); return; }
  setScreenHtml(homeHtml(''));
  bindHome();
}

main();
