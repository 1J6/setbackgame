# Setback

Mobile-first Setback (Auction Pitch) for four: single player against computer opponents, or four
friends in a shared room with chat. Static site served by GitHub Pages at https://www.setbackgame.com.

Rules engine ported from [Brian Berns' Setback](https://github.com/brianberns/Setback). See `CLAUDE.md` for the file map,
multiplayer model, and how to test.

- `npm test` runs the rules and engine tests.
- `npm run serve`, then open http://localhost:8765/?local=1 in several tabs to try multiplayer without Firebase.
- Multiplayer needs a Firebase Realtime Database config in `firebase-config.js` and the rules from `firebase.rules.json`.
