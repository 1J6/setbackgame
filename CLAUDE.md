# setbackgame.com

Mobile-first Setback (Auction Pitch) card game. Static site, no build step, served by GitHub Pages
from `main` at https://www.setbackgame.com (CNAME file). Every file is plain HTML/CSS/ES modules.

## Files

| File | Role |
| --- | --- |
| `index.html` | Shell: start screen container, the table (`#app`), sheet overlay, chat panel. Asset links carry `?v=N`; bump N when CSS/JS change so phones drop cached copies. |
| `app.js` | Entry: start screen and hash routing (`#single`, `#multi`, `#join=CODE`). |
| `view.js` | Shared table renderer. Draws relative to `mySeat` (always bottom). Seats/slots/hand are rebuilt only when their HTML changes, so entrance animations run once. Also sheets, toast, deal and game summaries. |
| `single.js` | Single player vs three computer players. State in `localStorage` (`lis-setback-v2`). |
| `multi.js` | Multiplayer: lobby, teams, move appends and room transactions, turn timer + computer takeover, host pause/rematch, chat. |
| `replay.js` | Move-log state: seeded shuffle, `apply`/`validate` one move, `replay` a list. Pure and tested in `tests/test_replay.mjs`. |
| `store.js` | Room storage adapters: Firebase Realtime Database, and a same-browser adapter for `?local=1` testing. |
| `engine.js` | Rules engine, a function-for-function port of brianberns/Setback (F#). Do not "improve" rules here; compare against the F# source. One deliberate house deviation: a bid of four cannot be outbid and ends the auction (the F# dealer "steal" is removed). |
| `ai.js` | Monte Carlo computer player (samples unseen cards consistent with plays and voids, rolls out with a heuristic policy). Self-play A/B findings (Sep 2026, 300-game runs): more sampled worlds is the one reliable strength gain (300 vs 100 worlds won 57%); bid-aware sampling, conservative-bidding knobs, and rollout-policy refinements (Low awareness, trump-in costs, third-hand-high, draw-trump restraint) were all neutral or worse, so keep the policy simple. Bidding is near a self-play equilibrium: most auctions end at 3, and 4-bids are mostly deliberate blocks under the bid-out-at-11 rule. |
| `coach.js` | Single-player coach mode: plain-language reasons for the AI's recommended bid or card, plus a review of the user's choice against it. Reuses the hand-reading helpers exported by `ai.js`. |
| `history.js` | Finished games saved on the device as move logs (last 30) plus personal stats computed by replaying them. |
| `replayview.js` | Replay viewer on the normal table: prev/next move, deal jumps, coach review of the user's moves. Entered from the History screen in app.js. |
| `share.png` | 1200x630 Open Graph image, rendered by a PowerShell GDI+ script (not checked in); regenerate by hand if the look changes. |
| `rules.js` | House scoring: win at 11 only by bidding and making it that deal; 15 any way wins; -6 loses; bidder reaching 11 beats opponent reaching 15 on the same deal. Stats helpers. |
| `firebase-config.js` | `window.SETBACK_FIREBASE_CONFIG = {...}` from the Firebase console. Multiplayer is disabled while it is `null`. |
| `firebase.rules.json` | Realtime Database security rules to paste into the console. |
| `tests/` | Node tests (`npm test`) and an AI strength benchmark (`npm run bench`). |

## Multiplayer model

- Room document at `rooms/{CODE}`: `players` (name, team, seat, connected, left, joinedAt), `hostId`,
  `status` (lobby/playing), `paused`, `resumedAt`, `fmt` (2), and `moves`: an append-only list of
  small moves (`{d: seed, l?: dealer, t}` deal / rematch, `{b: bid, t, d?: seed}` bid with a redeal seed
  when it ends an all-pass auction, `{c: card, t}` play). `replay.js` folds the list into game state
  (phase auction/playout/dealOver/gameOver, score, deal summary, stats); the shuffle is seeded so every
  phone deals the same hands. Rooms with `fmt` other than 2 are treated as stale and not joinable.
- A move is appended with a transaction on its own slot (`moves/{seq}`), so the write is a few bytes
  and a phone acting on a stale state finds the slot taken and retries from the newer state
  (`appendMove` in multi.js). Room-level changes (join, leave, teams, start, pause, host) are
  transactions on the room document (`tx`).
- Turn limit 60 s (8 s if the player is disconnected/left), measured from the last move's `t` or the
  last resume. All other clients arm a timer; the first slot transaction to commit plays the AI move
  for that seat.
- Seats: Team 1 (E+W) = seats 0 and 2, Team 2 (N+S) = seats 1 and 3. Screen position = `(seat - mySeat + 3) % 4`.
- Player identity `lis-setback-pid` in localStorage (sessionStorage under `?local=1` so tabs differ).
- Chat is at `rooms/{CODE}/chat` (push list), separate from the moves. Quick-play rooms hide the free-text
  input, so strangers only exchange the quick phrases.
- Quick Play: `open/{CODE}` = `{t: createdAt, n: humans}` is an index of public rooms with a seat to give,
  kept by the room's host (`updateOpenIndex`, with an onDisconnect removal). Quick Play reads it, tries the
  fullest fresh room, else creates a public room (`public: true`, `startAt`). A public lobby starts when four
  humans are in or when `startAt` passes (host first, others as backup); empty seats get computer players
  (`bot: true`, names Bot Ada/Max/Ivy) that any client plays for after 1.2 s. Joining a public game in
  progress replaces a computer or a departed (`left`) player and takes that seat. When the last human leaves,
  the room and its index entry are deleted.
- `counts/online` is a single number for the "players online" line: each connection increments it and
  registers an onDisconnect decrement, so clients download one value. It can drift slightly after crashes.
- Single player: deals are seeded and every action is appended to `pers.log`, so a finished game is a move
  log saved to history. `startSingle({ tutorial: true })` plays a guided first hand on a fixed seed
  (TUT_SEED in single.js) with only the coach's choice tappable and short sheets at each new moment.
- Coach mode also exists for code rooms in multiplayer (per-device setting, off by default); host tools:
  remove a player, fill empty seats with computers. Invite links with a remembered name join directly.
- Traffic: about 18 bytes per move on the wire, roughly 10 KB per phone per game (the old JSON blob
  design re-sent about 1 KB on every move).

## Working on it

- Test: `npm test`. Serve locally: `npm run serve` then open `http://localhost:8765/?local=1` and use
  several tabs with `#join=CODE` to simulate players without Firebase.
- UX rules the owner has asked for: turn changes are a plain instant highlight (no transitions, no
  "thinking" text); a played card and a new bid animate exactly once; keep everything thumb-sized.
- No browser `confirm()`/`alert()` dialogs: iOS suppresses them for home-screen web apps. Use `armTap`
  (two-tap confirm) from view.js. Sheets with a Close button also close on a backdrop tap.
- Table color is a saved theme (`lis-setback-theme`: green/navy/black/white) applied as `data-theme` on
  `<html>` before first paint; colours in setback.css are tokens, so new themes are a variable block.
- Deploy: commit to `main` and push; GitHub Pages publishes in about a minute.
