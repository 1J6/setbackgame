// Setback entry point: start screen, then single- or multi-player.
import { setScreenHtml, $ } from './view.js';
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
    `<button type="button" class="btn big" data-action="single">Single player<small>You and three computer players</small></button>` +
    `<button type="button" class="btn big secondary" data-action="multi">Multiplayer<small>Four friends, one room code</small></button>` +
    `</div>` +
    (multiNote ? `<p class="error">${multiNote}</p>` : '') +
    `<p class="credit"><a href="rules.html">Rules of Setback</a> &nbsp;·&nbsp; ` +
    `Engine ported from <a href="https://github.com/brianberns/Setback" target="_blank" rel="noopener">Brian Berns' Setback</a></p>` +
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
  };
}

async function main() {
  const hash = location.hash || '';
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
