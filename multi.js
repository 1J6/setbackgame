// Multiplayer Setback: four phones sharing one room in a realtime store.
//
// The room document is the single source of truth. Every change is made with
// a transaction whose function re-validates the move against the latest room
// state, so two phones can never both act on the same turn. The mutable game
// state lives in `blob` (a JSON string) to avoid the store's array/null quirks.
import { Bid, Team, seatIncr, teamOfSeat, Trick, Playout, OpenDeal, Game } from './engine.js';
import { chooseAction } from './ai.js';
import { judgeDeal, emptyStats, addDealStats } from './rules.js';
import {
  $, sleep, renderTable, resetTableCache, showScreen, setScreenHtml, setSheet, toast, escapeHtml,
  dealSummaryHtml, gameOverHtml, fmtTime, rulesBlurb, tipHtml,
} from './view.js';

const TURN_MS = 60000;      // a player has one minute before the computer plays for them
const ABSENT_MS = 8000;     // ...or eight seconds if their phone is not connected
const TRICK_MS = 1250;      // how long a finished trick stays on the table
const ROOM_KEY = 'lis-setback-room';
const PID_KEY = 'lis-setback-pid';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

const rng = Math.random;
// Identity persists per device so a reload rejoins the same seat. In local
// test mode (?local=1) it is per tab so several tabs can be different players.
const KV = new URLSearchParams(location.search).get('local') === '1' ? sessionStorage : localStorage;
const load = (k) => { try { const s = KV.getItem(k); return s ? JSON.parse(s) : null; } catch { return null; } };
const store = (k, v) => { try { if (v === null) KV.removeItem(k); else KV.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

function getPid() {
  let pid = load(PID_KEY);
  if (!pid) { pid = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); store(PID_KEY, pid); }
  return pid;
}
const makeCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

// ------------------------------------------------------------- session

let S = null; // { store, pid, code, ref, room, unsub, stopPresence }
const ui = {
  dealNo: -1, completed: 0, showTrick: null, trickWinner: null, trickTimer: null,
  busy: false, noticeId: null, takeoverTimer: null, tick: null, pendingName: null, intent: null, leaving: false,
};

// ---------------------------------------------------------------- chat

const QUICK = ['\u{1F44D}', '\u{1F602}', '\u{1F631}', 'Nice!', 'Ugh', 'Hurry up \u{1F642}', 'Sorry partner', 'gg'];
const C = { msgs: [], open: false, seen: 0, unsub: null, speech: [null, null, null, null], speechTimers: [null, null, null, null], lastId: null, ready: false };

function chatStart() {
  chatStop();
  C.ready = false;
  C.unsub = S.ref.subscribeChat(onChat);
  $('chatBtn').hidden = false;
  $('chatQuick').innerHTML = QUICK.map((q) => `<button type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('');
  $('chatBtn').onclick = () => chatOpen(!C.open);
  $('chatClose').onclick = () => chatOpen(false);
  $('chatQuick').onclick = (e) => { const b = e.target.closest('[data-q]'); if (b) chatSend(b.dataset.q); };
  $('chatForm').onsubmit = (e) => { e.preventDefault(); const inp = $('chatInput'); const t = inp.value.trim(); if (t) { chatSend(t); inp.value = ''; } };
}

function chatStop() {
  if (C.unsub) C.unsub();
  C.unsub = null; C.msgs = []; C.seen = 0; C.lastId = null; C.ready = false;
  C.speech = [null, null, null, null];
  C.speechTimers.forEach((t) => clearTimeout(t));
  chatOpen(false);
  $('chatBtn').hidden = true;
  $('chatBadge').hidden = true;
}

function chatOpen(open) {
  C.open = open;
  $('chat').hidden = !open;
  if (open) { C.seen = C.msgs.length; renderChat(); setTimeout(() => { const l = $('chatList'); l.scrollTop = l.scrollHeight; }, 0); }
  chatBadge();
}

function chatBadge() {
  const n = Math.max(0, C.msgs.length - C.seen);
  const b = $('chatBadge');
  b.hidden = C.open || n === 0;
  b.textContent = n > 9 ? '9+' : String(n);
}

async function chatSend(text) {
  const room = S && S.room;
  const my = me(room);
  if (!room || !my) return;
  await S.ref.pushChat({ pid: S.pid, name: my.name, text: String(text).slice(0, 200), t: now() });
}

function onChat(msgs) {
  const prevLast = C.lastId;
  C.msgs = msgs;
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  C.lastId = last ? last.id : null;
  // speech bubble by the sender's seat for a fresh message (not on first load)
  if (C.ready && last && last.id !== prevLast && S.room && S.room.status === 'playing') {
    const p = S.room.players[last.pid];
    if (p && p.seat !== undefined && p.seat !== null) {
      clearTimeout(C.speechTimers[p.seat]);
      C.speech[p.seat] = last.text;
      C.speechTimers[p.seat] = setTimeout(() => { C.speech[p.seat] = null; if (S && S.room && S.room.status === 'playing') renderAll(); }, 4000);
      renderAll();
    }
  }
  if (!C.ready) { C.ready = true; C.seen = msgs.length; }
  if (C.open) { C.seen = msgs.length; renderChat(); }
  chatBadge();
  if (S.room && S.room.status === 'lobby' && !C.open) renderLobby(S.room);
  // the host trims very old messages
  if (isHost(S.room) && msgs.length > 70) msgs.slice(0, msgs.length - 60).forEach((m) => S.ref.removeChat(m.id));
}

function renderChat() {
  const list = $('chatList');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = C.msgs.length
    ? C.msgs.map((m) => `<div class="msg ${m.pid === S.pid ? 'mine' : ''}">${m.pid === S.pid ? '' : `<span class="who">${escapeHtml(m.name || '?')}</span>`}${escapeHtml(m.text)}</div>`).join('')
    : '<div class="empty">No messages yet. Say hi!</div>';
  if (atBottom) list.scrollTop = list.scrollHeight;
}

const parseBlob = (room) => (room && room.blob ? JSON.parse(room.blob) : null);
const players = (room) => Object.entries((room && room.players) || {}).map(([id, p]) => ({ id, ...p }));
const me = (room) => (room && room.players && room.players[S.pid]) || null;
const isHost = (room) => room && room.hostId === S.pid;
const pidAtSeat = (room, seat) => players(room).find((p) => p.seat === seat) || null;
const absent = (p) => !p || p.left || p.connected === false;
const now = () => S.store.now();

function teamNamesOf(room) {
  const names = [[], []];
  for (const p of players(room).filter((p) => p.seat !== undefined && p.seat !== null).sort((a, b) => a.seat - b.seat)) {
    names[teamOfSeat(p.seat)].push(p.name);
  }
  return names.map((n, t) => (n.length ? n.join(' & ') : `Team ${t + 1}`));
}
const shortName = (n) => (n.length > 9 ? n.slice(0, 8) + '…' : n);

/// Runs a transaction against the room. `fn(room)` mutates and returns the
/// room, returns null to delete it, or undefined to abort. `onNull` handles a
/// missing room (used only to create one).
async function tx(fn, onNull) {
  const res = await S.ref.transaction((room) => {
    if (room === null || room === undefined) return onNull ? onNull() : null; // best guess; server re-runs if the room exists
    const out = fn(room);
    if (out === undefined) return undefined;
    if (out === null) return null;
    out.version = (room.version || 0) + 1;
    out.updatedAt = now();
    return out;
  });
  return res;
}

// ------------------------------------------------------- game mutations

function newGame(dealer) {
  return {
    game: Game.create(rng, dealer), phase: 'auction', dealNo: 0,
    lastDeal: null, winner: null, reason: null, notice: null, scoreBefore: [0, 0],
  };
}

function setBlob(room, blob) { room.blob = JSON.stringify(blob); }

/// Applies a bid or play for `seat`. Used both for a player's own move and
/// for the computer stepping in.
function applyGameAction(room, seat, action) {
  if (room.status !== 'playing' || room.paused) return undefined;
  const blob = parseBlob(room);
  if (!blob || (blob.phase !== 'auction' && blob.phase !== 'playout')) return undefined;
  const game = blob.game;
  if (OpenDeal.currentPlayer(game.Deal) !== seat) return undefined;
  const info = Game.currentInfoSet(game);
  if (!info.LegalActions.some((a) => a.bid === action.bid && a.card === action.card)) return undefined;

  let g = Game.addAction(action, game);
  if (OpenDeal.isComplete(g.Deal)) {
    const cd = g.Deal.ClosedDeal;
    if (cd.Auction.HighBid === Bid.Pass) {
      g = Game.startNextDeal(rng, g);
      blob.dealNo += 1;
      blob.notice = { id: now(), text: 'Everyone passed — dealing again' };
      blob.phase = 'auction';
    } else {
      const judged = judgeDeal(blob.scoreBefore, cd);
      blob.lastDeal = judged;
      const stats = room.stats || { game: emptyStats(), total: { ...emptyStats(), games: [0, 0] } };
      addDealStats(stats.game, judged);
      addDealStats(stats.total, judged);
      if (judged.winner !== null) {
        blob.phase = 'gameOver';
        blob.winner = judged.winner;
        blob.reason = judged.reason;
        stats.total.games[judged.winner] += 1;
      } else {
        blob.phase = 'dealOver';
      }
      room.stats = stats;
    }
  } else {
    blob.phase = g.Deal.ClosedDeal.Playout ? 'playout' : 'auction';
  }
  blob.game = g;
  setBlob(room, blob);
  room.turnStartedAt = now();
  return room;
}

function applyNextDeal(room) {
  if (room.status !== 'playing' || room.paused) return undefined;
  const blob = parseBlob(room);
  if (!blob || blob.phase !== 'dealOver') return undefined;
  blob.game = Game.startNextDeal(rng, blob.game);
  blob.scoreBefore = blob.game.Score.slice();
  blob.dealNo += 1;
  blob.phase = 'auction';
  blob.lastDeal = null;
  setBlob(room, blob);
  room.turnStartedAt = now();
  return room;
}

function applyRematch(room) {
  if (room.status !== 'playing') return undefined;
  const blob = parseBlob(room);
  if (!blob || blob.phase !== 'gameOver') return undefined;
  const dealer = seatIncr(1, blob.game.Deal.ClosedDeal.Auction.Dealer);
  const nb = newGame(dealer);
  nb.dealNo = blob.dealNo + 1;
  setBlob(room, nb);
  room.stats.game = emptyStats();
  room.paused = false;
  room.turnStartedAt = now();
  return room;
}

// ----------------------------------------------------------- lobby ops

async function createRoom(name) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = makeCode();
    const ref = S.store.open(code);
    const existing = await ref.get();
    if (existing) continue;
    const t = S.store.now();
    const room = {
      code, hostId: S.pid, status: 'lobby', createdAt: t, updatedAt: t, version: 1, paused: false,
      players: { [S.pid]: { name, team: null, connected: true, joinedAt: t } },
    };
    const res = await ref.transaction((cur) => (cur === null ? room : undefined));
    if (res.committed) return code;
  }
  throw new Error('Could not create a room, please try again.');
}

async function joinRoom(code, name) {
  const ref = S.store.open(code);
  const existing = await ref.get();
  if (!existing) throw new Error('No room with that code.');
  const t = S.store.now();
  let reason = null;
  const res = await ref.transaction((room) => {
    if (room === null) return null;
    if (room.players && room.players[S.pid]) {
      room.players[S.pid].name = name;
      room.players[S.pid].left = false;
      room.players[S.pid].connected = true;
      return room;
    }
    if (room.status !== 'lobby') { reason = 'That game has already started.'; return undefined; }
    if (Object.keys(room.players || {}).length >= 4) { reason = 'That room is full.'; return undefined; }
    room.players = room.players || {};
    room.players[S.pid] = { name, team: null, connected: true, joinedAt: t };
    room.version = (room.version || 0) + 1;
    return room;
  });
  if (!res.committed || !res.value) throw new Error(reason || 'Could not join that room.');
}

async function attach(code) {
  detach();
  S.code = code;
  S.ref = S.store.open(code);
  store(ROOM_KEY, { code, pid: S.pid });
  S.stopPresence = S.ref.presence(S.pid);
  S.unsub = S.ref.subscribe(onRoom);
  chatStart();
}

function detach() {
  if (!S) return;
  chatStop();
  if (S.unsub) S.unsub();
  if (S.stopPresence) S.stopPresence();
  S.unsub = null; S.stopPresence = null; S.ref = null; S.code = null; S.room = null;
  clearTimeout(ui.takeoverTimer); clearInterval(ui.tick); clearTimeout(ui.trickTimer);
  ui.takeoverTimer = null; ui.tick = null; ui.trickTimer = null; ui.showTrick = null; ui.dealNo = -1;
}

async function leaveRoom() {
  if (S.ref) {
    ui.leaving = true; // the local apply of the transaction fires onRoom(null) before it commits
    await tx((room) => {
      if (!room.players || !room.players[S.pid]) return undefined;
      if (room.status === 'lobby') {
        delete room.players[S.pid];
        const rest = Object.keys(room.players);
        if (rest.length === 0) return null;
        if (room.hostId === S.pid) room.hostId = rest.sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt)[0];
      } else {
        room.players[S.pid].left = true;
        room.players[S.pid].connected = false;
        const rest = players(room).filter((p) => !p.left);
        if (rest.length === 0) return null;
        if (room.hostId === S.pid) room.hostId = rest.sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
      }
      return room;
    });
  }
  ui.leaving = false;
  detach();
  store(ROOM_KEY, null);
  showChoose();
}

// ------------------------------------------------------------- screens

function screenShell(title, body, back) {
  return `<div class="panel">` +
    (back ? `<button type="button" class="link-btn" data-action="${back}">‹ Back</button>` : '') +
    `<h1>${title}</h1>${body}</div>`;
}

function bindScreen(handlers) {
  $('screen').onclick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const h = handlers[btn.dataset.action];
    if (h) h(btn);
  };
  $('screen').onsubmit = (e) => {
    e.preventDefault();
    const h = handlers.submit;
    if (h) h(e.target);
  };
}

function showChoose() {
  setScreenHtml(screenShell('Multiplayer',
    `<p class="sub">Four players, each on their own phone. One person creates a game and shares the five-letter code; the other three join with it.</p>` +
    `<div class="actions">` +
    `<button type="button" class="btn big" data-action="create">Create a game</button>` +
    `<button type="button" class="btn big secondary" data-action="join">Join a game</button>` +
    `</div>`, 'home'));
  bindScreen({
    home: () => { location.hash = ''; location.reload(); },
    create: () => { ui.intent = { kind: 'create' }; showName(); },
    join: () => showCode(),
  });
}

function showCode(prefill = '', error = '') {
  setScreenHtml(screenShell('Join a game',
    `<form>` +
    `<label class="lbl" for="codeInput">Room code</label>` +
    `<input id="codeInput" class="input code" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="5" placeholder="ABCDE" value="${escapeHtml(prefill)}" required>` +
    (error ? `<p class="error">${escapeHtml(error)}</p>` : '') +
    `<div class="actions"><button type="submit" class="btn big">Continue</button></div>` +
    `</form>`, 'back'));
  bindScreen({
    back: () => showChoose(),
    submit: (form) => {
      const code = form.codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!CODE_RE.test(code)) { showCode(code, 'Codes are five letters or numbers (no O, 0, I or 1).'); return; }
      ui.intent = { kind: 'join', code };
      showName();
    },
  });
  const inp = $('codeInput');
  inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase(); });
  inp.focus();
}

function showName(error = '') {
  const intent = ui.intent;
  const sub = intent.kind === 'join' ? `Joining room <b>${intent.code}</b>.` : 'You will get a room code to share.';
  setScreenHtml(screenShell('Your name',
    `<p class="sub">${sub}</p>` +
    `<form>` +
    `<input id="nameInput" class="input" type="text" autocomplete="off" autocapitalize="words" maxlength="14" placeholder="Name" required>` +
    (error ? `<p class="error">${escapeHtml(error)}</p>` : '') +
    `<div class="actions"><button type="submit" class="btn big" id="nameGo">${intent.kind === 'join' ? 'Join' : 'Create room'}</button></div>` +
    `</form>`, 'back'));
  bindScreen({
    back: () => (intent.kind === 'join' ? showCode(intent.code) : showChoose()),
    submit: async (form) => {
      const name = form.nameInput.value.trim().slice(0, 14);
      if (!name) return;
      $('nameGo').disabled = true;
      try {
        if (intent.kind === 'join') { await joinRoom(intent.code, name); await attach(intent.code); }
        else { const code = await createRoom(name); await attach(code); }
      } catch (err) {
        showName(err.message || String(err));
      }
    },
  });
  $('nameInput').focus();
}

function shareUrl(code) {
  return `${location.origin}${location.pathname}#join=${code}`;
}

function renderLobby(room) {
  const ps = players(room).sort((a, b) => a.joinedAt - b.joinedAt);
  const my = me(room);
  const host = isHost(room);
  const teamCount = (t) => ps.filter((p) => p.team === t).length;
  const ready = ps.length === 4 && teamCount(0) === 2 && teamCount(1) === 2;
  const list = ps.map((p) =>
    `<li><span class="dot ${p.connected === false ? 'off' : 'on'}"></span> ${escapeHtml(p.name)}` +
    `${p.id === S.pid ? ' <span class="tag">you</span>' : ''}${p.id === room.hostId ? ' <span class="tag">host</span>' : ''}` +
    `<span class="team-tag">${p.team === null || p.team === undefined ? 'no team' : 'Team ' + (p.team + 1)}</span></li>`).join('');
  const teamBtn = (t) => {
    const onIt = my && my.team === t;
    const full = teamCount(t) >= 2 && !onIt;
    const members = ps.filter((p) => p.team === t).map((p) => escapeHtml(p.name)).join(' & ') || '—';
    return `<button type="button" class="btn row team ${onIt ? 'on' : ''}" data-action="team${t}" ${full ? 'disabled' : ''}>` +
      `<span>Team ${t + 1}<small>${members}</small></span><span>${onIt ? '✓' : full ? 'Full' : 'Join'}</span></button>`;
  };
  setScreenHtml(screenShell('Room',
    `<div class="code-box"><div class="code-big">${room.code}</div>` +
    `<div class="code-actions"><button type="button" class="btn small" data-action="share">Share</button><button type="button" class="btn small secondary" data-action="copy">Copy code</button></div>` +
    `<p class="sub">Friends open <b>setbackgame.com</b>, tap Multiplayer › Join, and enter this code.</p></div>` +
    `<h3>Players <span class="sub">(${ps.length}/4)</span></h3><ul class="players">${list}</ul>` +
    `<h3>Teams</h3><p class="sub">Partners sit across from each other. Two per team.</p>` +
    `<div class="actions">${teamBtn(0)}${teamBtn(1)}` +
    (host ? `<button type="button" class="btn secondary" data-action="random" ${ps.length < 2 ? 'disabled' : ''}>Randomize teams</button>` : '') +
    (host ? `<button type="button" class="btn big" data-action="start" ${ready ? '' : 'disabled'}>${ready ? 'Start game' : ps.length < 4 ? `Waiting for ${4 - ps.length} more player${ps.length === 3 ? '' : 's'}…` : 'Teams must be 2 and 2'}</button>`
          : `<p class="sub center">${ready ? `Waiting for ${escapeHtml((ps.find((p) => p.id === room.hostId) || {}).name || 'the host')} to start…` : 'Waiting for everyone to join and pick teams…'}</p>`) +
    `<button type="button" class="btn secondary" data-action="chat">Chat${C.msgs.length > C.seen ? ` (${C.msgs.length - C.seen} new)` : ''}</button>` +
    `<button type="button" class="btn danger" data-action="leave">Leave room</button>` +
    `</div>` + rulesBlurb() + tipHtml()));
  bindScreen({
    share: async () => {
      const url = shareUrl(room.code);
      const text = `Join my Setback game — code ${room.code}`;
      try {
        if (navigator.share) await navigator.share({ title: 'Setback', text, url });
        else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Link copied'); }
      } catch { /* cancelled */ }
    },
    copy: async () => { try { await navigator.clipboard.writeText(room.code); toast('Code copied'); } catch { toast(room.code); } },
    team0: () => setTeam(0), team1: () => setTeam(1),
    random: () => tx((r) => {
      if (r.hostId !== S.pid || r.status !== 'lobby') return undefined;
      const ids = Object.keys(r.players || {});
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      ids.forEach((id, i) => { r.players[id].team = i % 2; });
      return r;
    }),
    start: () => startGame(),
    chat: () => chatOpen(true),
    leave: () => { if (confirm('Leave this room?')) leaveRoom(); },
  });
}

function setTeam(t) {
  return tx((r) => {
    if (r.status !== 'lobby' || !r.players || !r.players[S.pid]) return undefined;
    const count = Object.values(r.players).filter((p) => p.team === t).length;
    if (r.players[S.pid].team === t) { r.players[S.pid].team = null; return r; }
    if (count >= 2) return undefined;
    r.players[S.pid].team = t;
    return r;
  });
}

function startGame() {
  return tx((r) => {
    if (r.hostId !== S.pid || r.status !== 'lobby') return undefined;
    const ps = Object.entries(r.players || {}).map(([id, p]) => ({ id, ...p }));
    if (ps.length !== 4) return undefined;
    const t0 = ps.filter((p) => p.team === 0).sort((a, b) => a.joinedAt - b.joinedAt);
    const t1 = ps.filter((p) => p.team === 1).sort((a, b) => a.joinedAt - b.joinedAt);
    if (t0.length !== 2 || t1.length !== 2) return undefined;
    r.players[t0[0].id].seat = 0; r.players[t0[1].id].seat = 2;   // Team 1 = East + West
    r.players[t1[0].id].seat = 1; r.players[t1[1].id].seat = 3;   // Team 2 = North + South
    r.status = 'playing';
    r.paused = false;
    r.stats = { game: emptyStats(), total: { ...emptyStats(), games: [0, 0] } };
    setBlob(r, newGame(Math.floor(Math.random() * 4)));
    r.turnStartedAt = now();
    return r;
  });
}

// --------------------------------------------------------------- table

function onRoom(room) {
  if (!S) return;
  if (room === null) {
    if (S.room && !ui.leaving) { toast('The room was closed'); }
    detach(); store(ROOM_KEY, null); showChoose();
    return;
  }
  if (!room.players || !room.players[S.pid]) {
    // we are not (or no longer) in this room
    detach(); store(ROOM_KEY, null); showChoose();
    return;
  }
  const prev = S.room;
  S.room = room;
  if (room.status === 'lobby') {
    clearInterval(ui.tick); ui.tick = null;
    renderLobby(room);
    return;
  }
  if (!prev || prev.status === 'lobby') { showScreen('table'); resetTableCache(); bindTable(); }
  const blob = parseBlob(room);
  if (!blob) return;

  // notices
  if (blob.notice && blob.notice.id !== ui.noticeId) { ui.noticeId = blob.notice.id; if (prev) toast(blob.notice.text, 1500); }

  // hold a just-finished trick on the table for a moment
  const p = blob.game.Deal.ClosedDeal.Playout;
  const completed = p ? p.CompletedTricks.length : 0;
  if (blob.dealNo !== ui.dealNo) {
    ui.dealNo = blob.dealNo; ui.completed = completed; ui.showTrick = null; ui.trickWinner = null; clearTimeout(ui.trickTimer);
  } else if (completed > ui.completed && p) {
    ui.completed = completed;
    const last = p.CompletedTricks[completed - 1];
    ui.showTrick = last; ui.trickWinner = last.HighPlay.seat;
    clearTimeout(ui.trickTimer);
    ui.trickTimer = setTimeout(() => { ui.showTrick = null; ui.trickWinner = null; renderAll(); }, TRICK_MS);
  }
  ui.busy = false;
  renderAll();
  scheduleTakeover();
  if (!ui.tick) ui.tick = setInterval(() => { if (S && S.room && S.room.status === 'playing') renderAll(); }, 1000);
}

function turnLimit(room, seat) {
  return absent(pidAtSeat(room, seat)) ? ABSENT_MS : TURN_MS;
}

function renderAll() {
  const room = S.room;
  const blob = parseBlob(room);
  const my = me(room);
  const mySeat = my.seat;
  const game = blob.game;
  const deal = game.Deal;
  const names = [0, 1, 2, 3].map((s) => { const p = pidAtSeat(room, s); return p ? (p.id === S.pid ? `${p.name} (you)` : p.name) : '—'; });
  const connected = [0, 1, 2, 3].map((s) => !absent(pidAtSeat(room, s)));
  const teamNames = teamNamesOf(room);
  const teamShort = teamNames.map((n) => n.split(' & ').map(shortName).join(' & '));
  const inHand = blob.phase === 'auction' || blob.phase === 'playout';
  const current = inHand ? OpenDeal.currentPlayer(deal) : null;
  const myTurn = inHand && current === mySeat && !room.paused && !ui.showTrick;
  let timerText = null;
  if (inHand && !room.paused && room.turnStartedAt) {
    const left = room.turnStartedAt + turnLimit(room, current) - now();
    if (left < 30000 || current === mySeat) timerText = fmtTime(left);
  }
  const awaiting = myTurn ? { type: blob.phase === 'auction' ? 'bid' : 'play', legal: Game.currentInfoSet(game).LegalActions } : null;
  renderTable({
    mySeat, deal, handCounts: deal.Hands.map((h) => h.length), myHand: deal.Hands[mySeat],
    names, connected, teamNames: teamShort, teamShort, score: game.Score,
    gamesWon: room.stats.total.games, sets: room.stats.total.sets,
    showTrick: ui.showTrick, trickWinner: ui.trickWinner, awaiting, hint: null, timerText, busy: ui.busy,
    prompt: room.paused ? 'Paused' : null, speech: C.speech,
  });

  // sheets
  const host = isHost(room);
  const hostName = (players(room).find((p) => p.id === room.hostId) || {}).name || 'the host';
  if (room.paused) {
    setSheet(`<h2>Paused</h2><p>${escapeHtml(hostName)} paused the game.</p>` +
      `<div class="actions">${host ? '<button type="button" class="btn" data-action="resume">Resume</button>' : '<p class="sub center">Waiting for the host to resume…</p>'}` +
      `<button type="button" class="btn secondary" data-action="leave">Leave room</button></div>`, sheetAction);
  } else if (blob.phase === 'dealOver' && !ui.showTrick) {
    setSheet(dealSummaryHtml(blob.lastDeal, names.map((n) => n.replace(' (you)', '')), teamNames) +
      `<div class="actions">` +
      (host ? `<button type="button" class="btn" data-action="next">Next deal</button><button type="button" class="btn secondary" data-action="pause">Pause game</button>`
            : `<p class="sub center">Waiting for ${escapeHtml(hostName)} to deal…</p>`) +
      `</div>`, sheetAction);
  } else if (blob.phase === 'gameOver' && !ui.showTrick) {
    setSheet(gameOverHtml(blob.winner, blob.reason, teamNames, game.Score, room.stats.game, room.stats.total, room.stats.total.games, teamOfSeat(mySeat)) +
      `<div class="actions">` +
      (host ? `<button type="button" class="btn" data-action="rematch">Play again (same teams)</button>` : `<p class="sub center">Waiting for ${escapeHtml(hostName)} to start another game…</p>`) +
      `<button type="button" class="btn secondary" data-action="leave">Leave room</button>` +
      `</div>`, sheetAction);
  } else if (!ui.menuOpen) {
    setSheet(null);
  }
}

async function sheetAction(action) {
  if (action === 'next') await tx(applyNextDeal);
  else if (action === 'rematch') await tx(applyRematch);
  else if (action === 'pause') await tx((r) => { if (r.hostId !== S.pid) return undefined; r.paused = true; return r; });
  else if (action === 'resume') await tx((r) => { if (r.hostId !== S.pid) return undefined; r.paused = false; r.turnStartedAt = now(); return r; });
  else if (action === 'leave') { if (confirm('Leave this room? The computer will play your cards if the others continue.')) leaveRoom(); }
  else if (action === 'close') { ui.menuOpen = false; renderAll(); }
  else if (action === 'home') { location.hash = ''; location.reload(); }
  else if (action === 'becomehost') await tx((r) => { const h = r.players[r.hostId]; if (!absent(h)) return undefined; r.hostId = S.pid; return r; });
}

function bindTable() {
  $('hand').onclick = async (e) => {
    const btn = e.target.closest('[data-card]');
    if (!btn || ui.busy) return;
    await act({ card: Number(btn.dataset.card) });
  };
  $('bidPanel').onclick = async (e) => {
    const btn = e.target.closest('[data-bid]');
    if (!btn || btn.disabled || ui.busy) return;
    await act({ bid: Number(btn.dataset.bid) });
  };
  $('menuBtn').onclick = () => {
    if (!$('overlay').hidden) return;
    const room = S.room;
    const hostAbsent = absent(room.players[room.hostId]) && room.hostId !== S.pid;
    ui.menuOpen = true;
    setSheet(`<h2>Room ${room.code}</h2>` +
      `<p class="sub">${players(room).filter((p) => !p.left).map((p) => `<span class="dot ${p.connected === false ? 'off' : 'on'}"></span> ${escapeHtml(p.name)}`).join(' &nbsp; ')}</p>` +
      `<div class="actions">` +
      (hostAbsent ? `<button type="button" class="btn" data-action="becomehost">Take over as host (host is away)</button>` : '') +
      `<a class="btn secondary row" href="rules.html" style="text-decoration:none;display:flex"><span>Rules of Setback</span><span>›</span></a>` +
      `<button type="button" class="btn danger" data-action="leave">Leave room</button>` +
      `<button type="button" class="btn secondary" data-action="close">Close</button>` +
      `</div>` + rulesBlurb() +
      `<p class="credit">If a player does not move within a minute (or eight seconds when their phone is disconnected), the computer plays that turn for them.</p>` + tipHtml(), sheetAction);
  };
}

async function act(action) {
  const room = S.room;
  const my = me(room);
  if (!my || my.seat === undefined) return;
  ui.busy = true;
  renderAll();
  try {
    await tx((r) => applyGameAction(r, my.seat, action));
  } finally {
    ui.busy = false;
    if (S && S.room) renderAll();
  }
}

/// Every phone except the one whose turn it is arms a timer; when the turn
/// limit passes, the first to commit a transaction plays for the absent player.
function scheduleTakeover() {
  clearTimeout(ui.takeoverTimer);
  const room = S.room;
  if (!room || room.status !== 'playing' || room.paused) return;
  const blob = parseBlob(room);
  const my = me(room);
  const version = room.version;
  const jitter = (my.seat || 0) * 900 + 200;
  let seat = null, due = null;
  if (blob.phase === 'auction' || blob.phase === 'playout') {
    seat = OpenDeal.currentPlayer(blob.game.Deal);
    if (seat === my.seat) return; // my own turn: no takeover from me
    due = room.turnStartedAt + turnLimit(room, seat) + jitter;
  } else if (blob.phase === 'dealOver') {
    if (isHost(room)) return;
    due = room.turnStartedAt + (absent(room.players[room.hostId]) ? ABSENT_MS : TURN_MS) + jitter;
  } else return;

  ui.takeoverTimer = setTimeout(async () => {
    const cur = S && S.room;
    if (!cur || cur.version !== version) return; // something happened meanwhile
    const b = parseBlob(cur);
    if (seat !== null) {
      const info = Game.currentInfoSet(b.game);
      const { action } = chooseAction(info, rng, 120);
      await tx((r) => (r.version !== version ? undefined : applyGameAction(r, seat, action)));
    } else {
      await tx((r) => (r.version !== version ? undefined : applyNextDeal(r)));
    }
  }, Math.max(0, due - now()));
}

// --------------------------------------------------------------- entry

export async function startMulti(storeImpl, joinCode) {
  S = { store: storeImpl, pid: getPid(), code: null, ref: null, room: null, unsub: null, stopPresence: null };
  const saved = load(ROOM_KEY);
  if (joinCode && CODE_RE.test(joinCode)) {
    if (saved && saved.code === joinCode && saved.pid === S.pid) { await attach(joinCode); return; }
    ui.intent = { kind: 'join', code: joinCode };
    showName();
    return;
  }
  if (saved && saved.pid === S.pid && saved.code) {
    const ref = S.store.open(saved.code);
    const room = await ref.get();
    if (room && room.players && room.players[S.pid] && !room.players[S.pid].left) { await attach(saved.code); return; }
    store(ROOM_KEY, null);
  }
  showChoose();
}
