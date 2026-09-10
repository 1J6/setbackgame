// Shared table rendering for single- and multi-player Setback.
// The table is drawn relative to `mySeat`, which always sits at the bottom.
import {
  Card, Rank, Bid, ALL_BIDS, BID_NAMES, SEAT_NAMES, SUIT_CHARS, SUIT_NAMES,
  seatIncr, Auction, Trick, Playout, ClosedDeal,
} from './engine.js';
import { RULES, explainEnd, pendingNote } from './rules.js';

export const $ = (id) => document.getElementById(id);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Screen position of an engine seat: 0 left, 1 top, 2 right, 3 bottom.
export const screenPos = (seat, mySeat) => (seat - mySeat + 3) % 4;

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- screens

export function showScreen(name) {
  $('screen').hidden = name !== 'screen';
  $('app').hidden = name !== 'table';
}

export function setScreenHtml(html) {
  $('screen').innerHTML = html;
  showScreen('screen');
}

// ------------------------------------------------------------------ cards

const isRed = (card) => Card.suit(card) === 1 || Card.suit(card) === 2;
const rankChar = (rank) => (rank === 10 ? '10' : 'JQKA'[rank - 11] || String(rank));
export const suitHtml = (suit) => `<span class="${suit === 1 || suit === 2 ? 'suit-red' : ''}">${SUIT_CHARS[suit]}</span>`;
export const cardText = (card) => rankChar(Card.rank(card)) + SUIT_CHARS[Card.suit(card)];

function cardHtml(card, classes = '', attrs = '') {
  const suit = Card.suit(card), rank = Card.rank(card);
  const face = rank >= Rank.Jack;
  const cls = `card ${isRed(card) ? 'red' : ''} ${face ? 'face' : ''} ${classes}`;
  const rc = rankChar(rank), sc = SUIT_CHARS[suit];
  return `<button type="button" class="${cls}" data-card="${card}" aria-label="${rc} of ${SUIT_NAMES[suit]}" ${attrs}>` +
    `<span class="corner tl">${rc}<small>${sc}</small></span>` +
    `<span class="pip">${face ? rc : sc}</span>` +
    `<span class="corner br">${rc}<small>${sc}</small></span>` +
    `</button>`;
}

// sort hand for display: trump first, then alternating colours, high to low
function sortedHand(hand, trump) {
  const order = [3, 2, 0, 1]; // ♠ ♥ ♣ ♦
  if (trump !== null && trump !== undefined) {
    order.splice(order.indexOf(trump), 1);
    order.unshift(trump);
  }
  return hand.slice().sort((a, b) => {
    const sa = order.indexOf(Card.suit(a)), sb = order.indexOf(Card.suit(b));
    if (sa !== sb) return sa - sb;
    return Card.rank(b) - Card.rank(a);
  });
}

// ------------------------------------------------------------------ table

/**
 * vm = {
 *   mySeat, deal (OpenDeal; other hands may be empty), handCounts[4], myHand,
 *   names[4], connected[4]|null, teamNames[2], score[2], gamesWon[2], sets[2],
 *   showTrick, trickWinner, awaiting {type, legal}|null, hint, timerText|null,
 *   busy (ignore taps), prompt (override text)|null
 * }
 */
