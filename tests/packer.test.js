// Run with: node website/tests/packer.test.js
'use strict';
const assert = require('assert');
const P = require('../js/packer.js');
const D = require('../js/data.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

/** No carton outside the container, none overlapping, none in mid-air. */
function checkContainer(c, gap) {
  const boxes = P.cartons(c);
  const L = c.type.length - gap, W = c.type.width - gap, H = c.type.height - gap;
  for (const b of boxes) {
    assert(b.x >= -1e-6 && b.y >= -1e-6 && b.z >= -1e-6, 'carton below zero');
    assert(b.x + b.a <= L + 1e-6 && b.y + b.b <= W + 1e-6 && b.z + b.c <= H + 1e-6, 'carton outside the container');
  }
  // Overlap and support, checked block against block (blocks are solid).
  const blocks = c.blocks.map(b => ({ x0: b.x, y0: b.y, z0: b.z, x1: b.x + b.nx * b.a, y1: b.y + b.ny * b.b, z1: b.z + b.nz * b.c }));
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      const apart = a.x1 <= b.x0 + 1e-6 || b.x1 <= a.x0 + 1e-6 || a.y1 <= b.y0 + 1e-6 || b.y1 <= a.y0 + 1e-6 || a.z1 <= b.z0 + 1e-6 || b.z1 <= a.z0 + 1e-6;
      assert(apart, 'two blocks overlap');
    }
    const a = blocks[i];
    if (a.z0 > 1e-6) {
      const area = (a.x1 - a.x0) * (a.y1 - a.y0);
      let held = 0;
      for (const b of blocks) {
        if (Math.abs(b.z1 - a.z0) > 1e-6) continue;
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox > 0 && oy > 0) held += ox * oy;
      }
      assert(held >= area - 1e-3, 'a block is not fully supported');
    }
  }
  if (c.type.payload > 0) assert(c.weight <= c.type.payload + 1e-6, 'over the payload');
}

function types(...codes) {
  return D.defaultContainers().map(t => Object.assign(t, { enabled: codes.includes(t.code) }));
}

const settings = { kpi: 85, maxChange: 5, gap: 5 };

test('a simple load is all loaded, inside the container, nothing overlapping', () => {
  const products = [D.product({ name: 'A', l: 60, w: 40, h: 30, qty: 500, weight: 10 }, 0)];
  const r = P.plan(products, types('40HC'), settings, 'asOrdered');
  assert(r.feasible);
  assert.strictEqual(r.planned[products[0].id], 500);
  r.containers.forEach(c => checkContainer(c, settings.gap));
});

test('the sample order: every option is valid', () => {
  const products = D.sampleProducts();
  const r = P.optimise(products, types('40HC'), settings);
  for (const key of ['asOrdered', 'topUp', 'trim']) {
    const o = r[key];
    if (!o || !o.feasible) continue;
    o.containers.forEach(c => checkContainer(c, settings.gap));
  }
  assert(r.asOrdered.lines.every(l => l.change === 0), 'as ordered must not change quantities');
  console.log('     as ordered: ' + r.asOrdered.containers.map(c => c.type.code + ' ' + (c.fill * 100).toFixed(1) + '%').join(', '));
  console.log('     top up:     ' + r.topUp.containers.map(c => c.type.code + ' ' + (c.fill * 100).toFixed(1) + '%').join(', ') + '  change ' + (r.topUp.changeFraction * 100).toFixed(1) + '%');
  if (r.trim && r.trim.feasible) console.log('     trim:       ' + r.trim.containers.map(c => c.type.code + ' ' + (c.fill * 100).toFixed(1) + '%').join(', ') + '  change ' + (r.trim.changeFraction * 100).toFixed(1) + '%');
  else console.log('     trim:       not possible');
  console.log('     recommended: ' + r.recommended + ', change needed: ' + P.changeNeeded(products, types('40HC'), settings));
});

