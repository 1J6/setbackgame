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
| `multi.js` | Multiplayer: lobby, teams, transactions on the room, turn timer + computer takeover, host pause/rematch, chat. |
| `store.js` | Room storage adapters: Firebase Realtime Database, and a same-browser adapter for `?local=1` testing. |
| `engine.js` | Rules engine, a function-for-function port of brianberns/Setback (F#). Do not "improve" rules here; compare against the F# source. One deliberate house deviation: a bid of four cannot be outbid and ends the auction (the F# dealer "steal" is removed). |
| `ai.js` | Monte Carlo computer player (samples unseen cards consistent with plays and voids, rolls out with a heuristic policy). Self-play A/B findings (Sep 2026, 300-game runs): more sampled worlds is the one reliable strength gain (300 vs 100 worlds won 57%); bid-aware sampling, conservative-bidding knobs, and rollout-policy refinements (Low awareness, trump-in costs, third-hand-high, draw-trump restraint) were all neutral or worse, so keep the policy simple. Bidding is near a self-play equilibrium: most auctions end at 3, and 4-bids are mostly deliberate blocks under the bid-out-at-11 rule. |
| `coach.js` | Single-player coach mode: plain-language reasons for the AI's recommended bid or card, plus a review of the user's choice against it. Reuses the hand-reading helpers exported by `ai.js`. |
| `rules.js` | House scoring: win at 11 only by bidding and making it that deal; 15 any way wins; -6 loses; bidder reaching 11 beats opponent reaching 15 on the same deal. Stats helpers. |
| `firebase-config.js` | `window.SETBACK_FIREBASE_CONFIG = {...}` from the Firebase console. Multiplayer is disabled while it is `null`. |
| `firebase.rules.json` | Realtime Database security rules to paste into the console. |
| `tests/` | Node tests (`npm test`) and an AI strength benchmark (`npm run bench`). |

## Multiplayer model

- Room document at `rooms/{CODE}`: `players` (name, team, seat, connected, left, joinedAt), `hostId`,
  `status` (lobby/playing), `paused`, `stats`, `turnStartedAt`, `version`, and `blob` (JSON string with
  `game`, `phase` auction/playout/dealOver/gameOver, `lastDeal`, `dealNo`, `scoreBefore`).
- Every mutation is a transaction that re-validates against the current room (`applyGameAction`,
  `applyNextDeal`, `applyRematch`). The blob is a string so Firebase never drops empty arrays or nulls.
- Turn limit 60 s (8 s if the player is disconnected/left). All other clients arm a timer; the first
  transaction to commit plays the AI move for that seat. `version` prevents double application.
- Seats: Team 1 (E+W) = seats 0 and 2, Team 2 (N+S) = seats 1 and 3. Screen position = `(seat - mySeat + 3) % 4`.
- Player identity `lis-setback-pid` in localStorage (sessionStorage under `?local=1` so tabs differ).
- Chat is at `rooms/{CODE}/chat` (push list), separate from the blob.

## Working on it

- Test: `npm test`. Serve locally: `npm run serve` then open `http://localhost:8765/?local=1` and use
  several tabs with `#join=CODE` to simulate players without Firebase.
- UX rules the owner has asked for: turn changes are a plain instant highlight (no transitions, no
  "thinking" text); a played card and a new bid animate exactly once; keep everything thumb-sized.
- Deploy: commit to `main` and push; GitHub Pages publishes in about a minute.