export function renderTable(vm) {
  const { mySeat, deal } = vm;
  const cd = deal.ClosedDeal;
  const auction = cd.Auction;
  const playout = cd.Playout;
  const trump = playout ? playout.Trump : null;
  const complete = ClosedDeal.isComplete(cd);
  const current = complete ? null : ClosedDeal.currentPlayer(cd);
  const nm = (seat) => escapeHtml(vm.names[seat]);

  // header
  for (let t = 0; t < 2; t++) {
    $('team' + t + 'Lbl').textContent = vm.teamNames[t];
    $('team' + t + 'Score').textContent = vm.score[t];
    $('team' + t + 'Games').textContent = vm.gamesWon ? vm.gamesWon[t] : '';
    $('team' + t + 'Sets').textContent = vm.sets ? vm.sets[t] : '';
  }

  // contract line
  let contract;
  if (playout) {
    const b = auction.HighBidder;
    contract = `<strong>${nm(b)} bid ${auction.HighBid}</strong><br>` +
      (trump !== null ? `Trump ${suitHtml(trump)} ${SUIT_NAMES[trump]}` : 'Trump: first card led');
  } else if (Auction.isComplete(auction)) {
    contract = '<strong>Everyone passed</strong>';
  } else {
    contract = `Bidding<br><span style="opacity:.75">${nm(auction.Dealer)} dealt</span>`;
  }
  $('contract').innerHTML = contract;

  // status chips: which card holds each point so far
  const status = $('status');
  if (playout) {
    const h = Playout.pointHolders(playout);
    const g = playout.GameScore;
    const cardTag = (rank) => trump === null || rank === undefined ? '' :
      `<span class="pt-card ${trump === 1 || trump === 2 ? 'suit-red' : ''}">${rankChar(rank)}${SUIT_CHARS[trump]}</span> `;
    const chip = (label, team, rank) => {
      const cls = team === null ? '' : team === 0 ? 'ew' : 'ns';
      return `<span class="chip ${cls}">${label} ${team === null ? '' : cardTag(rank)}<b>${team === null ? '–' : escapeHtml(vm.teamShort[team])}</b></span>`;
    };
    status.innerHTML =
      chip('High', h.High, playout.HighTrump ? playout.HighTrump.rank : undefined) +
      chip('Low', h.Low, playout.LowTrump ? playout.LowTrump.rank : undefined) +
      chip('Jack', h.Jack, h.Jack === null ? undefined : Rank.Jack) +
      `<span class="chip">Game <b>${g[0]}</b> · <b>${g[1]}</b></span>`;
  } else {
    status.innerHTML = '<span class="chip">High · Low · Jack · Game</span>';
  }

  // seats (rebuilt only when their content changes)
  const bidsBySeat = new Map(Auction.playerBids(auction));
  for (let seat = 0; seat < 4; seat++) {
    const el = $('seatPos' + screenPos(seat, mySeat));
    const isActive = current === seat && !complete;
    const isWinner = vm.trickWinner === seat;
    let dot = '';
    if (vm.connected) dot = `<span class="dot ${vm.connected[seat] ? 'on' : 'off'}" title="${vm.connected[seat] ? 'connected' : 'not connected'}"></span>`;
    const timer = vm.timerText && isActive && seat !== mySeat ? `<span class="timer">${vm.timerText}</span>` : '';
    let html = `<div class="name">${auction.Dealer === seat ? '<span class="dealer-badge" title="Dealer">D</span>' : ''}${dot}${nm(seat)}${timer}</div>`;
    if (vm.speech && vm.speech[seat]) html += `<div class="speech">${escapeHtml(vm.speech[seat])}</div>`;
    if (seat !== mySeat) {
      const n = vm.handCounts[seat];
      html += `<div class="backs" aria-label="${n} cards">${'<span class="mini-back"></span>'.repeat(n)}</div>`;
    }
    let bubbleText = '';
    if (bidsBySeat.has(seat) && !(playout && Playout.numCardsPlayed(playout) >= 4)) {
      const bid = bidsBySeat.get(seat);
      const won = playout && auction.HighBidder === seat;
      bubbleText = bid === Bid.Pass ? 'Pass' : String(bid);
      const isNew = el.dataset.bubble !== bubbleText;
      html += `<div class="bubble ${bid === Bid.Pass ? 'pass' : ''} ${won ? 'won' : ''} ${isNew ? 'pop' : ''}">${bubbleText}</div>`;
    } else if (playout && auction.HighBidder === seat) {
      bubbleText = `bid ${auction.HighBid}`;
      html += `<div class="bubble won">${bubbleText}</div>`;
    }
    if (el.dataset.key !== html) {
      el.innerHTML = html;
      el.dataset.key = html;
      el.dataset.bubble = bubbleText;
    }
    el.classList.toggle('active', isActive);
    el.classList.toggle('winner', isWinner);
  }

  // trick (slots rebuilt only when content changes so cards pop once)
  const trick = vm.showTrick || (playout ? playout.CurrentTrick : null);
  const plays = trick ? Trick.plays(trick) : [];
  const winnerSeat = trick && vm.trickWinner !== null && vm.trickWinner !== undefined && Trick.isComplete(trick) ? trick.HighPlay.seat : null;
  const slotKeys = ['', '', '', ''];
  plays.forEach(([seat, card], i) => {
    const cls = `small ${Card.suit(card) === trump ? 'trump' : ''} ${winnerSeat === seat ? 'win' : ''}`;
    slotKeys[screenPos(seat, mySeat)] = `${card}|${cls}|${i}`;
  });
  for (let pos = 0; pos < 4; pos++) {
    const slot = $('slotPos' + pos);
    if (slot.dataset.key === slotKeys[pos]) continue;
    if (!slotKeys[pos]) {
      slot.innerHTML = '';
    } else {
      const [card, cls, i] = slotKeys[pos].split('|');
      const isNew = slot.dataset.card !== card;
      slot.innerHTML = cardHtml(Number(card), cls + (isNew ? ' pop' : ''), `style="z-index:${Number(i) + 1}" tabindex="-1"`);
    }
    slot.dataset.key = slotKeys[pos];
    slot.dataset.card = slotKeys[pos] ? slotKeys[pos].split('|')[0] : '';
  }

  // hand
  const handEl = $('hand');
  const hand = sortedHand(vm.myHand, trump);
  const awaitingPlay = !!(vm.awaiting && vm.awaiting.type === 'play' && !vm.busy);
  const legalSet = new Set(awaitingPlay ? vm.awaiting.legal.map((a) => a.card) : []);
  const hintCard = vm.hint && vm.hint.card !== undefined ? vm.hint.card : null;
  let handHtml = '';
  hand.forEach((card) => {
    let cls = Card.suit(card) === trump ? 'trump' : '';
    if (awaitingPlay) cls += legalSet.has(card) ? ' legal' : ' dim';
    if (hintCard === card) cls += ' hint';
    handHtml += cardHtml(card, cls);
  });
  if (handEl.dataset.key !== handHtml) {
    handEl.innerHTML = handHtml;
    handEl.dataset.key = handHtml;
  }

  // coach (single-player tutorial text)
  const coach = $('coach');
  if (vm.coach) {
    if (coach.dataset.key !== vm.coach) {
      coach.innerHTML = `<span class="coach-lbl">Coach</span>${vm.coach}`;
      coach.dataset.key = vm.coach;
    }
    coach.hidden = false;
  } else {
    coach.hidden = true;
    coach.dataset.key = '';
  }

  // prompt
  const prompt = $('prompt');
  prompt.classList.remove('you');
  const t = vm.timerText ? ` · ${vm.timerText}` : '';
  if (vm.prompt) prompt.textContent = vm.prompt;
  else if (vm.awaiting && vm.awaiting.type === 'bid' && !vm.busy) { prompt.textContent = 'Your bid' + t; prompt.classList.add('you'); }
  else if (awaitingPlay) {
    const lead = trick && trick.Cards.length === 0;
    prompt.textContent = (lead ? (trump === null ? 'Your lead — the suit you lead becomes trump' : 'Your lead') : 'Your play — tap a card') + t;
    prompt.classList.add('you');
  }
  else if (complete) prompt.textContent = 'Deal over';
  else if (current !== null) prompt.textContent = `${vm.names[current]} ${current === mySeat ? 'to play' : 'is ' + (playout ? 'playing' : 'bidding')}…`;
  else prompt.textContent = '';

  // bid panel
  const panel = $('bidPanel');
  if (vm.awaiting && vm.awaiting.type === 'bid' && !vm.busy) {
    const legal = new Set(vm.awaiting.legal.map((a) => a.bid));
    const hintBid = vm.hint && vm.hint.bid !== undefined ? vm.hint.bid : null;
    const html = ALL_BIDS.map((b) =>
      `<button type="button" class="bid-btn ${hintBid === b ? 'hint' : ''}" data-bid="${b}" ${legal.has(b) ? '' : 'disabled'}>` +
      (b === Bid.Pass ? 'Pass' : `${b}<small>${BID_NAMES[b]}</small>`) + `</button>`).join('');
    if (panel.dataset.key !== html) { panel.innerHTML = html; panel.dataset.key = html; }
    panel.hidden = false;
  } else {
    panel.hidden = true;
    panel.dataset.key = '';
  }
}