test('quantities stay inside each product\'s limit; locked products do not move', () => {
  const products = D.sampleProducts();
  products[0].locked = true;
  products[1].maxChange = 2;
  const r = P.optimise(products, types('40HC'), { kpi: 85, maxChange: 10, gap: 5 });
  for (const key of ['topUp', 'trim']) {
    const o = r[key];
    if (!o || !o.feasible) continue;
    o.lines.forEach(line => {
      const p = products.find(x => x.id === line.id);
      const b = P.bounds(p, { maxChange: 10 });
      assert(line.planned >= b.lo && line.planned <= b.hi, key + ': ' + p.name + ' planned ' + line.planned + ' outside ' + b.lo + '–' + b.hi);
    });
    assert.strictEqual(o.lines[0].change, 0, 'locked product changed');
  }
});

test('the payload is respected', () => {
  const products = [D.product({ name: 'Heavy', l: 50, w: 50, h: 50, qty: 600, weight: 100 }, 0)];
  const r = P.plan(products, types('20GP'), settings, 'asOrdered');
  r.containers.forEach(c => checkContainer(c, settings.gap));
  assert(r.containers[0].weight <= 28200);
  assert(r.containers.length >= 3);
});

test('a small remainder goes in a smaller container when one is allowed', () => {
  const products = [D.product({ name: 'A', l: 60, w: 40, h: 30, qty: 1000, weight: 5 }, 0)];
  const r = P.plan(products, types('20GP', '40HC'), settings, 'asOrdered');
  const codes = r.containers.map(c => c.type.code);
  assert(codes.includes('20GP'), 'expected a 20 ft for the remainder, got ' + codes.join(', '));
});

test('a carton too big for every container is reported, not looped on', () => {
  const products = [D.product({ name: 'Mast', l: 1300, w: 20, h: 20, qty: 2 }, 0), D.product({ name: 'A', l: 60, w: 40, h: 30, qty: 10 }, 1)];
  const r = P.optimise(products, types('40HC'), settings);
  assert.strictEqual(r.oversize.length, 1);
  assert.strictEqual(r.asOrdered.containers.length, 1);
});

test('random orders: always valid, quantities exact', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let worst = 1, total = 0, count = 0;
  for (let run = 0; run < 150; run++) {
    const n = 1 + Math.floor(rnd() * 7);
    const products = [];
    for (let i = 0; i < n; i++) {
      products.push(D.product({
        name: 'P' + i, l: 20 + Math.round(rnd() * 180), w: 15 + Math.round(rnd() * 90), h: 8 + Math.round(rnd() * 70),
        weight: rnd() < 0.3 ? 0 : 2 + rnd() * 40, qty: 20 + Math.floor(rnd() * 900), tippable: rnd() < 0.5,
      }, i));
    }
    const allowed = [['40HC'], ['20GP', '40GP', '40HC'], ['40GP']][run % 3];
    const r = P.optimise(products, types(...allowed), { kpi: 85, maxChange: Math.round(rnd() * 10), gap: 5 });
    for (const key of ['asOrdered', 'topUp', 'trim']) {
      const o = r[key];
      if (!o || !o.feasible) continue;
      o.containers.forEach(c => checkContainer(c, 5));
    }
    r.asOrdered.lines.forEach(l => assert.strictEqual(l.change, 0));
    const full = r.asOrdered.containers.slice(0, -1);
    full.forEach(c => { worst = Math.min(worst, c.fill); total += c.fill; count++; });
  }
  console.log('     full containers: mean fill ' + (total / count * 100).toFixed(1) + '%, worst ' + (worst * 100).toFixed(1) + '%  (' + count + ' containers)');
});

test('reads the app\'s JSON export and a CSV', () => {
  const json = JSON.stringify({ schemaVersion: 1, products: [{ name: 'Kombucha', lengthCm: 40.1, widthCm: 30, heightCm: 20, weightKg: 12.5, sku: 'JIVA' }] });
  const a = D.parseProducts(json, 0);
  assert.strictEqual(a.products.length, 1);
  assert.strictEqual(a.products[0].l, 40.1);
  assert.strictEqual(a.products[0].qty, 0, 'no quantity in the file means none');
  const csv = 'Name,SKU,Length (cm),Width (cm),Height (cm),Weight (kg),Quantity\n"Sofa, 3 seat",S3,200,90,80,45,24\nBad,,,,,,\n';
  const b = D.parseProducts(csv, 0);
  assert.strictEqual(b.products.length, 1);
  assert.strictEqual(b.products[0].name, 'Sofa, 3 seat');
  assert.strictEqual(b.products[0].qty, 24);
  assert.strictEqual(b.skipped, 1);
});

