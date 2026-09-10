// Multiplayer Setback: four phones sharing one room in a realtime store.
//
// The room document is the single source of truth. The game itself is an
// append-only list of small moves (see replay.js); every phone replays it to
// get the current state. A move is appended with a transaction on its own
// slot, so a phone acting on a stale state finds the slot taken and retries
// from the newer state. Room-level changes (players, host, pause) are
// transactions on the room document.
import { Bid, teamOfSeat, OpenDeal, Game } from './engine.js';
import { chooseAction } from './ai.js';
import { replay, validate, movesArray, newSeed } from './replay.js';
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
const QUICK_WAIT_MS = 20000;   // a quick-play room starts after this, computers filling empty seats
const BOT_MS = 1200;           // a computer seat plays this quickly
const BOT_NAMES = ['Bot Ada', 'Bot Max', 'Bot Ivy'];
const OPEN_MAX_AGE = 15 * 60 * 1000; // ignore quick-play index entries older than this
const NAME_KEY = 'lis-setback-name';

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
  starting: false, openKey: null,
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

const ROOM_FMT = 2; // rooms made by older versions of this page are not joinable

/// Game state replayed from the room's move log, cached per move count.
const stCache = { code: null, len: -1, st: null };
function stateOf(room) {
  const moves = movesArray(room && room.moves);
  if (stCache.code !== room.code || stCache.len !== moves.length) {
    stCache.code = room.code; stCache.len = moves.length; stCache.st = replay(moves);
  }
  return stCache.st;
}
const players = (room) => Object.entries((room && room.players) || {}).map(([id, p]) => ({ id, ...p }));
const me = (room) => (room && room.players && room.players[S.pid]) || null;
const isHost = (room) => room && room.hostId === S.pid;
const pidAtSeat = (room, seat) => players(room).find((p) => p.seat === seat) || null;
const absent = (p) => !p || (!p.bot && (p.left || p.connected === false));
const isBot = (p) => !!(p && p.bot);
const humans = (room) => players(room).filter((p) => !p.bot);
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
    out.updatedAt = now();
    return out;
  });
  return res;
}

// ----------------------------------------------------------- game moves

/// Appends a move at the next slot. `make(st, room)` returns the move for the
/// current state, or undefined to do nothing. Retries a few times when another
/// phone took the slot first (the newer state arrives in between).
async function appendMove(make) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const room = S && S.room;
    if (!room || room.status !== 'playing') return false;
    const st = stateOf(room);
    if (st.corrupt) return false;
    const move = make(st, room);
    if (!move) return false;
    move.t = now();
    if (validate(st, move) !== null) return false;
    const res = await S.ref.transactionAt(`moves/${st.seq}`, (cur) => (cur === null || cur === undefined ? move : undefined));
    if (res.committed) return true;
    await sleep(120 + attempt * 200);
  }
  return false;
}

/// The move that plays `action` for `seat`, if it is that seat's turn.
function moveFor(st, room, seat, action) {
  if (room.paused) return undefined;
  if (st.phase !== 'auction' && st.phase !== 'playout') return undefined;
  if (OpenDeal.currentPlayer(st.game.Deal) !== seat) return undefined;
  if (action.card !== undefined) return { c: action.card };
  const move = { b: action.bid };
  const a = st.game.Deal.ClosedDeal.Auction;
  if (action.bid === Bid.Pass && a.HighBid === Bid.Pass && a.Bids.length === 3) move.d = newSeed(); // all pass: redeal
  return move;
}

/// The host's "next deal" (after a deal) or "play again" (after a game).
const dealMove = (st, room) => (room.paused || (st.phase !== 'dealOver' && st.phase !== 'gameOver') ? undefined : { d: newSeed() });

/// When the current turn started: the last move, or the resume if later.
const turnStart = (room, st) => Math.max(st.lastT || 0, room.resumedAt || 0);

// ----------------------------------------------------------- lobby ops