/// Reset per-element render caches (call when switching decks/games).
export function resetTableCache() {
  for (let i = 0; i < 4; i++) {
    const s = $('seatPos' + i); s.dataset.key = ''; s.dataset.bubble = ''; s.innerHTML = '';
    const sl = $('slotPos' + i); sl.dataset.key = ''; sl.dataset.card = ''; sl.innerHTML = '';
  }
  $('hand').dataset.key = ''; $('hand').innerHTML = '';
  $('coach').dataset.key = ''; $('coach').hidden = true;
}

// -------------------------------------------------------------- widgets

let toastTimer = null;
export function toast(msg, ms = 1400) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  return sleep(ms);
}

let sheetHandler = null;
function ensureSheetListener() {
  const sheet = $('sheet');
  if (sheet.dataset.bound) return;
  sheet.dataset.bound = '1';
  sheet.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !sheetHandler) return;
    sheetHandler(btn.dataset.action, btn);
  });
}

/// One-shot sheet: resolves with the data-action tapped, then hides.
export function showSheet(html) {
  ensureSheetListener();
  return new Promise((resolve) => {
    $('sheet').innerHTML = html;
    $('overlay').hidden = false;
    sheetHandler = (action) => { sheetHandler = null; $('overlay').hidden = true; resolve(action); };
  });
}

/// Persistent sheet driven by state: pass null to hide.
export function setSheet(html, onAction) {
  ensureSheetListener();
  const sheet = $('sheet');
  if (html === null) {
    $('overlay').hidden = true;
    sheet.dataset.html = '';
    sheetHandler = null;
    return;
  }
  if (sheet.dataset.html !== html) {
    sheet.innerHTML = html;
    sheet.dataset.html = html;
  }
  $('overlay').hidden = false;
  sheetHandler = onAction;
}