test('the example has a library with more products than the order', () => {
  const s = D.sampleState();
  assert.strictEqual(s.products.length, 5);
  assert(s.library.length > s.products.length);
  s.products.forEach(line => {
    const item = s.library.find(i => i.id === line.lib);
    assert(item, 'every order line points at a library product');
    assert.strictEqual(item.l, line.l);
    assert.notStrictEqual(item.id, line.id);
  });
});

test('room for a product: what is added never needs another container', () => {
  const s = D.sampleState();
  const all = types('40HC');
  const before = P.plan(s.products, all, settings, 'asOrdered').containers.length;
  // A product not yet on order.
  const fresh = Object.assign({}, s.library[6], { id: 'candidate' });
  const room = P.roomFor(s.products, all, settings, fresh);
  assert(room.count > 0 && !room.opensNew, 'the last container has room');
  assert.strictEqual(room.containers, before);
  const after = P.plan(s.products.concat([Object.assign({}, fresh, { qty: room.count })]), all, settings, 'asOrdered');
  assert(after.feasible);
  assert.strictEqual(after.containers.length, before);
  // One already on order: the answer is how many MORE.
  const more = P.roomFor(s.products, all, settings, s.products[1]);
  assert(more.count > 0);
  const grown = s.products.map(p => p === s.products[1] ? Object.assign({}, p, { qty: p.qty + more.count }) : p);
  assert.strictEqual(P.plan(grown, all, settings, 'asOrdered').containers.length, before);
  console.log('     room in the example order: ' + room.count + ' × ' + fresh.name + ', or ' + more.count + ' more × ' + s.products[1].name);
});

test('room for a product: an empty order fills one container; a huge carton is refused', () => {
  const all = types('40HC');
  const item = D.product({ name: 'A', l: 60, w: 40, h: 30, weight: 5 }, 0);
  const room = P.roomFor([], all, settings, item);
  assert(room.count > 500 && !room.opensNew && room.containers === 0);
  const one = P.plan([Object.assign({}, item, { qty: room.count })], all, settings, 'asOrdered');
  assert.strictEqual(one.containers.length, 1);
  assert(one.containers[0].fill > 0.7);
  const mast = D.product({ name: 'Mast', l: 1300, w: 20, h: 20 }, 1);
  assert.strictEqual(P.roomFor([], all, settings, mast).tooBig, true);
});

test('a row is one wall of the product: across the container times up to the roof', () => {
  const upright = D.product({ name: 'A', l: 60, w: 40, h: 30, tippable: false }, 0);
  // 40 ft high cube with a 5 cm gap: 230.2 across, 264.8 high → 5 across (40s) × 8 high.
  assert.strictEqual(P.rowSize(upright, types('40HC'), settings), 40);
  // A standard-height container takes one layer fewer.
  assert.strictEqual(P.rowSize(upright, types('40GP'), settings), 35);
  // Never less than one, even for a carton that fits nothing.
  assert.strictEqual(P.rowSize(D.product({ name: 'Mast', l: 1300, w: 300, h: 300 }, 1), types('40HC'), settings), 1);
});