async function createRoom(name, isPublic = false) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = makeCode();
    const ref = S.store.open(code);
    const existing = await ref.get();
    if (existing) continue;
    const t = S.store.now();
    const room = {
      code, hostId: S.pid, status: 'lobby', fmt: ROOM_FMT, createdAt: t, updatedAt: t, paused: false,
      public: isPublic, startAt: isPublic ? t + QUICK_WAIT_MS : null,
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
  if (existing.fmt !== ROOM_FMT) throw new Error('That room was made with an older version of the game. Please create a new one.');
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
    if (room.status !== 'lobby') {
      const spare = room.public ? Object.entries(room.players || {}).find(([, p]) => p.bot || p.left) : null;
      if (!spare) { reason = 'That game has already started.'; return undefined; }
      const [sid, sp] = spare;
      delete room.players[sid];
      room.players[S.pid] = { name, team: sp.team, seat: sp.seat, connected: true, joinedAt: t };
      return room;
    }
    if (Object.keys(room.players || {}).length >= 4) { reason = 'That room is full.'; return undefined; }
    room.players = room.players || {};
    room.players[S.pid] = { name, team: null, connected: true, joinedAt: t };
    return room;
  });
  if (!res.committed || !res.value) throw new Error(reason || 'Could not join that room.');
}

/// Quick Play: join the fullest fresh public room with a seat, else open one.
async function quickPlay(name) {
  const list = await S.store.openRooms();
  const t = now();
  const codes = Object.entries(list || {})
    .filter(([code, e]) => CODE_RE.test(code) && e && (e.n || 0) < 4 && t - (e.t || 0) < OPEN_MAX_AGE)
    .sort((a, b) => (b[1].n || 0) - (a[1].n || 0) || (a[1].t || 0) - (b[1].t || 0))
    .map(([code]) => code);
  for (const code of codes) {
    try { await joinRoom(code, name); return code; } catch { /* full or gone: try the next */ }
  }
  return createRoom(name, true);
}

/// The host keeps the public-room index entry current: present while the
/// room can take a player (lobby seat free, or a computer/departed seat).
function updateOpenIndex(room) {
  if (!room.public || !isHost(room) || !S.store.setOpen) return;
  const n = humans(room).filter((p) => !p.left).length;
  const joinable = room.status === 'lobby'
    ? Object.keys(room.players || {}).length < 4
    : players(room).some((p) => p.bot || p.left);
  const entry = joinable ? { t: room.createdAt, n } : null;
  const key = JSON.stringify(entry);
  if (ui.openKey === key) return;
  ui.openKey = key;
  S.store.setOpen(room.code, entry);
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
  stCache.code = null; stCache.len = -1; stCache.st = null;
  ui.openKey = null; ui.starting = false;
}

