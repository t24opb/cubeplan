// node website/tests/bench.js [heavyLow] [balance] — how full do full containers get on furniture-like orders?
const flags = process.argv.slice(2);
const P = require('../js/packer.js'), D = require('../js/data.js');
let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const fills = []; let t0 = Date.now(), worstMs = 0;
for (let run = 0; run < 200; run++) {
  const n = 2 + Math.floor(rnd() * 9), products = [];
  for (let i = 0; i < n; i++) {
    const flat = rnd() < 0.6;
    products.push(D.product(flat
      ? { name: 'F' + i, l: 60 + Math.round(rnd() * 150), w: 30 + Math.round(rnd() * 90), h: 8 + Math.round(rnd() * 27), qty: 30 + Math.floor(rnd() * 500), weight: 10 + rnd() * 35, tippable: rnd() < 0.7 }
      : { name: 'B' + i, l: 40 + Math.round(rnd() * 80), w: 30 + Math.round(rnd() * 60), h: 20 + Math.round(rnd() * 60), qty: 30 + Math.floor(rnd() * 500), weight: 5 + rnd() * 25, tippable: rnd() < 0.5 }, i));
  }
  const types = D.defaultContainers();
  const s = Date.now();
  const r = P.optimise(products, types, { kpi: 85, maxChange: 5, gap: 5, heavyLow: flags.includes('heavyLow'), balance: flags.includes('balance') });
  worstMs = Math.max(worstMs, Date.now() - s);
  r.asOrdered.containers.slice(0, -1).forEach(c => { if (c.weightFill < 0.97) fills.push(c.fill); });
}
fills.sort((a, b) => a - b);
const pc = q => (fills[Math.floor(q * (fills.length - 1))] * 100).toFixed(1);
console.log(`${fills.length} full containers: mean ${(fills.reduce((a, b) => a + b, 0) / fills.length * 100).toFixed(1)}%  p5 ${pc(.05)}  p25 ${pc(.25)}  median ${pc(.5)}  min ${pc(0)}  below 85%: ${(fills.filter(f => f < .85).length / fills.length * 100).toFixed(0)}%  | ${(Date.now() - t0)} ms total, slowest order ${worstMs} ms`);