// ------------------------------------------------------------ summaries

/// Deal summary table (no buttons). `judged` comes from rules.judgeDeal.
export function dealSummaryHtml(judged, names, teamNames) {
  const { holders: h, raw, dealScore: ds, scoreAfter, bidderTeam, bid, bidder, set, gamePoints: g, trump } = judged;
  const row = (label, team) => `<tr><td>${label}</td><td>${team === 0 ? '✓' : ''}</td><td>${team === 1 ? '✓' : ''}</td></tr>`;
  const cell = (v) => `<td class="tot ${v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v}</td>`;
  const headline = set
    ? `${escapeHtml(teamNames[bidderTeam])} bid ${bid} and took ${raw[bidderTeam]} — <b>set back ${bid}</b>.`
    : `${escapeHtml(teamNames[bidderTeam])} bid ${bid} and made it.`;
  let endNote = '';
  if (judged.winner !== null) {
    endNote = `<p class="sub"><b>Game over.</b> ${escapeHtml(explainEnd(judged.reason, judged.winner, teamNames, scoreAfter))}</p>`;
  } else {
    const pn = pendingNote(scoreAfter, teamNames);
    if (pn) endNote = `<p class="sub">${escapeHtml(pn)}</p>`;
  }
  return `<h2>${escapeHtml(names[bidder])} bid ${bid} in ${suitHtml(trump)} ${SUIT_NAMES[trump]}</h2>` +
    `<p>${headline}</p>` +
    `<table><thead><tr><th></th><th>${escapeHtml(teamNames[0])}</th><th>${escapeHtml(teamNames[1])}</th></tr></thead><tbody>` +
    row('High', h.High) + row('Low', h.Low) + row(`Jack${h.Jack === null ? ' <span class="sub">(not in play)</span>' : ''}`, h.Jack) +
    `<tr><td>Game <span class="sub">(${g[0]} – ${g[1]} game points)</span></td><td>${h.Game === 0 ? '✓' : ''}</td><td>${h.Game === 1 ? '✓' : ''}</td></tr>` +
    `<tr><td><b>This deal</b></td>${cell(ds[0])}${cell(ds[1])}</tr>` +
    `<tr><td><b>Game score</b></td><td class="tot">${scoreAfter[0]}</td><td class="tot">${scoreAfter[1]}</td></tr>` +
    `</tbody></table>` + endNote;
}

/// Game-over summary (no buttons).
export function gameOverHtml(winner, reason, teamNames, score, statsGame, statsTotal, gamesWon, youTeam) {
  const you = youTeam === winner;
  const title = you ? 'You win!' : youTeam === null || youTeam === undefined ? `${escapeHtml(teamNames[winner])} win` : `${escapeHtml(teamNames[winner])} win the game`;
  const th = `<tr><th></th><th>${escapeHtml(teamNames[0])}</th><th>${escapeHtml(teamNames[1])}</th></tr>`;
  return `<h2 class="${you ? 'win' : ''}">${title}</h2>` +
    `<p>${escapeHtml(explainEnd(reason, winner, teamNames, score))}</p>` +
    `<table><thead>${th}</thead><tbody>` +
    `<tr><td>Final score</td><td class="tot">${score[0]}</td><td class="tot">${score[1]}</td></tr>` +
    `<tr><td>Points taken this game</td><td>${statsGame.points[0]}</td><td>${statsGame.points[1]}</td></tr>` +
    `<tr><td>Times set this game</td><td>${statsGame.sets[0]}</td><td>${statsGame.sets[1]}</td></tr>` +
    `</tbody></table>` +
    `<p class="sub" style="margin-top:12px">Running totals</p>` +
    `<table><thead>${th}</thead><tbody>` +
    `<tr><td>Games won</td><td class="tot">${gamesWon[0]}</td><td class="tot">${gamesWon[1]}</td></tr>` +
    `<tr><td>Points taken</td><td>${statsTotal.points[0]}</td><td>${statsTotal.points[1]}</td></tr>` +
    `<tr><td>Times set</td><td>${statsTotal.sets[0]}</td><td>${statsTotal.sets[1]}</td></tr>` +
    `</tbody></table>`;
}

export const TIP_URL = 'https://buymeacoffee.com/1j6dev';
export const tipHtml = () =>
  `<p class="tip"><a href="${TIP_URL}" target="_blank" rel="noopener">☕ Enjoying the game? Buy the maker a coffee</a></p>`;

export const rulesBlurb = () =>
  `<p class="credit">Scoring: first to ${RULES.winBid} wins, but you must bid and make it on the deal that gets you there. ` +
  `Reaching ${RULES.winAny} wins any way. Falling to ${RULES.loseAt} loses.</p>`;
