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
- Moves and a timer, undo and reset, a spoiler-free share text, a streak and stats. Keyboard on desktop:
  arrows to move, Space to place or turn, Delete to clear, U to undo.
- **Private.** Everything runs in the browser. The streak and stats are kept on the device under `lightline.*` keys.
  If saved stats can't be read, they are left untouched rather than reset.

`engine.js` holds the puzzle maker, light tracer, solver, streak rules and share text. It has no DOM, clock or
`Math.random`. The local date goes through FNV-1a and then mulberry32, so the same date always gives the same
puzzle. Each puzzle is built solution first, then checked by an exhaustive solver. `index.html` is the page: the
beam is drawn on a canvas, with real buttons on top for touch, keyboard and screen readers.
Fonts: Pixelify Sans and Figtree (SIL Open Font License, `assets/fonts/`).

Testing (in `../lightline-tests`):
- `node test_engine.js` runs 63,771 checks. They cover every date for two years plus 2,000 random seeds, at every
  difficulty. For each puzzle they check that the intended solution works, that zero mirrors don't, that no
  solution uses fewer mirrors, that every mirror is needed and that the output is deterministic. They also check
  that light can never loop forever, run the solver on a sample, and test streaks and the share text.
- `python smoke.py` runs 131 browser checks at 390 px and 1366 px. It solves today's puzzle by tapping, then checks
  the win card, the share text and clipboard, reload, practice mode, unreadable stats, reduced motion and touch. It
  also confirms there's no horizontal scroll, no console errors and no external requests.
