// Room storage adapters for multiplayer.
//
//  * firebaseStore — Firebase Realtime Database (production).
//  * localStore    — same-browser adapter using localStorage + BroadcastChannel,
//                    used for testing several tabs on one machine (?local=1).
//
// Both expose: now(), open(code) -> { subscribe(cb) -> unsubscribe, transaction(fn), presence(pid), get() }
// transaction(fn): fn(current) returns the new value, null to delete, or undefined to abort.

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve; s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

export async function makeStore() {
  if (new URLSearchParams(location.search).get('local') === '1') return localStore();
  const cfg = window.SETBACK_FIREBASE_CONFIG;
  if (!cfg || !cfg.databaseURL) return null;
  return firebaseStore(cfg);
}

async function firebaseStore(cfg) {
  const V = '10.14.1';
  await loadScript(`https://www.gstatic.com/firebasejs/${V}/firebase-app-compat.js`);
  await loadScript(`https://www.gstatic.com/firebasejs/${V}/firebase-database-compat.js`);
  const fb = window.firebase;
  if (!fb.apps.length) fb.initializeApp(cfg);
  const db = fb.database();
  let offset = 0;
  db.ref('.info/serverTimeOffset').on('value', (s) => { offset = s.val() || 0; });
  return {
    kind: 'firebase',
    now: () => Date.now() + offset,
    open(code) {
      const ref = db.ref('rooms/' + code);
      return {
        subscribe(cb) {
          const h = ref.on('value', (s) => cb(s.val()));
          return () => ref.off('value', h);
        },
        async transaction(fn) {
          const r = await ref.transaction(fn, undefined, true);
          return { committed: r.committed, value: r.snapshot ? r.snapshot.val() : null };
        },
        presence(pid) {
          const c = ref.child('players/' + pid + '/connected');
          c.onDisconnect().set(false);
          c.set(true);
          const again = () => { if (document.visibilityState === 'visible') c.set(true); };
          document.addEventListener('visibilitychange', again);
          return () => { document.removeEventListener('visibilitychange', again); c.onDisconnect().cancel(); c.set(false); };
        },
        async get() { return (await ref.get()).val(); },
        // chat lives beside the game state so messages never contend with moves
        subscribeChat(cb) {
          const q = ref.child('chat').limitToLast(80);
          const h = q.on('value', (s) => {
            const v = s.val() || {};
            cb(Object.entries(v).map(([id, m]) => ({ id, ...m })).sort((a, b) => a.t - b.t));
          });
          return () => q.off('value', h);
        },
        pushChat(msg) { return ref.child('chat').push(msg); },
        removeChat(id) { return ref.child('chat/' + id).remove(); },
      };
    },
  };
}

function localStore() {
  const chan = new BroadcastChannel('lis-setback-local');
  const key = (code) => 'lis-setback-local-' + code;
  const read = (code) => { try { const s = localStorage.getItem(key(code)); return s ? JSON.parse(s) : null; } catch { return null; } };
  return {
    kind: 'local',
    now: () => Date.now(),
    open(code) {
      return {
        subscribe(cb) {
          const onMsg = (e) => { if (e.data && e.data.code === code) cb(read(code)); };
          const onStorage = (e) => { if (e.key === key(code)) cb(read(code)); };
          chan.addEventListener('message', onMsg);
          window.addEventListener('storage', onStorage);
          setTimeout(() => cb(read(code)), 0);
          return () => { chan.removeEventListener('message', onMsg); window.removeEventListener('storage', onStorage); };
        },
        async transaction(fn) {
          const cur = read(code);
          const out = fn(cur === null ? null : JSON.parse(JSON.stringify(cur)));
          if (out === undefined) return { committed: false, value: cur };
          if (out === null) localStorage.removeItem(key(code));
          else localStorage.setItem(key(code), JSON.stringify(out));
          chan.postMessage({ code });
          // same-tab listeners do not get BroadcastChannel/storage events
          window.dispatchEvent(new StorageEvent('storage', { key: key(code) }));
          return { committed: true, value: out };
        },
        presence() { return () => {}; },
        async get() { return read(code); },
        subscribeChat(cb) {
          const ck = key(code) + '-chat';
          const readChat = () => { try { return JSON.parse(localStorage.getItem(ck) || '[]'); } catch { return []; } };
          const onMsg = (e) => { if (e.data && e.data.code === code && e.data.chat) cb(readChat()); };
          const onStorage = (e) => { if (e.key === ck) cb(readChat()); };
          chan.addEventListener('message', onMsg);
          window.addEventListener('storage', onStorage);
          setTimeout(() => cb(readChat()), 0);
          return () => { chan.removeEventListener('message', onMsg); window.removeEventListener('storage', onStorage); };
        },
        async pushChat(msg) {
          const ck = key(code) + '-chat';
          let list = []; try { list = JSON.parse(localStorage.getItem(ck) || '[]'); } catch { list = []; }
          list.push({ id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), ...msg });
          localStorage.setItem(ck, JSON.stringify(list.slice(-80)));
          chan.postMessage({ code, chat: true });
          window.dispatchEvent(new StorageEvent('storage', { key: ck }));
        },
        async removeChat(id) {
          const ck = key(code) + '-chat';
          let list = []; try { list = JSON.parse(localStorage.getItem(ck) || '[]'); } catch { list = []; }
          localStorage.setItem(ck, JSON.stringify(list.filter((m) => m.id !== id)));
        },
      };
    },
  };
}
