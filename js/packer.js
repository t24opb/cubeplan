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

 Stacking strength: a product may carry a limit, `topLoad`, the most
 weight (kg) one carton can take on top of it. Weight is taken to spread
 evenly over what it stands on, so each free space on top of a block
 carries an allowance in kg per square centimetre that everything
 stacked there has to stay within. With `settings.heavyLow`, a carton
 with no limit of its own carries no more than it would at the bottom
 of a stack of its own kind as high as the container — so a layer of
 heavy cartons may top off a light stack, but a heavy stack never
 stands on light cartons.

 Weight balance: every container reports how its weight is shared
 between its two halves, lengthwise and across. With `settings.balance`,
 a container that is out of balance is rearranged (walls reordered and
 mirrored, or the same cartons loaded lower and further along).
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
      item.top = topLoad(p);
      item.dens = item.weight > 0 && item.vol > 0 ? item.weight / item.vol : 0;
      if (mode === 'topUp') { item.opt2 = b.hi - b.q; }
      if (mode === 'trim') { item.must = b.lo; item.opt1 = b.q - b.lo; }
      return item;
    });
  }

  /** The most weight (kg) one carton of a product may carry, or null for no limit. */
  function topLoad(p) {
    if (p.topLoad === null || p.topLoad === undefined || p.topLoad === '') return null;
    var kg = +p.topLoad;
    return kg >= 0 ? kg : null;
  }

  function cloneItems(items) {
    return items.map(function (i) {
      return { p: i.p, orients: i.orients, vol: i.vol, weight: i.weight, top: i.top, dens: i.dens, must: i.must, opt1: i.opt1, opt2: i.opt2 };
    });
  }

  /**
   A new, empty container. `heightLimit` (a fraction of the height)
   keeps the load low, to spread it along the floor. A free space
   carries `allow`: the weight per square centimetre that what it
   stands on can still take (the floor takes anything).
  */
  function openContainer(type, gap, heightLimit) {
    return {
      type: type,
      spaces: [{ x: 0, y: 0, z: 0, dx: type.length - gap, dy: type.width - gap, dz: (type.height - gap) * (heightLimit || 1),
                 allow: Infinity }],
      blocks: [], weight: 0, volume: 0, cartons: 0, counts: {},
      lean: 0, mid: (type.width - gap) / 2,   // the weight's moment to one side, about the middle
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
        // How high the stack may go: what its own bottom carton can
        // carry, and what the cartons under this space can still take.
        if (item.top !== null) mz = Math.min(mz, item.weight > 0 ? 1 + Math.floor(item.top / item.weight + EPS) : (item.top > 0 ? mz : 1));
        if (item.weight > 0 && space.allow < Infinity) mz = Math.min(mz, Math.floor(space.allow * o[0] * o[1] / item.weight + EPS));
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
        // Building for balance: mark down a block that leaves the load leaning to one side.
        if (v.wEven && item.weight > 0) {
          var kg = count * item.weight;
          score -= v.wEven * Math.abs(cont.lean + kg * (space.y + by / 2 - cont.mid)) / ((cont.weight + kg) * cont.mid);
        }
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
          kg: b.item.weight,
        });
        b.item[tier] -= b.count;
        cont.weight += b.count * b.item.weight;
        cont.lean += b.count * b.item.weight * (space.y + by / 2 - cont.mid);
        cont.volume += b.count * b.item.vol;
        cont.cartons += b.count;
        cont.counts[b.item.p.id] = (cont.counts[b.item.p.id] || 0) + b.count;
        // The corner in front of the gap beside the block goes either to
        // the space in front (the next wall gets the full width) or to
        // the space beside (a lane down the container for long cartons).
        var gapBeside = space.dy - by;
        var lane = v.rule === 1 || (v.rule === 2 && gapBeside >= v.minDim && gapBeside * 3 < space.dy);
        // What may still go on top of this block: the allowance of the
        // space less this block's own weight, and no more than its own
        // bottom cartons can carry on top of the layers above them.
        var area = b.o[0] * b.o[1], weight = b.item.weight;
        var allowTop = space.allow - b.nz * weight / area;
        if (b.item.top !== null) allowTop = Math.min(allowTop, (b.item.top - (b.nz - 1) * weight) / area);
        // "Heavy at the bottom": with no limit of its own, a carton
        // carries no more than it would at the bottom of a stack of its
        // own kind as high as the container.
        else if (v.heavyLow && b.item.dens > 0) allowTop = Math.min(allowTop, b.item.dens * cont.type.height - (b.nz - 1) * weight / area);
        var rest = [
          { x: space.x + bx, y: space.y, z: space.z, dx: space.dx - bx, dy: lane ? by : space.dy, dz: space.dz, allow: space.allow },
          { x: space.x, y: space.y + by, z: space.z, dx: lane ? space.dx : bx, dy: gapBeside, dz: space.dz, allow: space.allow },
          { x: space.x, y: space.y, z: space.z + bz, dx: bx, dy: by, dz: allowTop > 1e-9 ? space.dz - bz : 0, allow: allowTop },
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
  function variants(items, effort, heavyLow, even) {
    var maxVol = 0, maxDim = 0, minDim = Infinity;
    items.forEach(function (i) {
      maxVol = Math.max(maxVol, i.vol);
      maxDim = Math.max(maxDim, i.p.l, i.p.w, i.p.h);
      minDim = Math.min(minDim, i.p.l, i.p.w, i.p.h);
    });
    var out = [], random = randomSource(even ? 20261120 : 20261118);
    function add(base, rule, look, noise) {
      out.push({ wFill: base.wFill, wVol: base.wVol, wBlock: base.wBlock, wLong: base.wLong, wFlat: base.wFlat,
        wEven: even ? 0.2 + random() * 1.3 : 0,
        rule: rule, look: look, noise: noise, random: random, maxVol: maxVol, maxDim: maxDim, minDim: minDim, heavyLow: !!heavyLow });
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
    var best = null, all = [];
    variants(items, settings.effort === undefined ? 30 : settings.effort, settings.heavyLow).forEach(function (v) {
      var trial = cloneItems(items);
      var cont = openContainer(type, settings.gap || 0);
      fillTier(cont, trial, 'must', v);
      fillTier(cont, trial, 'opt1', v);
      var core = cont.volume;
      fillTier(cont, trial, 'opt2', v);
      var one = { cont: cont, items: trial, core: core };
      all.push(one);
      if (!best || core > best.core + EPS || (Math.abs(core - best.core) <= EPS && cont.volume > best.cont.volume + EPS)) best = one;
    });
    // Of the ways that load exactly the same cartons, one that can be
    // brought into balance.
    if (best && settings.balance) {
      var gap = settings.gap || 0;
      var near = all.filter(function (one) {
        if (one === best) return true;
        if (one.cont.cartons !== best.cont.cartons || Math.abs(one.core - best.core) > EPS) return false;
        return Object.keys(best.cont.counts).every(function (id) { return one.cont.counts[id] === best.cont.counts[id]; });
      });
      near.splice(near.indexOf(best), 1);
      near.unshift(best);
      for (var i = 0; i < near.length; i++) {
        var bal = balanceOf(near[i].cont, gap);
        if (!bal || bal.light) break;
        var blocks = near[i].cont.blocks;
        if (!comfortable(bal)) {
          blocks = arrange(near[i].cont, gap, false);
          if (!comfortable(balanceOf({ type: type, blocks: blocks }, gap))) {
            blocks = arrange(near[i].cont, gap, true);
            if (!comfortable(balanceOf({ type: type, blocks: blocks }, gap))) continue;
          }
        }
        near[i].cont.blocks = blocks;
        return near[i];
      }
    }
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

  // ---------- weight balance ----------

  /**
   No more than this share of the weight in either half of the length
   (the usual rule for packing containers: 60 / 40), and the same from
   side to side.
  */
  var HALF_LIMIT = 0.60, SIDE_LIMIT = 0.60;
  /** A load lighter than this share of the payload is too light for its balance to matter. */
  var LIGHT_LOAD = 0.10;

  /**
   How a container's weight is shared out. `front` is the share in the
   half at the closed end, `left` the share in the half the load is
   built from; x, y, z is the centre of gravity in cm. Null when no
   carton in it has a weight.
  */
  function balanceOf(cont, gap) {
    var half = cont.type.length / 2, mid = (cont.type.width - gap) / 2;
    var total = 0, front = 0, left = 0, mx = 0, my = 0, mz = 0, unweighed = 0;
    function share(from, to, cut) { return Math.max(0, Math.min(1, (cut - from) / (to - from))); }
    cont.blocks.forEach(function (b) {
      var kg = b.count * (b.kg || 0);
      if (!(kg > 0)) { unweighed += b.count; return; }
      var x1 = b.x + b.nx * b.a, y1 = b.y + b.ny * b.b, z1 = b.z + b.nz * b.c;
      total += kg;
      front += kg * share(b.x, x1, half);
      left += kg * share(b.y, y1, mid);
      mx += kg * (b.x + x1) / 2; my += kg * (b.y + y1) / 2; mz += kg * (b.z + z1) / 2;
    });
    if (!(total > 0)) return null;
    var f = front / total, l = left / total;
    var lengthOk = Math.max(f, 1 - f) <= HALF_LIMIT + 1e-9, sideOk = Math.max(l, 1 - l) <= SIDE_LIMIT + 1e-9;
    return {
      front: f, left: l, x: mx / total, y: my / total, z: mz / total, weight: total, unweighed: unweighed,
      lengthOk: lengthOk, sideOk: sideOk,
      // Too little weight to matter to whoever lifts or carries it.
      light: cont.type.payload > 0 && total < cont.type.payload * LIGHT_LOAD,
      ok: lengthOk && sideOk,
    };
  }

  /** How far out of balance, as one number: 0 is even both ways. */
  function imbalance(bal) {
    return Math.abs(bal.front - 0.5) + Math.abs(bal.left - 0.5) * 0.5;
  }
  function comfortable(bal) {
    return Math.max(bal.front, 1 - bal.front) <= HALF_LIMIT - 0.03 && Math.max(bal.left, 1 - bal.left) <= SIDE_LIMIT - 0.02;
  }

  function copyBlock(b) {
    var copy = {};
    Object.keys(b).forEach(function (key) { copy[key] = b[key]; });
    return copy;
  }

  /** A wall: a slice across the container that no block crosses. */
  function wallOf(blocks, mid) {
    var w = { blocks: blocks, x0: Infinity, x1: 0, lo: Infinity, hi: 0, kg: 0, mx: 0, my: 0 };
    blocks.forEach(function (b) {
      w.x0 = Math.min(w.x0, b.x); w.x1 = Math.max(w.x1, b.x + b.nx * b.a);
      w.lo = Math.min(w.lo, b.y); w.hi = Math.max(w.hi, b.y + b.ny * b.b);
    });
    blocks.forEach(function (b) {
      var kg = b.count * (b.kg || 0);
      w.kg += kg;
      w.mx += kg * (b.x + b.nx * b.a / 2 - w.x0);
      w.my += kg * (b.y + b.ny * b.b / 2 - mid);
    });
    w.len = w.x1 - w.x0;
    return w;
  }

  /**
   Cuts a wall in two across the container, between cartons, where the
   two parts lean to the side by the same amount — so that mirroring
   one of them evens the wall out. Returns the wall itself when there
   is nowhere to cut.
  */
  function splitWall(w, mid) {
    var seen = {}, best = null;
    w.blocks.forEach(function (b) {
      for (var i = 0; i <= b.nx; i++) {
        var cut = b.x + i * b.a, key = cut.toFixed(2);
        if (seen[key] || cut < w.x0 + 1 || cut > w.x1 - 1) continue;
        seen[key] = true;
        var before = 0, clean = true;
        for (var k = 0; k < w.blocks.length && clean; k++) {
          var o = w.blocks[k], rows = (cut - o.x) / o.a;
          if (rows <= 1e-6) continue;
          if (rows < o.nx - 1e-6) {
            if (Math.abs(rows - Math.round(rows)) > 1e-6) { clean = false; break; }
            rows = Math.round(rows);
          } else rows = o.nx;
          before += rows * o.ny * o.nz * (o.kg || 0) * (o.y + o.ny * o.b / 2 - mid);
        }
        if (!clean) continue;
        var uneven = Math.abs(2 * before - w.my);
        if (!best || uneven < best.uneven) best = { cut: cut, uneven: uneven };
      }
    });
    if (!best) return [w];
    var first = [], second = [];
    w.blocks.forEach(function (b) {
      var rows = Math.round((best.cut - b.x) / b.a);
      if (best.cut <= b.x + 1e-6) second.push(b);
      else if (rows >= b.nx) first.push(b);
      else {
        var near = copyBlock(b), far = copyBlock(b);
        near.nx = rows; near.count = rows * b.ny * b.nz;
        far.nx = b.nx - rows; far.count = far.nx * b.ny * b.nz; far.x = best.cut;
        first.push(near); second.push(far);
      }
    });
    return [wallOf(first, mid), wallOf(second, mid)];
  }

  /**
   The same cartons, better balanced. The load is taken as the walls it
   was built in, the walls are put in the order that brings the centre
   of gravity nearest the middle of the container's length, and each
   wall is mirrored, or moved across into the gap beside it, so that
   the weight evens out from side to side. With `split`, a wall that
   still leans is cut in two and one part mirrored. Nothing changes
   inside a wall, so everything still stands on what it stood on.
  */
  function arrange(cont, gap, split) {
    var half = cont.type.length / 2, across = cont.type.width - gap, mid = across / 2;
    var sorted = cont.blocks.slice().sort(function (a, b) { return a.x - b.x; });
    var groups = [], end = 0;
    sorted.forEach(function (b) {
      if (groups.length && b.x < end - 1e-6) groups[groups.length - 1].push(b);
      else groups.push([b]);
      end = Math.max(groups.length > 1 || end ? end : 0, b.x + b.nx * b.a);
    });
    var order = groups.map(function (blocks) { return wallOf(blocks, mid); });
    var total = order.reduce(function (sum, w) { return sum + w.kg; }, 0);
    if (!(total > 0)) return cont.blocks;

    // Lengthwise: swap walls for as long as it brings the centre of
    // gravity nearer the middle, and no longer than needed.
    function offCentre(list) {
      var at = 0, moment = 0;
      for (var i = 0; i < list.length; i++) { moment += list[i].kg * at + list[i].mx; at += list[i].len; }
      return Math.abs(moment / total - half);
    }
    var best = offCentre(order), near = cont.type.length * 0.02;
    for (var pass = 0; pass < 8 && best > near; pass++) {
      var improved = false;
      for (var i = 0; i < order.length && best > near; i++) {
        for (var j = i + 1; j < order.length && best > near; j++) {
          var swap = order[i]; order[i] = order[j]; order[j] = swap;
          var cost = offCentre(order);
          if (cost < best - 1e-6) { best = cost; improved = true; }
          else { order[j] = order[i]; order[i] = swap; }
        }
      }
      if (!improved) break;
    }

    // Side to side. A wall can be centred on its own weight when the
    // gap beside it is wide enough, as it stands or mirrored.
    function fits(w, flip) {
      var off = flip ? -w.my / w.kg : w.my / w.kg, lo = flip ? w.hi - across : -w.lo, hi = flip ? w.lo : across - w.hi;
      return off + lo <= 1e-9 && off + hi >= -1e-9;
    }
    function place(w, flip, offset) {
      // Puts the wall's centre of gravity `offset` from the middle, or as near as it goes.
      var off = flip ? -w.my / w.kg : w.my / w.kg, lo = flip ? w.hi - across : -w.lo, hi = flip ? w.lo : across - w.hi;
      w.flip = flip;
      w.shift = Math.max(lo, Math.min(hi, offset - off));
      return (off + w.shift) * w.kg;
    }
    if (split) {
      var parts = [];
      order.forEach(function (w) {
        if (w.kg > 0 && !fits(w, false) && !fits(w, true)) parts.push.apply(parts, splitWall(w, mid));
        else parts.push(w);
      });
      order = parts;
    }
    var lean = 0, free = [], stiff = [];
    order.forEach(function (w) {
      w.flip = false; w.shift = 0;
      if (!(w.kg > 0)) return;
      if (fits(w, false)) { place(w, false, 0); free.push(w); }
      else if (fits(w, true)) { place(w, true, 0); free.push(w); }
      else stiff.push(w);
    });
    // The walls that cannot be centred are turned against each other,
    // the one that leans most first; the others take up what is left.
    stiff.map(function (w) { return { w: w, lean: Math.abs(place(w, false, 0)) }; })
      .sort(function (a, b) { return b.lean - a.lean; })
      .forEach(function (r) {
        var plain = place(r.w, false, 0), mirrored = place(r.w, true, 0);
        if (Math.abs(lean + plain) <= Math.abs(lean + mirrored)) lean += place(r.w, false, 0);
        else lean += mirrored;
      });
    free.forEach(function (w) {
      if (Math.abs(lean) > 1e-6) lean += place(w, w.flip, -lean / w.kg);
    });

    var out = [], at = 0;
    order.forEach(function (w) {
      w.blocks.forEach(function (b) {
        var copy = copyBlock(b);
        copy.x = at + (b.x - w.x0);
        copy.y = (w.flip ? across - (b.y + b.ny * b.b) : b.y) + w.shift;
        out.push(copy);
      });
      at += w.len;
    });
    return loadingOrder(out);
  }

  /**
   Brings a container that is out of balance back in: first by
   rearranging its walls, and if that is not enough (a part load built
   to the roof at the closed end) by loading the same cartons lower, so
   that they reach further along the floor.
  */
  function rebalance(cont, items, settings) {
    var gap = settings.gap || 0;
    var now = balanceOf(cont, gap);
    if (!now || now.light || comfortable(now)) return;
    var best = { blocks: cont.blocks, bal: now };
    function consider(blocks) {
      var bal = balanceOf({ type: cont.type, blocks: blocks }, gap);
      if (imbalance(bal) < imbalance(best.bal) - 1e-9) best = { blocks: blocks, bal: bal };
      return comfortable(bal);
    }
    function settle(c) {
      return consider(arrange(c, gap, false)) || consider(arrange(c, gap, true));
    }
    if (!settle(cont)) {
      // The same cartons, tier by tier, and nothing else.
      var wanted = {};
      cont.blocks.forEach(function (b) {
        wanted[b.id] = wanted[b.id] || { must: 0, opt1: 0, opt2: 0 };
        wanted[b.id][b.tier] += b.count;
      });
      var load = cloneItems(items.filter(function (i) { return wanted[i.p.id]; }));
      load.forEach(function (i) { var w = wanted[i.p.id]; i.must = w.must; i.opt1 = w.opt1; i.opt2 = w.opt2; });
      var effort = settings.effort === undefined ? 30 : settings.effort;
      // The usual ways of building it, then ways that build for balance.
      var ways = variants(load, effort, settings.heavyLow).concat(variants(load, effort * 3, settings.heavyLow, true));
      // First at full height (another way of building it may balance), then lower.
      var limits = [1, 0.85, 0.72, 0.6, 0.5, 0.4, 0.32, 0.25, 0.18];
      search:
      for (var h = 0; h < limits.length; h++) {
        // Lower down, the usual ways are enough.
        for (var k = 0; k < (h ? ways.length - effort * 3 - 15 : ways.length); k++) {
          var trial = cloneItems(load), lower = openContainer(cont.type, gap, limits[h]);
          fillTier(lower, trial, 'must', ways[k]);
          fillTier(lower, trial, 'opt1', ways[k]);
          fillTier(lower, trial, 'opt2', ways[k]);
          if (remaining(trial, ['must', 'opt1', 'opt2']) > 0) continue;
          if (settle(lower)) break search;
        }
      }
    }
    cont.blocks = best.blocks;
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
    if (settings.balance) containers.forEach(function (c) { rebalance(c, items, settings); });
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
      c.balance = balanceOf(c, settings.gap || 0);
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
      var trial = { kpi: settings.kpi, gap: settings.gap, maxChange: pct, effort: settings.effort, heavyLow: settings.heavyLow };
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
    // Only the count matters here, so the load is not rearranged.
    settings = { kpi: settings.kpi, gap: settings.gap, maxChange: settings.maxChange, effort: settings.effort, heavyLow: settings.heavyLow };
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

  /**
   How many cartons of a product make one row: wall to wall and floor to
   roof, one carton deep, in the roomiest container allowed. This is the
   "Row" step for changing quantities, as in the iPhone app.
  */
  function rowSize(product, types, settings) {
    var gap = settings.gap || 0, best = 0;
    types.filter(function (t) { return t.enabled !== false && t.length > 0 && t.width > 0 && t.height > 0; }).forEach(function (t) {
      orientations(product).forEach(function (o) {
        if (o[0] > t.length - gap + EPS) return;
        var across = Math.floor((t.width - gap + EPS) / o[1]), high = Math.floor((t.height - gap + EPS) / o[2]);
        best = Math.max(best, across * high);
      });
    });
    return Math.max(1, best);
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
    changeNeeded: changeNeeded, cartons: cartons, typeVolume: typeVolume, roomFor: roomFor, rowSize: rowSize,
    balanceOf: balanceOf, HALF_LIMIT: HALF_LIMIT, SIDE_LIMIT: SIDE_LIMIT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SPPacker = api;
})(typeof window !== 'undefined' ? window : globalThis);
