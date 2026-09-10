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
        // transaction on one child path (e.g. 'moves/12'): the write is just
        // that node, so appending a move costs a few bytes, not the whole room
        async transactionAt(path, fn) {
          const r = await ref.child(path).transaction(fn, undefined, true);
          return { committed: r.committed, value: r.snapshot ? r.snapshot.val() : null };
        },
        presence(pid) {
          const c = ref.child('players/' + pid + '/connected');
          c.onDisconnect().set(false);
          // A plain set()/update() anywhere under the room aborts any transaction this
          // client has in flight on the room (the SDK cancels it with reason 'set'),
          // so presence is written through a transaction too.
          const mark = () => c.transaction(() => true);
          mark();
          const again = () => { if (document.visibilityState === 'visible') mark(); };
          document.addEventListener('visibilitychange', again);
          // No write on cleanup: leaving is recorded by the room transaction itself, and
          // this cleanup runs from the value listener while that transaction is still
          // pending, so a set(false) here would abort it (the room was never deleted).
          return () => { document.removeEventListener('visibilitychange', again); c.onDisconnect().cancel(); };
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
        async transactionAt(path, fn) {
          const room = read(code);
          const keys = path.split('/');
          let node = room;
          for (let i = 0; i < keys.length - 1 && node; i++) node = node[keys[i]];
          const leaf = keys[keys.length - 1];
          const cur = node && node[leaf] !== undefined ? JSON.parse(JSON.stringify(node[leaf])) : null;
          const out = fn(cur);
          if (out === undefined) return { committed: false, value: cur };
          if (!room) return { committed: false, value: null };
          let target = room;
          for (let i = 0; i < keys.length - 1; i++) { if (!target[keys[i]]) target[keys[i]] = {}; target = target[keys[i]]; }
          if (out === null) delete target[leaf]; else target[leaf] = out;
          localStorage.setItem(key(code), JSON.stringify(room));
          chan.postMessage({ code });
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
