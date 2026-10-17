/* lightline engine: daily mirror-and-laser puzzles.
   Pure functions, no DOM, no clock and no browser randomness inside generation, so the same date always
   gives the same puzzle and the whole thing runs in Node for tests.

   Grid cells (a string, row by row):
     .  empty (the player may place a mirror here)
     #  wall: stops the light
     *  crystal: the light passes straight through and lights it
     /  \  fixed mirrors
     +  prism: splits the light into the two side directions
   Player mirrors live in a separate "placements" string/array of the same length ('.', '/', '\\'). */
(function (root) {
  'use strict';

  var SIZE = 7;
  var CAP = 2000; // step cap per trace; 7x7 cells x 4 directions = 196 states, so a correct trace never gets near it
  var DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // up, right, down, left
  var SLASH = [1, 0, 3, 2]; // '/': up->right, right->up, down->left, left->down
  var BACK = [3, 2, 1, 0];  // '\': up->left, right->down, down->right, left->up

  // Mon 1 (easy) ... Sun 7 (expert). mirrors = the player's budget in the intended solution.
  var LEVELS = {
    1: { name: 'Easy', mirrors: 2, fixed: 0, split: 0, targets: 2, walls: 4, decoys: 0 },
    2: { name: 'Easy', mirrors: 3, fixed: 0, split: 0, targets: 3, walls: 5, decoys: 0 },
    3: { name: 'Medium', mirrors: 3, fixed: 1, split: 0, targets: 3, walls: 5, decoys: 1 },
    4: { name: 'Medium', mirrors: 4, fixed: 1, split: 0, targets: 3, walls: 6, decoys: 1 },
    5: { name: 'Hard', mirrors: 4, fixed: 2, split: 0, targets: 4, walls: 6, decoys: 2 },
    6: { name: 'Hard', mirrors: 4, fixed: 1, split: 1, targets: 4, walls: 6, decoys: 1 },
    7: { name: 'Expert', mirrors: 5, fixed: 1, split: 1, targets: 5, walls: 7, decoys: 2 }
  };
  var MAX_ATTEMPTS = 400;
  var counters = { generated: 0, fallbacks: 0 };

  // ---------- hashing and random numbers ----------
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rint(rng, n) { return Math.floor(rng() * n); }
  function pick(rng, arr) { return arr[rint(rng, arr.length)]; }
  function shuffle(rng, arr) {
    for (var i = arr.length - 1; i > 0; i--) { var j = rint(rng, i + 1), t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }

  // ---------- dates (local calendar day keys, "YYYY-MM-DD") ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(d) { d = d ? new Date(d) : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDay(k) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  function shiftDay(k, n) {
    var t = parseDay(k); if (isNaN(t)) return '';
    var d = new Date(t + n * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function weekday(k) { var t = parseDay(k); return isNaN(t) ? -1 : new Date(t).getUTCDay(); } // 0 = Sunday
  function levelForDay(k) { var w = weekday(k); return w === 0 ? 7 : (w < 0 ? 1 : w); }

  // ---------- geometry ----------
  function emitterStart(n, em) {
    // the cell just outside the grid and the direction the light travels in
    if (em.side === 0) return { r: -1, c: em.i, d: 2 };
    if (em.side === 1) return { r: em.i, c: n, d: 3 };
    if (em.side === 2) return { r: n, c: em.i, d: 0 };
    return { r: em.i, c: -1, d: 1 };
  }
  function cellAt(pz, pl, i) {
    var ch = pz.cells[i];
    if (ch === '.' && pl) { var p = pl[i]; if (p === '/' || p === '\\') return p; }
    return ch;
  }

  /* Trace the light. Returns every beam as a polyline in cell units (cell (r,c) has its centre at x=c+.5, y=r+.5),
     how often each cell is crossed, whether every crystal is lit, and loop/cap flags.
     `decided` (optional, solver only) lets the solver find the first undecided empty cell on the path. */
  function trace(pz, pl, decided) {
    var n = pz.size, N = n * n;
    var seen = new Uint8Array(N * 4), visits = new Array(N);
    for (var q = 0; q < N; q++) visits[q] = 0;
    var s = emitterStart(n, pz.emitter);
    var beams = [], queue = [], steps = 0, loop = false, capped = false, firstFree = -1;
    var dr0 = DIRS[s.d][0], dc0 = DIRS[s.d][1];
    queue.push({ r: s.r, c: s.c, d: s.d, pts: [[s.c + 0.5 + 0.3 * dc0, s.r + 0.5 + 0.3 * dr0]], cells: [], d0: 0, parent: -1 });
    while (queue.length) {
      var b = queue.shift(), r = b.r, c = b.c, d = b.d;
      b.end = 'exit';
      for (;;) {
        if (++steps > CAP) { capped = true; b.end = 'cap'; break; }
        var dr = DIRS[d][0], dc = DIRS[d][1];
        r += dr; c += dc;
        if (r < 0 || c < 0 || r >= n || c >= n) { b.pts.push([c + 0.5 - 0.2 * dc, r + 0.5 - 0.2 * dr]); b.end = 'exit'; break; }
        var i = r * n + c, ch = cellAt(pz, pl, i);
        if (ch === '#') { b.pts.push([c + 0.5 - 0.5 * dc, r + 0.5 - 0.5 * dr]); b.end = 'wall'; b.hit = i; break; }
        var k = i * 4 + d;
        if (seen[k]) { b.pts.push([c + 0.5, r + 0.5]); b.end = 'loop'; loop = true; break; }
        seen[k] = 1; visits[i]++; b.cells.push(i);
        if (decided && firstFree < 0 && pz.cells[i] === '.' && !decided[i]) firstFree = i;
        if (ch === '/' || ch === '\\') { b.pts.push([c + 0.5, r + 0.5]); d = (ch === '/' ? SLASH : BACK)[d]; continue; }
        if (ch === '+') {
          b.pts.push([c + 0.5, r + 0.5]); b.end = 'split';
          var idx = beams.length;
          queue.push({ r: r, c: c, d: (d + 1) % 4, pts: [[c + 0.5, r + 0.5]], cells: [], parent: idx });
          queue.push({ r: r, c: c, d: (d + 3) % 4, pts: [[c + 0.5, r + 0.5]], cells: [], parent: idx });
          break;
        }
      }
      b.len = polyLen(b.pts);
      if (b.parent >= 0) b.d0 = beams[b.parent].d0 + beams[b.parent].len;
      beams.push(b);
    }
    var targets = 0, lit = [];
    for (var j = 0; j < N; j++) if (pz.cells[j] === '*') { targets++; if (visits[j] > 0) lit.push(j); }
    return {
      beams: beams, visits: visits, lit: lit, litCount: lit.length, targets: targets,
      solved: targets > 0 && lit.length === targets, steps: steps, loop: loop, capped: capped, firstFree: firstFree
    };
  }
  function polyLen(pts) {
    var L = 0;
    for (var i = 1; i < pts.length; i++) L += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    return L;
  }

  function countPlaced(pz, pl) {
    var n = 0;
    if (!pl) return 0;
    for (var i = 0; i < pz.cells.length; i++) if (pz.cells[i] === '.' && (pl[i] === '/' || pl[i] === '\\')) n++;
    return n;
  }
  function isSolved(pz, pl) { return countPlaced(pz, pl) <= pz.budget && trace(pz, pl).solved; }

  // ---------- generation (solution first) ----------
  function blank(n) { var a = []; for (var i = 0; i < n * n; i++) a.push('.'); return a; }
  function asPuzzle(n, em, cells) { return { size: n, emitter: em, cells: cells.join('') }; }
  function merged(cells, sol) { var a = cells.slice(); for (var i = 0; i < a.length; i++) if (sol[i] !== '.') a[i] = sol[i]; return a; }

  // how many free cells the light would cross leaving cell (r,c) in direction d before it leaves the grid or meets anything
  function runFrom(n, grid, r, c, d) {
    var k = 0;
    for (;;) {
      r += DIRS[d][0]; c += DIRS[d][1];
      if (r < 0 || c < 0 || r >= n || c >= n) return k;
      if (grid[r * n + c] !== '.') return k;
      k++;
    }
  }
  function outDirs(type, d) {
    if (type === '+') return [(d + 1) % 4, (d + 3) % 4];
    return [(type === '/' ? SLASH : BACK)[d]];
  }

  function attempt(rng, n, cfg) {
    var em = { side: rint(rng, 4), i: 1 + rint(rng, n - 2) };
    var cells = blank(n), sol = blank(n);
    var turns = [], t;
    for (t = 0; t < cfg.mirrors; t++) turns.push('P');
    for (t = 0; t < cfg.fixed; t++) turns.push('F');
    shuffle(rng, turns);
    if (cfg.split) turns.splice(rint(rng, Math.max(1, Math.floor(turns.length / 2))), 0, 'S');

    for (t = 0; t < turns.length; t++) {
      var grid = merged(cells, sol);
      var pz = asPuzzle(n, em, grid);
      var tr = trace(pz, null);
      if (tr.loop || tr.capped) return null;
      var opts = [];
      tr.beams.forEach(function (b) {
        if (b.end !== 'exit') return;
        // the straight tail: cells after the last turn on this beam
        var tail = [];
        for (var x = b.cells.length - 1; x >= 0; x--) { if (grid[b.cells[x]] !== '.') break; tail.unshift(b.cells[x]); }
        var dIn = dirOfTail(n, b, tail);
        tail.forEach(function (ci) {
          if (tr.visits[ci] !== 1) return; // never turn on a crossing: it would bend the other pass too
          var types = turns[t] === 'S' ? ['+'] : ['/', '\\'];
          types.forEach(function (ty) {
            var r = Math.floor(ci / n), c = ci % n, ok = true;
            var g2 = grid.slice(); g2[ci] = ty;
            outDirs(ty, dIn).forEach(function (od) { if (runFrom(n, g2, r, c, od) < 2) ok = false; });
            if (ok) opts.push([ci, ty]);
          });
        });
      });
      if (!opts.length) return null;
      var o = pick(rng, opts);
      if (turns[t] === 'P') sol[o[0]] = o[1]; else cells[o[0]] = o[1];
    }

    var full = asPuzzle(n, em, merged(cells, sol));
    var S = trace(full, null);
    if (S.loop || S.capped) return null;

    // walls and decoy mirrors only where the solution's light never goes, so the solution is untouched
    var free = [];
    for (var i = 0; i < n * n; i++) if (S.visits[i] === 0 && cells[i] === '.' && sol[i] === '.') free.push(i);
    shuffle(rng, free);
    var w = 0;
    for (; w < cfg.walls && free.length; w++) cells[free.pop()] = '#';
    for (var dcy = 0; dcy < cfg.decoys && free.length; dcy++) cells[free.pop()] = rng() < 0.5 ? '/' : '\\';

    var pzNoT = asPuzzle(n, em, cells);
    var Z = trace(pzNoT, null); // what the light does with no player mirrors
    if (Z.loop || Z.capped) return null;
    var S2 = trace(asPuzzle(n, em, merged(cells, sol)), null);
    for (i = 0; i < n * n; i++) if (S2.visits[i] !== S.visits[i]) return null;

    // crystals: on the solution's path, on plain cells, mostly where the light cannot reach without the player
    var need = [], spare = [];
    for (i = 0; i < n * n; i++) {
      if (cells[i] !== '.' || sol[i] !== '.' || S.visits[i] === 0) continue;
      if (Z.visits[i] === 0) need.push(i); else spare.push(i);
    }
    var chosen = [];
    // one crystal after the last player mirror on every beam that has one
    S.beams.forEach(function (b) {
      var last = -1;
      for (var x = 0; x < b.cells.length; x++) if (sol[b.cells[x]] !== '.') last = x;
      if (last < 0) return;
      var after = b.cells.slice(last + 1).filter(function (ci) { return need.indexOf(ci) >= 0 && chosen.indexOf(ci) < 0; });
      if (after.length) chosen.push(pick(rng, after));
    });
    var freebie = cfg.mirrors <= 3 && spare.length && rng() < 0.5 ? 1 : 0;
    var pool = need.filter(function (ci) { return chosen.indexOf(ci) < 0; });
    shuffle(rng, pool);
    while (chosen.length < cfg.targets - freebie && pool.length) {
      // keep crystals apart: take the first pooled cell not touching an existing crystal, else any
      var at = 0;
      for (var y = 0; y < pool.length; y++) { if (!touches(n, pool[y], chosen)) { at = y; break; } }
      chosen.push(pool.splice(at, 1)[0]);
    }
    if (freebie && chosen.length < cfg.targets) chosen.push(pick(rng, spare));
    if (chosen.length !== cfg.targets) return null;
    chosen.forEach(function (ci) { cells[ci] = '*'; });

    var puzzle = { v: 1, size: n, emitter: em, cells: cells.join(''), budget: cfg.mirrors };
    var solStr = sol.join('');
    if (!trace(puzzle, solStr).solved) return null;
    if (trace(puzzle, null).solved) return null;
    // every player mirror must matter
    for (i = 0; i < n * n; i++) {
      if (sol[i] === '.') continue;
      var minus = sol.slice(); minus[i] = '.';
      if (trace(puzzle, minus.join('')).solved) return null;
    }
    // and there is no shortcut: the budget is the true minimum (the solver is exhaustive and takes milliseconds)
    var shorter = solve(puzzle, cfg.mirrors - 1, 200000);
    if (shorter.found || shorter.capped) return null;
    return { puzzle: puzzle, solution: solStr };
  }
  function touches(n, ci, list) {
    var r = Math.floor(ci / n), c = ci % n;
    return list.some(function (o) { var r2 = Math.floor(o / n), c2 = o % n; return Math.abs(r - r2) <= 1 && Math.abs(c - c2) <= 1; });
  }
  // direction the light travels along a beam's tail
  function dirOfTail(n, b, tail) {
    var pts = b.pts, a = pts[pts.length - 2], z = pts[pts.length - 1];
    var dx = Math.sign(z[0] - a[0]), dy = Math.sign(z[1] - a[1]);
    for (var d = 0; d < 4; d++) if (DIRS[d][0] === dy && DIRS[d][1] === dx) return d;
    return 1;
  }

  function fallback(n) {
    // a fixed tiny puzzle, only used if every attempt failed (the tests check this never happens)
    var cells = blank(n), sol = blank(n), mid = Math.floor(n / 2);
    sol[mid * n + mid + 1] = '/';
    cells[1 * n + mid + 1] = '*';
    cells[mid * n + 1] = '*';
    cells[2 * n + 1] = '#';
    return { puzzle: { v: 1, size: n, emitter: { side: 3, i: mid }, cells: cells.join(''), budget: 1 }, solution: sol.join('') };
  }

  function generate(seed, level) {
    level = LEVELS[level] ? level : 1;
    var cfg = LEVELS[level], n = SIZE;
    var rng = mulberry32(fnv1a('lightline|' + seed + '|' + level));
    var out = null, tries = 0;
    while (!out && tries < MAX_ATTEMPTS) { tries++; out = attempt(rng, n, cfg); }
    counters.generated++;
    var fb = false;
    if (!out) { out = fallback(n); fb = true; counters.fallbacks++; }
    out.puzzle.seed = String(seed);
    out.puzzle.level = level;
    out.attempts = tries;
    out.fallback = fb;
    return out;
  }
  function daily(day) { return generate('daily:' + day, levelForDay(day)); }

  // ---------- solver: depth-first, each empty cell is decided the first time the light reaches it ----------
  function solve(pz, maxMirrors, nodeCap) {
    var N = pz.size * pz.size, pl = blank(pz.size), decided = new Uint8Array(N), nodes = 0;
    nodeCap = nodeCap || 5e6;
    function rec(used) {
      if (++nodes > nodeCap) return false;
      var t = trace(pz, pl, decided);
      if (t.solved) return true;
      if (used >= maxMirrors || t.firstFree < 0 || t.capped) return false;
      var i = t.firstFree;
      decided[i] = 1;
      if (rec(used)) return true;
      pl[i] = '/'; if (rec(used + 1)) return true;
      pl[i] = '\\'; if (rec(used + 1)) return true;
      pl[i] = '.'; decided[i] = 0;
      return false;
    }
    var found = rec(0);
    return { found: found, placements: found ? pl.join('') : null, nodes: nodes, capped: nodes > nodeCap };
  }
  function minMirrors(pz, upTo) {
    for (var k = 0; k <= upTo; k++) { var s = solve(pz, k); if (s.found) return { k: k, placements: s.placements }; }
    return null;
  }

  // ---------- stats and streaks (stored by the page under lightline.* keys) ----------
  function emptyStats() { return { v: 1, won: 0, streak: 0, best: 0, last: '', days: {} }; }
  function validStats(o) {
    if (!o || typeof o !== 'object' || o.v !== 1) return false;
    if (typeof o.won !== 'number' || typeof o.streak !== 'number' || typeof o.best !== 'number') return false;
    if (typeof o.last !== 'string' || !o.days || typeof o.days !== 'object') return false;
    return true;
  }
  // raw is what localStorage returned. null = nothing saved yet (fine). Anything unreadable is a failure, never "empty".
  function parseStats(raw) {
    if (raw === null || raw === undefined) return { ok: true, value: emptyStats(), fresh: true };
    var o;
    try { o = JSON.parse(raw); } catch (e) { return { ok: false, error: 'unreadable' }; }
    if (!validStats(o)) return { ok: false, error: 'unexpected shape' };
    return { ok: true, value: o, fresh: false };
  }
  function recordWin(stats, day, res) {
    var s = JSON.parse(JSON.stringify(stats));
    if (s.days[day]) return s; // already counted today
    s.won++;
    s.streak = s.last === shiftDay(day, -1) ? s.streak + 1 : 1;
    if (s.streak > s.best) s.best = s.streak;
    s.last = day;
    s.days[day] = { t: Math.round(res.ms || 0), m: res.moves | 0, u: res.mirrors | 0, b: res.budget | 0, l: res.level | 0 };
    return s;
  }
  function currentStreak(stats, today) {
    if (!stats || !stats.last) return 0;
    return stats.last === today || stats.last === shiftDay(today, -1) ? stats.streak : 0;
  }

  // ---------- history, XP and levels ----------
  /* One entry per finished puzzle (a win, or a puzzle whose answer was shown). Stats, streaks, XP and the player
     level are always worked out from this list and never kept as running totals, so merging two devices can never
     count a puzzle twice.
       id  'd:YYYY-MM-DD' for a daily, 'p:<seed>' for a practice puzzle
       k   'd' or 'p';  day (daily only);  l puzzle level 1..7;  at finish time in ms (0 if unknown)
       t ms taken, m moves, u mirrors used, b budget, h hints used (0..3), r 1 if the answer was shown */
  var XP = { Easy: 10, Medium: 20, Hard: 35, Expert: 50 };
  var UNLOCK = { 2: 1, 4: 3, 6: 6, 7: 10 }; // practice level -> player level needed
  var MAX_HINTS = 3;
  function validEntry(e) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !LEVELS[e.l]) return false;
    if (e.k === 'd') return typeof e.day === 'string' && !isNaN(parseDay(e.day)) && e.id === 'd:' + e.day;
    return e.k === 'p' && e.id.indexOf('p:') === 0;
  }
  function cleanEntry(e) {
    var o = { id: e.id, k: e.k, l: e.l, at: +e.at || 0, t: Math.max(0, Math.round(+e.t || 0)), m: e.m | 0, u: e.u | 0, b: e.b | 0,
      h: Math.max(0, Math.min(MAX_HINTS, e.h | 0)), r: e.r ? 1 : 0 };
    if (e.k === 'd') o.day = e.day;
    return o;
  }
  // the same puzzle finished on two devices: keep a real win over a shown answer, then fewer hints, then the earlier finish
  function better(a, b) {
    if (a.r !== b.r) return a.r ? b : a;
    if (a.h !== b.h) return a.h < b.h ? a : b;
    var ta = a.at || Infinity, tb = b.at || Infinity;
    if (ta !== tb) return ta < tb ? a : b;
    return a.t <= b.t ? a : b;
  }
  function mergeHistory() {
    var by = {}, ids = [];
    for (var x = 0; x < arguments.length; x++) {
      var list = arguments[x];
      if (!list || !list.length) continue;
      for (var i = 0; i < list.length; i++) {
        if (!validEntry(list[i])) continue;
        var e = cleanEntry(list[i]);
        if (by[e.id]) by[e.id] = better(by[e.id], e); else { by[e.id] = e; ids.push(e.id); }
      }
    }
    return ids.map(function (id) { return by[id]; }).sort(function (a, b) { return (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  }
  // older saves only have stats.days: turn them into history entries with the same ids a new save would use
  function historyFromStats(stats) {
    if (!stats || !stats.days) return [];
    return mergeHistory(Object.keys(stats.days).map(function (day) {
      var d = stats.days[day] || {};
      return { id: 'd:' + day, k: 'd', day: day, l: d.l || levelForDay(day), at: 0, t: d.t, m: d.m, u: d.u, b: d.b, h: d.h, r: 0 };
    }));
  }
  // the stats object the page has always kept, rebuilt from history: daily wins only (shown answers do not count)
  function statsFromHistory(hist) {
    var s = emptyStats(), wins = (hist || []).filter(function (e) { return e.k === 'd' && !e.r; });
    wins.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
    wins.forEach(function (e) {
      if (s.days[e.day]) return;
      s.won++;
      s.streak = s.last === shiftDay(e.day, -1) ? s.streak + 1 : 1;
      if (s.streak > s.best) s.best = s.streak;
      s.last = e.day;
      s.days[e.day] = { t: e.t, m: e.m, u: e.u, b: e.b, l: e.l, h: e.h };
    });
    return s;
  }
  function xpFor(e) {
    if (!e || e.r || !LEVELS[e.l]) return 0;
    var base = XP[LEVELS[e.l].name] || 0;
    return e.h > 0 ? Math.floor(base / 2) : base;
  }
  function totalXp(hist) { var n = 0; (hist || []).forEach(function (e) { n += xpFor(e); }); return n; }
  // XP needed to reach a level: each level costs 10 more than the one before (20, 30, 40...), so 3 = 50, 6 = 200, 10 = 540
  function xpToReach(lv) { return lv <= 1 ? 0 : 5 * (lv - 1) * (lv + 2); }
  function levelInfo(xp) {
    xp = Math.max(0, xp | 0);
    var lv = 1;
    while (xpToReach(lv + 1) <= xp) lv++;
    var base = xpToReach(lv), next = xpToReach(lv + 1);
    return { level: lv, xp: xp, base: base, next: next, into: xp - base, span: next - base, pct: (xp - base) / (next - base) };
  }
  function playerLevel(hist) { return levelInfo(totalXp(hist)).level; }
  function unlockLevel(practiceLevel) { return UNLOCK[practiceLevel] || 1; }
  function isUnlocked(practiceLevel, plv) { return plv >= unlockLevel(practiceLevel); }
  // the practice level to use: the one asked for if it is open, else the hardest open one below it, else Easy
  function practiceLevelFor(want, plv) {
    var opts = [2, 4, 6, 7], best = 2;
    opts.forEach(function (l) { if (l <= want && isUnlocked(l, plv)) best = l; });
    return best;
  }

  // ---------- cloud copy: {v, history, prefs:{level, at}} ----------
  // a backup that is there but cannot be understood is a failure, never "no backup"
  function parseProfile(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.history)) return { ok: false };
    var p = o.prefs && typeof o.prefs === 'object' && !Array.isArray(o.prefs) ? o.prefs : {};
    var prefs = { at: +p.at || 0 };
    if (UNLOCK[p.level]) prefs.level = p.level;
    return { ok: true, value: { v: 1, history: mergeHistory(o.history), prefs: prefs } };
  }
  // history is a union by id (so nothing is ever counted twice); settings: the newest change wins
  function mergeProfiles(local, cloud) {
    var lp = (local && local.prefs) || { at: 0 }, cp = (cloud && cloud.prefs) || { at: 0 };
    var prefs = (cp.at || 0) > (lp.at || 0) ? cp : lp;
    return { v: 1, history: mergeHistory(local && local.history, cloud && cloud.history), prefs: JSON.parse(JSON.stringify(prefs)) };
  }
  /* A read of the cloud document. 404 = there is no backup yet (fine). 200 = parse it. Anything else, or a body that
     cannot be read, is a failure: the caller must not write, or it could push an empty profile over a real one. */
  function readPullResponse(status, doc) {
    if (status === 404) return { ok: true, data: null };
    if (status !== 200) return { ok: false, data: null };
    var raw = doc && doc.fields && doc.fields.data && doc.fields.data.stringValue;
    if (typeof raw !== 'string') return { ok: true, data: null };
    var o;
    try { o = JSON.parse(raw); } catch (e) { return { ok: false, data: null }; }
    var p = parseProfile(o);
    return p.ok ? { ok: true, data: p.value } : { ok: false, data: null };
  }

  // ---------- share text (spoiler free: no positions, only the outcome) ----------
  var GEM = '\uD83D\uDC8E', MIRROR = '\uD83E\uDE9E', CLOCK = '\u23F1\uFE0F', TAP = '\uD83D\uDC46', FIRE = '\uD83D\uDD25', BULB = '\uD83D\uDCA1';
  var ON = '\uD83D\uDFE6', OFF = '\u2B1B';
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function prettyDay(k) {
    var t = parseDay(k); if (isNaN(t)) return k;
    var d = new Date(t);
    return WD[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function clock(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000)), m = Math.floor(s / 60);
    if (m >= 60) return Math.floor(m / 60) + ':' + pad(m % 60) + ':' + pad(s % 60);
    return m + ':' + pad(s % 60);
  }
  function shareText(r) {
    var lv = LEVELS[r.level] || LEVELS[1], bar = '';
    for (var i = 1; i <= 7; i++) bar += i <= r.level ? ON : OFF;
    var gems = '';
    for (i = 0; i < r.targets; i++) gems += GEM;
    var lines = [
      (r.practice ? 'Lightline practice' : 'Lightline ' + prettyDay(r.day)) + ' (' + lv.name + ')',
      bar,
      gems + ' all ' + r.targets + ' lit',
      MIRROR + ' ' + r.mirrors + '/' + r.budget + ' mirrors  ' + CLOCK + ' ' + clock(r.ms) + '  ' + TAP + ' ' + r.moves + (r.moves === 1 ? ' move' : ' moves')
    ];
    if (r.hints > 0) { var bulbs = ''; for (i = 0; i < r.hints; i++) bulbs += BULB; lines.push(bulbs + ' ' + r.hints + (r.hints === 1 ? ' hint' : ' hints')); }
    if (!r.practice && r.streak > 1) lines.push(FIRE + ' ' + r.streak + '-day streak');
    lines.push(r.url || 'mridulsaravanan.com/lightline/');
    return lines.join('\n');
  }

  var api = {
    SIZE: SIZE, CAP: CAP, LEVELS: LEVELS, DIRS: DIRS,
    fnv1a: fnv1a, mulberry32: mulberry32,
    dayKey: dayKey, shiftDay: shiftDay, weekday: weekday, levelForDay: levelForDay, prettyDay: prettyDay, clock: clock,
    trace: trace, countPlaced: countPlaced, isSolved: isSolved, cellAt: cellAt, emitterStart: emitterStart,
    // the page uses .solution only for hints and Show answer
    puzzleFor: function (seed, level) { return generate(seed, level).puzzle; },
    dailyPuzzle: function (day) { return daily(day).puzzle; },
    generate: generate, daily: daily, solve: solve, minMirrors: minMirrors, counters: counters,
    emptyStats: emptyStats, validStats: validStats, parseStats: parseStats, recordWin: recordWin, currentStreak: currentStreak,
    XP: XP, UNLOCK: UNLOCK, MAX_HINTS: MAX_HINTS,
    mergeHistory: mergeHistory, historyFromStats: historyFromStats, statsFromHistory: statsFromHistory,
    xpFor: xpFor, totalXp: totalXp, xpToReach: xpToReach, levelInfo: levelInfo, playerLevel: playerLevel,
    unlockLevel: unlockLevel, isUnlocked: isUnlocked, practiceLevelFor: practiceLevelFor,
    parseProfile: parseProfile, mergeProfiles: mergeProfiles, readPullResponse: readPullResponse,
    shareText: shareText,
    testing: {
      solution: function (day) { return daily(day).solution; },
      solutionFor: function (seed, level) { return generate(seed, level).solution; }
    }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Lightline = api;
})(this);
