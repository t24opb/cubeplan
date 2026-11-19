/*
 CubePlanner — packing and optimising.

 Pure logic, no page or 3D code, so it runs the same in a browser and in
 Node (see tests/packer.test.js).

 Units: centimetres and kilograms. Inside a container, x runs along the
 length from the far (closed) end towards the doors, y runs across the
 width, z is up.

 How a container is filled: cartons go in as blocks of one product
 (nx × ny × nz cartons, all turned the same way), built like walls from
 the far end. Each block is put in the corner of a free space and the
 space left over is cut into three: the space in front, the space beside
 and the space on top. A block therefore always stands on the floor or
 wholly on the block beneath it — nothing overhangs.
*/
(function (root) {
  'use strict';

  var EPS = 1e-6;

  /** The ways a carton may be turned: [along the length, across, up]. */
  function orientations(p) {
    var l = p.l, w = p.w, h = p.h;
    var all = p.tippable
      ? [[l, w, h], [w, l, h], [l, h, w], [h, l, w], [w, h, l], [h, w, l]]
      : [[l, w, h], [w, l, h]];
    var seen = {}, out = [];
    all.forEach(function (o) {
      var key = o.join('x');
      if (!seen[key]) { seen[key] = true; out.push(o); }
    });
    return out;
  }

  function typeVolume(t) { return t.length * t.width * t.height; }

  /** The lowest and highest quantity a product may be planned at. */
  function bounds(p, settings) {
    var q = Math.max(0, Math.round(p.qty || 0));
    if (p.locked) return { q: q, lo: q, hi: q, pct: 0 };
    var pct = (p.maxChange === null || p.maxChange === undefined || p.maxChange === '')
      ? settings.maxChange : +p.maxChange;
    pct = Math.max(0, pct || 0);
    var lo = Math.max(0, Math.ceil(q * (1 - pct / 100) - EPS));
    var hi = Math.floor(q * (1 + pct / 100) + EPS);
    return { q: q, lo: lo, hi: hi, pct: pct };
  }

  function makeItems(products, settings, mode) {
    return products.filter(function (p) {
      return p.l > 0 && p.w > 0 && p.h > 0;
    }).map(function (p) {
      var b = bounds(p, settings);
      var item = {
        p: p, orients: orientations(p), vol: p.l * p.w * p.h,
        weight: Math.max(0, +p.weight || 0),
        must: b.q, opt1: 0, opt2: 0,
      };
      if (mode === 'topUp') { item.opt2 = b.hi - b.q; }
      if (mode === 'trim') { item.must = b.lo; item.opt1 = b.q - b.lo; }
      return item;
    });
  }

  function cloneItems(items) {
    return items.map(function (i) {
      return { p: i.p, orients: i.orients, vol: i.vol, weight: i.weight, must: i.must, opt1: i.opt1, opt2: i.opt2 };
    });
  }

  function openContainer(type, gap) {
    return {
      type: type,
      spaces: [{ x: 0, y: 0, z: 0, dx: type.length - gap, dy: type.width - gap, dz: type.height - gap }],
      blocks: [], weight: 0, volume: 0, cartons: 0, counts: {},
    };
  }

  /**
   How much of a gap `gapY` wide and `gapZ` high (and `reach` long) the
   best-fitting carton still to load would cover, as an area.
  */
  function gapCover(items, gapY, gapZ, reach) {
    var best = 0;
    if (gapY <= 1 || gapZ <= 1) return 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.must + item.opt1 + item.opt2 <= 0) continue;
      for (var k = 0; k < item.orients.length; k++) {
        var o = item.orients[k];
        if (o[0] > reach + EPS || o[1] > gapY + EPS || o[2] > gapZ + EPS) continue;
        var cover = Math.floor((gapY + EPS) / o[1]) * o[1] * Math.floor((gapZ + EPS) / o[2]) * o[2];
        if (cover > best) best = cover;
      }
    }
    return best;
  }

  /** The best block of one tier's cartons for a free space, or null. */
  function bestBlock(space, items, tier, cont, v) {
    var best = null;
    var payload = cont.type.payload > 0 ? cont.type.payload : Infinity;
    var faceArea = space.dy * space.dz, spaceVol = faceArea * space.dx;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var n = item[tier];
      if (n <= 0) continue;
      if (item.weight > 0) n = Math.min(n, Math.floor((payload - cont.weight + EPS) / item.weight));
      if (n <= 0) continue;
      for (var k = 0; k < item.orients.length; k++) {
        var o = item.orients[k];
        var mx = Math.floor((space.dx + EPS) / o[0]);
        var my = Math.floor((space.dy + EPS) / o[1]);
        var mz = Math.floor((space.dz + EPS) / o[2]);
        if (!mx || !my || !mz) continue;
        var nx, ny, nz, face = my * mz;
        if (n >= face) { nx = Math.min(mx, Math.floor(n / face)); ny = my; nz = mz; }
        else if (n >= my) { nx = 1; ny = my; nz = Math.floor(n / my); }
        else { nx = 1; ny = n; nz = 1; }
        var by = ny * o[1], bz = nz * o[2], bx = nx * o[0];
        var covered = by * bz;
        if (v.look) {
          // What the gaps beside and above this block could still take.
          covered += gapCover(items, space.dy - by, space.dz, v.rule === 1 ? space.dx : bx);
          covered += gapCover(items, by, space.dz - bz, bx);
        }
        var count = nx * ny * nz;
        var score = v.wFill * (covered / faceArea)
          + v.wVol * (item.vol / v.maxVol)
          + v.wBlock * (count * item.vol / spaceVol)
          + v.wLong * (Math.max(o[0], o[1], o[2]) / v.maxDim)
          + v.wFlat * (o[2] <= o[0] && o[2] <= o[1] ? 1 : 0);
        if (v.noise) score *= 1 + v.noise * (v.random() - 0.5);
        if (!best || score > best.score) {
          best = { score: score, item: item, o: o, nx: nx, ny: ny, nz: nz, count: count };
        }
      }
    }
    return best;
  }

  function fillTier(cont, items, tier, v) {
    for (;;) {
      cont.spaces.sort(function (a, b) { return (a.x - b.x) || (a.z - b.z) || (a.y - b.y); });
      var placed = false;
      for (var s = 0; s < cont.spaces.length; s++) {
        var space = cont.spaces[s];
        var b = bestBlock(space, items, tier, cont, v);
        if (!b) continue;
        var bx = b.nx * b.o[0], by = b.ny * b.o[1], bz = b.nz * b.o[2];
        cont.blocks.push({
          id: b.item.p.id, tier: tier, x: space.x, y: space.y, z: space.z,
          a: b.o[0], b: b.o[1], c: b.o[2], nx: b.nx, ny: b.ny, nz: b.nz, count: b.count,
        });
        b.item[tier] -= b.count;
        cont.weight += b.count * b.item.weight;
        cont.volume += b.count * b.item.vol;
        cont.cartons += b.count;
        cont.counts[b.item.p.id] = (cont.counts[b.item.p.id] || 0) + b.count;
        // The corner in front of the gap beside the block goes either to
        // the space in front (the next wall gets the full width) or to
        // the space beside (a lane down the container for long cartons).
        var gapBeside = space.dy - by;
        var lane = v.rule === 1 || (v.rule === 2 && gapBeside >= v.minDim && gapBeside * 3 < space.dy);
        var rest = [
          { x: space.x + bx, y: space.y, z: space.z, dx: space.dx - bx, dy: lane ? by : space.dy, dz: space.dz },
          { x: space.x, y: space.y + by, z: space.z, dx: lane ? space.dx : bx, dy: gapBeside, dz: space.dz },
          { x: space.x, y: space.y, z: space.z + bz, dx: bx, dy: by, dz: space.dz - bz },
        ].filter(function (r) { return r.dx > 1 && r.dy > 1 && r.dz > 1; });
        cont.spaces.splice.apply(cont.spaces, [s, 1].concat(rest));
        placed = true;
        break;
      }
      if (!placed) return;
    }
  }

  /** A small repeatable random-number source, so a plan never changes between runs. */
  function randomSource(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var BASES = [
    { wFill: 1, wVol: 0.05, wBlock: 0, wLong: 0, wFlat: 0 },
    { wFill: 0.2, wVol: 1, wBlock: 0, wLong: 0, wFlat: 0 },
    { wFill: 1, wVol: 0, wBlock: 0.3, wLong: 0, wFlat: 0 },
    { wFill: 0.6, wVol: 0, wBlock: 0, wLong: 0.6, wFlat: 0 },
    { wFill: 1, wVol: 0.1, wBlock: 0, wLong: 0, wFlat: 0.15 },
  ];

  /** The different ways of choosing blocks that are tried for each container. */
  function variants(items, effort) {
    var maxVol = 0, maxDim = 0, minDim = Infinity;
    items.forEach(function (i) {
      maxVol = Math.max(maxVol, i.vol);
      maxDim = Math.max(maxDim, i.p.l, i.p.w, i.p.h);
      minDim = Math.min(minDim, i.p.l, i.p.w, i.p.h);
    });
    var out = [], random = randomSource(20261118);
    function add(base, rule, look, noise) {
      out.push({ wFill: base.wFill, wVol: base.wVol, wBlock: base.wBlock, wLong: base.wLong, wFlat: base.wFlat,
        rule: rule, look: look, noise: noise, random: random, maxVol: maxVol, maxDim: maxDim, minDim: minDim });
    }
    BASES.forEach(function (base) {
      [0, 1, 2].forEach(function (rule) { add(base, rule, true, 0); add(base, rule, false, 0); });
    });
    for (var i = 0; i < effort; i++) {
      var base = BASES[i % BASES.length];
      add({ wFill: base.wFill * (0.6 + random() * 0.8), wVol: base.wVol + random() * 0.3, wBlock: base.wBlock + random() * 0.3,
            wLong: base.wLong + random() * 0.3, wFlat: random() * 0.3 }, i % 3, random() < 0.8, 0.1 + random() * 0.3);
    }
    return out;
  }

  /** Fills one new container of `type`; returns it with what is left. */
  function fillOne(type, items, settings) {
    var best = null;
    variants(items, settings.effort === undefined ? 30 : settings.effort).forEach(function (v) {
      var trial = cloneItems(items);
      var cont = openContainer(type, settings.gap || 0);
      fillTier(cont, trial, 'must', v);
      fillTier(cont, trial, 'opt1', v);
      var core = cont.volume;
      fillTier(cont, trial, 'opt2', v);
      if (!best || core > best.core + EPS || (Math.abs(core - best.core) <= EPS && cont.volume > best.cont.volume + EPS)) {
        best = { cont: cont, items: trial, core: core };
      }
    });
    return best;
  }

  function remaining(items, tiers) {
    return items.reduce(function (sum, i) {
      return sum + tiers.reduce(function (s, t) { return s + i[t]; }, 0);
    }, 0);
  }

  /**
   Opens the next container: the smallest type that takes everything
   still to load, otherwise the type that is cheapest per cubic metre
   loaded (or simply holds the most, when costs are not all given).
  */
  function openNext(items, types, settings) {
    var trials = types.map(function (type) {
      var t = fillOne(type, items, settings);
      t.type = type;
      t.finishes = remaining(t.items, ['must', 'opt1']) === 0;
      return t;
    }).filter(function (t) { return t.cont.blocks.length > 0; });
    if (!trials.length) return null;
    var costed = types.every(function (t) { return t.cost > 0; });
    var finishers = trials.filter(function (t) { return t.finishes; });
    if (finishers.length) {
      finishers.sort(function (a, b) {
        return costed ? (a.type.cost - b.type.cost) || (typeVolume(a.type) - typeVolume(b.type))
                      : typeVolume(a.type) - typeVolume(b.type);
      });
      return finishers[0];
    }
    trials.sort(function (a, b) {
      if (costed) return (a.type.cost / a.core) - (b.type.cost / b.core);
      return b.core - a.core;
    });
    return trials[0];
  }

  /** Blocks in the order they would be loaded: far end first, bottom up. */
  function loadingOrder(blocks) {
    return blocks.slice().sort(function (a, b) { return (a.x - b.x) || (a.z - b.z) || (a.y - b.y); });
  }

  /**
   One plan. mode: 'asOrdered' (exact quantities), 'topUp' (ordered
   quantities, then extra cartons in the gaps, up to each product's
   limit), 'trim' (at most `limit` containers; quantities cut no further
   than each product's limit, then put back as far as they fit).
  */
  function plan(products, types, settings, mode, limit) {
    var items = makeItems(products, settings, mode);
    var containers = [];
    types = types.filter(function (t) { return t.enabled !== false; });
    limit = limit || Infinity;
    for (;;) {
      var must = remaining(items, ['must']);
      var opt1 = remaining(items, ['opt1']);
      if (must === 0 && opt1 === 0) break;
      if (containers.length >= limit) break;
      var next = openNext(items, types, settings);
      if (!next) break;
      items = next.items;
      next.cont.blocks = loadingOrder(next.cont.blocks);
      delete next.cont.spaces;
      containers.push(next.cont);
      if (containers.length > 400) break;
    }
    return summarise(products, items, containers, settings, mode);
  }

  function summarise(products, items, containers, settings, mode) {
    var planned = {}, lines = [];
    containers.forEach(function (c) {
      c.capacity = typeVolume(c.type);
      c.fill = c.capacity > 0 ? c.volume / c.capacity : 0;
      c.weightFill = c.type.payload > 0 ? c.weight / c.type.payload : 0;
      // A container at its weight limit is full, however much air is left.
      c.use = Math.max(c.fill, c.weightFill);
      Object.keys(c.counts).forEach(function (id) { planned[id] = (planned[id] || 0) + c.counts[id]; });
    });
    var orderedVol = 0, plannedVol = 0, orderedCartons = 0, plannedCartons = 0, changed = 0, short = false;
    var notLoaded = [];
    products.forEach(function (p) {
      var item = items.filter(function (i) { return i.p === p; })[0];
      var q = Math.max(0, Math.round(p.qty || 0));
      var n = planned[p.id] || 0;
      var vol = p.l * p.w * p.h;
      orderedVol += q * vol; plannedVol += n * vol;
      orderedCartons += q; plannedCartons += n;
      if (n !== q) changed++;
      if (item && item.must > 0) { short = true; notLoaded.push({ id: p.id, count: item.must }); }
      lines.push({ id: p.id, ordered: q, planned: n, change: n - q });
    });
    var fills = containers.map(function (c) { return c.use; });
    var minFill = fills.length ? Math.min.apply(null, fills) : 0;
    var cost = containers.reduce(function (s, c) { return s + (c.type.cost > 0 ? c.type.cost : 0); }, 0);
    return {
      mode: mode,
      containers: containers,
      lines: lines,
      planned: planned,
      feasible: !short,
      notLoaded: notLoaded,
      minFill: minFill,
      avgFill: fills.length ? containers.reduce(function (s, c) { return s + c.volume; }, 0) /
                              containers.reduce(function (s, c) { return s + c.capacity; }, 0) : 0,
      meetsKpi: !short && fills.length > 0 && minFill * 100 >= settings.kpi - 1e-9,
      orderedVolume: orderedVol, plannedVolume: plannedVol,
      orderedCartons: orderedCartons, plannedCartons: plannedCartons,
      changeFraction: orderedVol > 0 ? (plannedVol - orderedVol) / orderedVol : 0,
      productsChanged: changed,
      cost: cost,
    };
  }

  /**
   The three options side by side, and which one to recommend: of the
   options that keep every container at or above the minimum fill, the
   one that changes the order least.
  */
  function optimise(products, types, settings) {
    var live = products.filter(function (p) { return p.qty > 0 && p.l > 0 && p.w > 0 && p.h > 0; });
    var usable = types.filter(function (t) { return t.enabled !== false && t.length > 0 && t.width > 0 && t.height > 0; });
    var empty = { asOrdered: null, topUp: null, trim: null, recommended: null, oversize: [] };
    if (!live.length || !usable.length) return empty;

    var gap = settings.gap || 0;
    var oversize = live.filter(function (p) {
      return !usable.some(function (t) {
        return orientations(p).some(function (o) {
          return o[0] <= t.length - gap + EPS && o[1] <= t.width - gap + EPS && o[2] <= t.height - gap + EPS;
        });
      });
    });
    var fits = live.filter(function (p) { return oversize.indexOf(p) < 0; });
    if (!fits.length) { empty.oversize = oversize; return empty; }

    var asOrdered = plan(fits, usable, settings, 'asOrdered');
    var n = asOrdered.containers.length;
    var topUp = plan(fits, usable, settings, 'topUp', n);
    var trim = n > 1 ? plan(fits, usable, settings, 'trim', n - 1) : null;
    if (trim && !trim.feasible) trim = { mode: 'trim', feasible: false, containers: [], lines: [], meetsKpi: false, limit: n - 1 };

    var options = [asOrdered, topUp, trim].filter(function (o) { return o && o.feasible; });
    var passing = options.filter(function (o) { return o.meetsKpi; });
    var recommended;
    if (passing.length) {
      passing.sort(function (a, b) { return Math.abs(a.changeFraction) - Math.abs(b.changeFraction); });
      recommended = passing[0].mode;
    } else {
      options.sort(function (a, b) { return b.minFill - a.minFill; });
      recommended = options[0].mode;
    }
    return { asOrdered: asOrdered, topUp: topUp, trim: trim, recommended: recommended, anyPass: passing.length > 0, oversize: oversize };
  }

  /**
   The smallest general "max change" (whole per cent, up to `ceiling`)
   at which some option keeps every container at the minimum fill.
   Products with their own limit keep it. Null when none does.
  */
  function changeNeeded(products, types, settings, ceiling) {
    for (var pct = Math.floor(settings.maxChange) + 1; pct <= (ceiling || 30); pct++) {
      var trial = { kpi: settings.kpi, gap: settings.gap, maxChange: pct, effort: settings.effort };
      var result = optimise(products, types, trial);
      if (result.anyPass) return pct;
    }
    return null;
  }

  /**
   How many cartons of `candidate` can be added to the order without
   needing another container. `candidate` may already be in the order
   (matched by id), in which case the answer is how many MORE fit.
   When the containers planned are already full, the answer is how
   many would fill one more (`opensNew`).
  */
  function roomFor(products, types, settings, candidate) {
    var usable = types.filter(function (t) { return t.enabled !== false && t.length > 0 && t.width > 0 && t.height > 0; });
    var vol = candidate.l * candidate.w * candidate.h;
    if (!usable.length || !(vol > 0)) return { count: 0, opensNew: false, containers: 0, tooBig: false };
    var gap = settings.gap || 0;
    var fitsSomewhere = usable.some(function (t) {
      return orientations(candidate).some(function (o) {
        return o[0] <= t.length - gap + EPS && o[1] <= t.width - gap + EPS && o[2] <= t.height - gap + EPS;
      });
    });
    var live = products.filter(function (p) { return p.qty > 0 && p.l > 0 && p.w > 0 && p.h > 0; });
    var others = live.filter(function (p) { return p.id !== candidate.id; });
    var existing = live.filter(function (p) { return p.id === candidate.id; })[0];
    var baseQty = existing ? existing.qty : 0;
    function withExtra(n) {
      if (baseQty + n <= 0) return others;
      var line = {};
      Object.keys(candidate).forEach(function (key) { line[key] = candidate[key]; });
      line.qty = baseQty + n;
      return others.concat([line]);
    }
    var base = withExtra(0).length ? plan(withExtra(0), usable, settings, 'asOrdered') : { containers: [] };
    var planned = base.containers.length;
    if (!fitsSomewhere) return { count: 0, opensNew: false, containers: planned, tooBig: true };
    var biggest = Math.max.apply(null, usable.map(typeVolume));
    var orderedVolume = withExtra(0).reduce(function (sum, p) { return sum + p.qty * p.l * p.w * p.h; }, 0);
    function most(limit) {
      var hi = Math.min(50000, Math.floor((limit * biggest - orderedVolume) / vol));
      if (hi <= 0) return 0;
      function fits(n) {
        var trial = plan(withExtra(n), usable, settings, 'asOrdered');
        return trial.feasible && trial.containers.length <= limit;
      }
      if (fits(hi)) return hi;
      var lo = 0;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      return lo;
    }
    var count = most(Math.max(1, planned));
    var opensNew = false;
    if (count === 0 && planned >= 1) {
      count = most(planned + 1);
      opensNew = true;
    }
    return { count: count, opensNew: opensNew, containers: planned, tooBig: false };
  }

  /** Every carton of a container, in loading order, for drawing. */
  function cartons(container) {
    var out = [];
    container.blocks.forEach(function (b, index) {
      for (var ix = 0; ix < b.nx; ix++) {
        for (var iz = 0; iz < b.nz; iz++) {
          for (var iy = 0; iy < b.ny; iy++) {
            out.push({ id: b.id, block: index, tier: b.tier,
              x: b.x + ix * b.a, y: b.y + iy * b.b, z: b.z + iz * b.c, a: b.a, b: b.b, c: b.c });
          }
        }
      }
    });
    return out;
  }

  var api = {
    orientations: orientations, bounds: bounds, plan: plan, optimise: optimise,
    changeNeeded: changeNeeded, cartons: cartons, typeVolume: typeVolume, roomFor: roomFor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SPPacker = api;
})(typeof window !== 'undefined' ? window : globalThis);
