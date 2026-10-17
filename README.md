# lightline

A daily light puzzle. Place mirrors so the laser lights every crystal. There's a new puzzle every day, and
everyone gets the same one.

Live: https://mridulsaravanan.com/lightline/

- **Tap a square** to place a mirror. Tap again to turn it, and once more to clear it. Light bounces off mirrors at
  right angles, stops at walls and passes straight through crystals.
- **The budget is always the minimum.** Each puzzle can be solved with exactly the mirrors you're given and never
  with fewer.
- **Difficulty follows the week.** Monday is easy. Bolted mirrors appear midweek, and Saturday and Sunday bring
  prisms that split the light in two.
- **Practice mode** makes unlimited extra puzzles (Easy, Medium, Hard or Expert). They don't count towards your streak.
- **Hints and Show answer.** Up to 3 hints per puzzle, each showing a ghost of one mirror from the intended solution;
  hints halve the XP and show as bulbs in the share text. Show answer (asks first) places the whole solution; that
  puzzle is recorded as revealed: no streak, no XP, not a win.
- **Levels.** XP per solve: Easy 10, Medium 20, Hard 35, Expert 50 (the daily by its difficulty). Levels cost 20, 30,
  40... XP, so level 3 = 50, 6 = 200, 10 = 540 XP. Practice Medium opens at level 3, Hard at 6, Expert at 10; the daily
  is open to everyone. XP and level are always recomputed from the saved history, never kept as a running total.
- **Trial run.** How to play has a Try it button: a 4x4 puzzle with step-by-step coaching. It never touches stats.
- Moves and a timer, undo and reset, a spoiler-free share text, a streak and stats. Keyboard on desktop:
  arrows to move, Space to place or turn, Delete to clear, U to undo.
- **Private by default.** Everything runs in the browser and progress is kept on the device under `lightline.*` keys.
  If saved stats can't be read, they are left untouched rather than reset. Logging in (Google or Discord, optional)
  backs the history and settings up to Firestore (`lightline/{uid}`) through the sign-in server at
  auth.mridulsaravanan.com, ported from Ruledrift's `cloud.js`. Devices merge by a union of history entries; a backup
  that can't be read is never overwritten. Google's sign-in script loads only when the log in pop-up opens.

`engine.js` holds the puzzle maker, light tracer, solver, streak rules, XP and levels, history merging and share text.
`cloud.js` holds the optional account and backup code. It has no DOM, clock or
`Math.random`. The local date goes through FNV-1a and then mulberry32, so the same date always gives the same
puzzle. Each puzzle is built solution first, then checked by an exhaustive solver. `index.html` is the page: the
beam is drawn on a canvas, with real buttons on top for touch, keyboard and screen readers.
Fonts: Pixelify Sans and Figtree (SIL Open Font License, `assets/fonts/`).

Testing (in `../lightline-tests`):
- `node test_engine.js` runs 63,809 checks. They cover every date for two years plus 2,000 random seeds, at every
  difficulty. For each puzzle they check that the intended solution works, that zero mirrors don't, that no
  solution uses fewer mirrors, that every mirror is needed and that the output is deterministic. They also check
  that light can never loop forever, run the solver on a sample, and test streaks, the share text, XP, levels, locks,
  history merging and cloud-read handling.
- `python smoke.py` runs 205 browser checks at 390 px and 1366 px. It solves today's puzzle by tapping, then checks
  the win card, the share text and clipboard, reload, practice mode, unreadable stats, reduced motion and touch. It
  also covers hints, Show answer, the trial run, level locks, and log in and sync against mocked sign-in and Firestore
  endpoints (Discord return, forged state, Google, failed reads, merge, sign out, delete). It also confirms there's no
  horizontal scroll, no console errors and no external requests other than Google's sign-in script.