async function leaveRoom() {
  if (S.ref) {
    ui.leaving = true; // the local apply of the transaction fires onRoom(null) before it commits
    const code = S.code, wasPublic = !!(S.room && S.room.public);
    const res = await tx((room) => {
      if (!room.players || !room.players[S.pid]) return undefined;
      if (room.status === 'lobby') {
        delete room.players[S.pid];
        const rest = Object.keys(room.players);
        if (rest.length === 0) return null;
        if (room.hostId === S.pid) room.hostId = rest.sort((a, b) => room.players[a].joinedAt - room.players[b].joinedAt)[0];
      } else {
        room.players[S.pid].left = true;
        room.players[S.pid].connected = false;
        const rest = players(room).filter((p) => !p.left && !p.bot);
        if (rest.length === 0) return null;
        if (room.hostId === S.pid) room.hostId = rest.sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
      }
      return room;
    });
    if (wasPublic && res && res.value === null && S.store.setOpen) S.store.setOpen(code, null);
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

const onlineText = (n) => (n === null || n === undefined ? '' : `${n} player${n === 1 ? '' : 's'} online now`);

function showChoose() {
  setScreenHtml(screenShell('Multiplayer',
    `<p class="sub">Four players, each on their own phone. One person creates a game and shares the five-letter code; the other three join with it.</p>` +
    `<div class="actions">` +
    `<button type="button" class="btn big" data-action="quick">Quick play<small>Random players; starts within 20 seconds, computers fill empty seats</small></button>` +
    `<button type="button" class="btn big secondary" data-action="create">Create a game<small>Get a code to share with friends</small></button>` +
    `<button type="button" class="btn big secondary" data-action="join">Join a game<small>Enter a friend's code</small></button>` +
    `</div>` +
    `<p class="sub center" id="onlineCount">${onlineText(S.onlineCount)}</p>`, 'home'));
  bindScreen({
    home: () => { location.hash = ''; location.reload(); },
    quick: () => { ui.intent = { kind: 'quick' }; showName(); },
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
  const sub = intent.kind === 'join' ? `Joining room <b>${intent.code}</b>.`
    : intent.kind === 'quick' ? 'You will be matched with other players. Chat in quick-play games is limited to the quick phrases.'
    : 'You will get a room code to share.';
  const remembered = load(NAME_KEY) || '';
  setScreenHtml(screenShell('Your name',
    `<p class="sub">${sub}</p>` +
    `<form>` +
    `<input id="nameInput" class="input" type="text" autocomplete="off" autocapitalize="words" maxlength="14" placeholder="Name" value="${escapeHtml(remembered)}" required>` +
    (error ? `<p class="error">${escapeHtml(error)}</p>` : '') +
    `<div class="actions"><button type="submit" class="btn big" id="nameGo">${intent.kind === 'join' ? 'Join' : intent.kind === 'quick' ? 'Find a game' : 'Create room'}</button></div>` +
    `</form>`, 'back'));
  bindScreen({
    back: () => (intent.kind === 'join' ? showCode(intent.code) : showChoose()),
    submit: async (form) => {
      const name = form.nameInput.value.trim().slice(0, 14);
      if (!name) return;
      $('nameGo').disabled = true;
      store(NAME_KEY, name);
      try {
        if (intent.kind === 'join') { await joinRoom(intent.code, name); await attach(intent.code); }
        else if (intent.kind === 'quick') { const code = await quickPlay(name); await attach(code); }
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

const quickWaitText = (room) => {
  const n = Object.keys(room.players || {}).length;
  if (n >= 4) return 'Starting…';
  const wait = Math.max(0, Math.ceil((room.startAt - now()) / 1000));
  return wait > 0 ? `Starting in ${wait}s…` : 'Starting…';
};

function renderLobby(room) {
  const ps = players(room).sort((a, b) => a.joinedAt - b.joinedAt);
  const my = me(room);
  const host = isHost(room);
  if (room.public) {
    const list = ps.map((p) =>
      `<li><span class="dot ${p.connected === false ? 'off' : 'on'}"></span> ${escapeHtml(p.name)}` +
      `${p.id === S.pid ? ' <span class="tag">you</span>' : ''}</li>`).join('');
    setScreenHtml(screenShell('Quick play',
      `<p class="sub">Random players. The game starts when four have joined or when the clock runs out; computers fill any empty seats and hand them over to people who join later.</p>` +
      `<h3>Players <span class="sub">(${ps.length}/4)</span></h3><ul class="players">${list}</ul>` +
      `<div class="actions">` +
      `<button type="button" class="btn big" id="quickWait" disabled>${quickWaitText(room)}</button>` +
      `<button type="button" class="btn secondary" data-action="chat">Chat${C.msgs.length > C.seen ? ` (${C.msgs.length - C.seen} new)` : ''}</button>` +
      `<button type="button" class="btn danger" data-action="leave">Leave</button>` +
      `</div>` +
      `<p class="credit">Room code <b>${room.code}</b>: friends can still join with it.</p>` + rulesBlurb() + tipHtml()));
    bindScreen({ chat: () => chatOpen(true), leave: () => leaveRoom() });
    return;
  }
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
  return tx((r) => (r.hostId !== S.pid || r.status !== 'lobby' ? undefined : startTx(r)));
}

/// A quick-play lobby starts when full, or when its clock runs out: the host's
/// phone tries first, the others a few seconds later as a backup.
function maybeQuickStart() {
  const room = S && S.room;
  if (!room || !room.public || room.status !== 'lobby' || ui.starting) return;
  const full = Object.keys(room.players || {}).length >= 4;
  if (!full && now() < room.startAt + (isHost(room) ? 0 : 3000)) return;
  ui.starting = true;
  tx(quickStartTx).finally(() => { ui.starting = false; });
}

function quickStartTx(r) {
  if (!r.public || r.status !== 'lobby') return undefined;
  const ids = Object.keys(r.players || {});
  if (ids.length === 0 || (ids.length < 4 && now() < r.startAt)) return undefined;
  for (let b = 0; Object.keys(r.players).length < 4; b++) {
    r.players['bot' + b] = { name: BOT_NAMES[b], bot: true, team: null, connected: true, joinedAt: now() + b };
  }
  const all = Object.keys(r.players);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  all.forEach((id, i) => { r.players[id].team = i % 2; });
  return startTx(r);
}

function tickLobby() {
  const room = S && S.room;
  if (!room || room.status !== 'lobby' || !room.public) return;
  const el = $('quickWait');
  if (el) el.textContent = quickWaitText(room);
  maybeQuickStart();
}

function startTx(r) {
  {
    const ps = Object.entries(r.players || {}).map(([id, p]) => ({ id, ...p }));
    if (ps.length !== 4) return undefined;
    const t0 = ps.filter((p) => p.team === 0).sort((a, b) => a.joinedAt - b.joinedAt);
    const t1 = ps.filter((p) => p.team === 1).sort((a, b) => a.joinedAt - b.joinedAt);
    if (t0.length !== 2 || t1.length !== 2) return undefined;
    r.players[t0[0].id].seat = 0; r.players[t0[1].id].seat = 2;   // Team 1 = East + West
    r.players[t1[0].id].seat = 1; r.players[t1[1].id].seat = 3;   // Team 2 = North + South
    r.status = 'playing';
    r.paused = false;
    r.fmt = ROOM_FMT;
    r.moves = { 0: { d: newSeed(), l: Math.floor(Math.random() * 4), t: now() } };
    return r;
  }
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
  if (room.fmt !== ROOM_FMT) {
    toast('This room is from an older version of the game. Please make a new one.', 2500);
    detach(); store(ROOM_KEY, null); showChoose();
    return;
  }
  const prev = S.room;
  S.room = room;
  $('chatForm').hidden = !!room.public; // quick-play rooms: quick phrases only
  if (room.status === 'lobby') {
    if (room.public) { if (!ui.tick) ui.tick = setInterval(tickLobby, 1000); }
    else { clearInterval(ui.tick); ui.tick = null; }
    renderLobby(room);
    updateOpenIndex(room);
    if (room.public) maybeQuickStart();
    return;
  }
  if (!prev || prev.status === 'lobby') { clearInterval(ui.tick); ui.tick = null; showScreen('table'); resetTableCache(); bindTable(); }
  updateOpenIndex(room);
  const st = stateOf(room);
  if (st.corrupt || !st.game) return;

  // notices
  if (st.notice && st.notice.id !== ui.noticeId) { ui.noticeId = st.notice.id; if (prev) toast(st.notice.text, 1500); }

  // hold a just-finished trick on the table for a moment
  const p = st.game.Deal.ClosedDeal.Playout;
  const completed = p ? p.CompletedTricks.length : 0;
  if (st.dealNo !== ui.dealNo) {
    ui.dealNo = st.dealNo; ui.completed = completed; ui.showTrick = null; ui.trickWinner = null; clearTimeout(ui.trickTimer);
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
  const p = pidAtSeat(room, seat);
  if (isBot(p)) return BOT_MS;
  return absent(p) ? ABSENT_MS : TURN_MS;
}

function renderAll() {
  const room = S.room;
  const st = stateOf(room);
  if (!st.game) return;
  const my = me(room);
  const mySeat = my.seat;
  const game = st.game;
  const deal = game.Deal;
  const names = [0, 1, 2, 3].map((s) => { const p = pidAtSeat(room, s); return p ? (p.id === S.pid ? `${p.name} (you)` : p.name) : '—'; });
  const connected = [0, 1, 2, 3].map((s) => !absent(pidAtSeat(room, s)));
  const teamNames = teamNamesOf(room);
  const teamShort = teamNames.map((n) => n.split(' & ').map(shortName).join(' & '));
  const inHand = st.phase === 'auction' || st.phase === 'playout';
  const current = inHand ? OpenDeal.currentPlayer(deal) : null;
  const myTurn = inHand && current === mySeat && !room.paused && !ui.showTrick;
  let timerText = null;
  if (inHand && !room.paused) {
    const left = turnStart(room, st) + turnLimit(room, current) - now();
    if (left < 30000 || current === mySeat) timerText = fmtTime(left);
  }
  const awaiting = myTurn ? { type: st.phase === 'auction' ? 'bid' : 'play', legal: Game.currentInfoSet(game).LegalActions } : null;
  renderTable({
    mySeat, deal, handCounts: deal.Hands.map((h) => h.length), myHand: deal.Hands[mySeat],
    names, connected, teamNames: teamShort, teamShort, score: game.Score,
    gamesWon: st.stats.total.games, sets: st.stats.total.sets,
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
  } else if (st.phase === 'dealOver' && !ui.showTrick) {
    setSheet(dealSummaryHtml(st.lastDeal, names.map((n) => n.replace(' (you)', '')), teamNames) +
      `<div class="actions">` +
      (host ? `<button type="button" class="btn" data-action="next">Next deal</button><button type="button" class="btn secondary" data-action="pause">Pause game</button>`
            : `<p class="sub center">Waiting for ${escapeHtml(hostName)} to deal…</p>`) +
      `</div>`, sheetAction);
  } else if (st.phase === 'gameOver' && !ui.showTrick) {
    setSheet(gameOverHtml(st.winner, st.reason, teamNames, game.Score, st.stats.game, st.stats.total, st.stats.total.games, teamOfSeat(mySeat)) +
      `<div class="actions">` +
      (host ? `<button type="button" class="btn" data-action="rematch">Play again (same teams)</button>` : `<p class="sub center">Waiting for ${escapeHtml(hostName)} to start another game…</p>`) +
      `<button type="button" class="btn secondary" data-action="leave">Leave room</button>` +
      `</div>`, sheetAction);
  } else if (!ui.menuOpen) {
    setSheet(null);
  }
}

async function sheetAction(action) {
  if (action === 'next') await appendMove((st, r) => (isHost(r) && st.phase === 'dealOver' ? dealMove(st, r) : undefined));
  else if (action === 'rematch') await appendMove((st, r) => (isHost(r) && st.phase === 'gameOver' ? dealMove(st, r) : undefined));
  else if (action === 'pause') await tx((r) => { if (r.hostId !== S.pid) return undefined; r.paused = true; return r; });
  else if (action === 'resume') await tx((r) => { if (r.hostId !== S.pid) return undefined; r.paused = false; r.resumedAt = now(); return r; });
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
      `<p class="credit">If a player does not move within a minute (or eight seconds when their phone is disconnected), the computer plays that turn for them.` +
      (room.public ? ' This is a quick-play room: chat is limited to the quick phrases, and anyone who joins takes over a computer seat.' : '') + `</p>` + tipHtml(), sheetAction);
  };
}

async function act(action) {
  const room = S.room;
  const my = me(room);
  if (!my || my.seat === undefined) return;
  ui.busy = true;
  renderAll();
  try {
    await appendMove((st, r) => moveFor(st, r, my.seat, action));
  } finally {
    ui.busy = false;
    if (S && S.room) renderAll();
  }
}

/// Every phone except the one whose turn it is arms a timer; when the turn
/// limit passes, the first to append a move plays for the absent player. The
/// slot transaction guarantees only one of them succeeds.
function scheduleTakeover() {
  clearTimeout(ui.takeoverTimer);
  const room = S.room;
  if (!room || room.status !== 'playing' || room.paused) return;
  const st = stateOf(room);
  if (!st.game) return;
  const my = me(room);
  const seq = st.seq;
  let seat = null, due = null;
  if (st.phase === 'auction' || st.phase === 'playout') {
    seat = OpenDeal.currentPlayer(st.game.Deal);
    if (seat === my.seat) return; // my own turn: no takeover from me
    const bot = isBot(pidAtSeat(room, seat));
    const jitter = bot ? (my.seat || 0) * 250 + 100 : (my.seat || 0) * 900 + 200;
    due = turnStart(room, st) + turnLimit(room, seat) + jitter;
  } else if (st.phase === 'dealOver') {
    if (isHost(room)) return;
    due = turnStart(room, st) + (absent(room.players[room.hostId]) ? ABSENT_MS : TURN_MS) + (my.seat || 0) * 900 + 200;
  } else return;

  ui.takeoverTimer = setTimeout(async () => {
    const cur = S && S.room;
    if (!cur || stateOf(cur).seq !== seq) return; // something happened meanwhile
    if (seat !== null) {
      const info = Game.currentInfoSet(stateOf(cur).game);
      const { action } = chooseAction(info, rng, 200);
      await appendMove((st2, r) => (st2.seq === seq ? moveFor(st2, r, seat, action) : undefined));
    } else {
      await appendMove((st2, r) => (st2.seq === seq && st2.phase === 'dealOver' ? dealMove(st2, r) : undefined));
    }
  }, Math.max(0, due - now()));
}

// --------------------------------------------------------------- entry

export async function startMulti(storeImpl, joinCode) {
  S = { store: storeImpl, pid: getPid(), code: null, ref: null, room: null, unsub: null, stopPresence: null, onlineCount: null };
  if (storeImpl.online) {
    storeImpl.online(S.pid, (n) => {
      S.onlineCount = n;
      const el = $('onlineCount');
      if (el) el.textContent = onlineText(n);
    });
  }
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