/**
 The weight resting on the bottom cartons of every block, taking weight
 to spread evenly over what it stands on: never more than the product's
 limit, and (with heavy at the bottom) never more than a full-height
 stack of its own kind would put there.
*/
function checkStacking(c, products, heavyLow) {
  const byId = {}; products.forEach(p => byId[p.id] = p);
  for (const b of c.blocks) {
    const p = byId[b.id], kg = b.kg || 0, area = b.a * b.b;
    let limit = Infinity;
    if (p.topLoad !== null && p.topLoad !== undefined) limit = p.topLoad;
    else if (heavyLow && kg > 0) limit = kg / (p.l * p.w * p.h) * c.type.height * area;
    if (limit === Infinity) continue;
    const x1 = b.x + b.nx * b.a, y1 = b.y + b.ny * b.b, top = b.z + b.nz * b.c;
    // Everything above this block, as weight per square centimetre.
    let worst = 0;
    for (const o of c.blocks) {
      if (o === b || o.z < top - 1e-6) continue;
      if (o.x >= x1 - 1e-6 || o.x + o.nx * o.a <= b.x + 1e-6 || o.y >= y1 - 1e-6 || o.y + o.ny * o.b <= b.y + 1e-6) continue;
      // The column over the middle of this block: everything above b over that spot.
      const cx = o.x + o.nx * o.a / 2, cy = o.y + o.ny * o.b / 2;
      let column = 0;
      for (const q of c.blocks) {
        if (q.z < top - 1e-6) continue;
        if (cx > q.x && cx < q.x + q.nx * q.a && cy > q.y && cy < q.y + q.ny * q.b) column += q.nz * (q.kg || 0) / (q.a * q.b);
      }
      worst = Math.max(worst, column);
    }
    const carried = (b.nz - 1) * kg + worst * area;
    assert(carried <= limit + 1e-3, p.name + ' carries ' + carried.toFixed(1) + ' kg, limit ' + limit.toFixed(1));
    if (limit === 0) assert(b.nz === 1 && worst === 0, 'something stands on ' + p.name);
  }
}

test('stacking strength: no carton carries more than its limit', () => {
  const products = [
    D.product({ name: 'Glass', l: 80, w: 60, h: 20, qty: 120, weight: 18, topLoad: 0 }, 0),
    D.product({ name: 'Lamp', l: 50, w: 40, h: 40, qty: 400, weight: 6, topLoad: 15 }, 1),
    D.product({ name: 'Tiles', l: 40, w: 40, h: 12, qty: 900, weight: 22 }, 2),
    D.product({ name: 'Chair', l: 62, w: 48, h: 56, qty: 300, weight: 13, topLoad: 60 }, 3),
  ];
  const r = P.optimise(products, types('40HC'), { kpi: 85, maxChange: 5, gap: 5, heavyLow: true, balance: true });
  for (const key of ['asOrdered', 'topUp', 'trim']) {
    const o = r[key];
    if (!o || !o.feasible) continue;
    o.containers.forEach(c => { checkContainer(c, 5); checkStacking(c, products, true); });
  }
  assert(r.asOrdered.feasible);
  // Lamps carry 15 kg: three high at most (two 6 kg lamps on the bottom one).
  r.asOrdered.containers.forEach(c => c.blocks.forEach(b => {
    if (b.id === products[0].id) assert.strictEqual(b.nz, 1, 'glass is never stacked');
    if (b.id === products[1].id) assert(b.nz <= 3, 'lamps stacked ' + b.nz + ' high');
  }));
});

test('heavy at the bottom: a heavy stack never stands on light cartons', () => {
  const products = [
    D.product({ name: 'Pillows', l: 100, w: 60, h: 50, qty: 150, weight: 4 }, 0),
    D.product({ name: 'Books', l: 50, w: 30, h: 25, qty: 1500, weight: 20 }, 1),
  ];
  const on = P.plan(products, types('40HC'), { kpi: 85, maxChange: 5, gap: 5, heavyLow: true }, 'asOrdered');
  assert(on.feasible);
  on.containers.forEach(c => { checkContainer(c, 5); checkStacking(c, products, true); });
});

test('random orders with stacking limits and balancing: always valid, same quantities', () => {
  let seed = 4242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let bad = 0, count = 0;
  for (let run = 0; run < 80; run++) {
    const n = 1 + Math.floor(rnd() * 7), products = [];
    for (let i = 0; i < n; i++) {
      const l = 20 + Math.round(rnd() * 180), w = 15 + Math.round(rnd() * 90), h = 8 + Math.round(rnd() * 70);
      const weight = rnd() < 0.15 ? 0 : Math.round(l * w * h / 1e6 * (100 + rnd() * 250) * 10) / 10;
      products.push(D.product({ name: 'P' + i, l, w, h, weight, qty: 20 + Math.floor(rnd() * 900), tippable: rnd() < 0.5,
        topLoad: rnd() < 0.3 ? Math.round(rnd() * 120) : null }, i));
    }
    const allowed = [['40HC'], ['20GP', '40GP', '40HC'], ['40GP']][run % 3];
    const s = { kpi: 85, maxChange: Math.round(rnd() * 10), gap: 5, heavyLow: rnd() < 0.7, balance: true };
    const r = P.optimise(products, types(...allowed), s);
    const plain = P.optimise(products, types(...allowed), Object.assign({}, s, { balance: false }));
    for (const key of ['asOrdered', 'topUp', 'trim']) {
      const o = r[key];
      if (!o || !o.feasible) continue;
      o.containers.forEach(c => {
        checkContainer(c, 5); checkStacking(c, products, s.heavyLow);
        // Blocks still add up to what the container says it holds.
        const sums = {};
        c.blocks.forEach(b => { assert.strictEqual(b.count, b.nx * b.ny * b.nz); sums[b.id] = (sums[b.id] || 0) + b.count; });
        assert.deepStrictEqual(sums, c.counts);
        if (c.balance && !c.balance.light) { count++; if (!c.balance.ok) bad++; }
      });
      // Balancing never changes what is loaded.
      assert.strictEqual(o.containers.length, plain[key].containers.length, key + ': balancing changed the number of containers');
      assert.strictEqual(o.plannedCartons, plain[key].plannedCartons, key + ': balancing changed the quantities');
    }
    r.asOrdered.lines.forEach(l => assert.strictEqual(l.change, 0));
  }
  console.log('     ' + (count - bad) + ' of ' + count + ' loaded containers within 60 / 40 both ways');
});

test('weight balance: the shares are right on a simple load, and a part load is spread out', () => {
  // One block against the closed end: all the weight in the front half.
  const type = types('40HC').find(t => t.enabled);
  const block = { id: 'a', x: 0, y: 0, z: 0, a: 100, b: 100, c: 100, nx: 3, ny: 2, nz: 1, count: 6, kg: 50 };
  const bal = P.balanceOf({ type, blocks: [block] }, 5);
  assert.strictEqual(bal.front, 1);
  assert(bal.left > 0.5 && !bal.ok && bal.weight === 300);
  // Cartons with no weight are left out, and counted.
  const mixed = P.balanceOf({ type, blocks: [block, Object.assign({}, block, { x: 600, kg: 0 })] }, 5);
  assert.strictEqual(mixed.unweighed, 6);
  assert.strictEqual(P.balanceOf({ type, blocks: [Object.assign({}, block, { kg: 0 })] }, 5), null);
  // Half a container of heavy cartons: built to the roof it sits at the closed end; balanced, it reaches along the floor.
  const products = [D.product({ name: 'Paint', l: 40, w: 30, h: 30, qty: 900, weight: 20 }, 0)];
  const tall = P.plan(products, types('40HC'), { kpi: 85, maxChange: 5, gap: 5 }, 'asOrdered');
  const spread = P.plan(products, types('40HC'), { kpi: 85, maxChange: 5, gap: 5, balance: true }, 'asOrdered');
  assert(!tall.containers[0].balance.ok, 'built to the roof, a part load is front-heavy');
  assert(spread.containers[0].balance.ok, 'balanced, it is within 60 / 40');
  assert.strictEqual(spread.planned[products[0].id], 900);
  checkContainer(spread.containers[0], 5);
  console.log('     part load: ' + Math.round(tall.containers[0].balance.front * 100) + '% in the front half as built, ' + Math.round(spread.containers[0].balance.front * 100) + '% once spread');
});

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
