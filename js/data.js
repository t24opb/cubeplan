/*
 SmartPallet Container Builder — starting data and file import.

 Container sizes are the same inside dimensions the app uses
 (ContainerCatalog.swift). Payloads are typical figures; they vary by
 shipping line and are editable on the page.
*/
(function (root) {
  'use strict';

  var CONTAINERS = [
    { id: 'c20', name: '20 ft', code: '20GP', length: 589.8, width: 235.2, height: 239.3, payload: 28200, cost: 0, enabled: false },
    { id: 'c40', name: '40 ft', code: '40GP', length: 1203.2, width: 235.2, height: 239.3, payload: 26700, cost: 0, enabled: false },
    { id: 'c45', name: '40 ft high cube', code: '40HC', length: 1203.2, width: 235.2, height: 269.8, payload: 26500, cost: 0, enabled: true },
  ];

  // An example order. The carton sizes are real flat-pack furniture
  // sizes (measured at the store test on 18 November 2026); the names,
  // quantities and weights are made up.
  var SAMPLE = [
    { name: 'Bedside table', sku: 'BST-01', l: 81.5, w: 45, h: 21.5, weight: 14, qty: 460, tippable: true },
    { name: 'Bookcase', sku: 'BKC-01', l: 74, w: 51, h: 32, weight: 19, qty: 300, tippable: true },
    { name: 'Bed frame rails', sku: 'BFR-01', l: 208.5, w: 31.5, h: 8.5, weight: 16, qty: 260, tippable: true },
    { name: 'Coffee table', sku: 'CFT-01', l: 107, w: 55, h: 12.5, weight: 15, qty: 300, tippable: true },
    { name: 'Futon', sku: 'FTN-01', l: 200, w: 116, h: 25, weight: 48, qty: 60, tippable: false },
  ];

  // More products for the library that are not in the example order.
  // Made-up names and plausible flat-pack carton sizes.
  var LIBRARY_EXTRA = [
    { name: 'Dining chairs, pack of 2', sku: 'DCH-02', l: 62, w: 48, h: 56, weight: 13, tippable: false },
    { name: 'TV unit', sku: 'TVU-01', l: 165, w: 45, h: 18, weight: 32, tippable: true },
    { name: 'Mattress in a box', sku: 'MTB-01', l: 112, w: 42, h: 42, weight: 28, tippable: true },
    { name: 'Desk', sku: 'DSK-01', l: 128, w: 68, h: 14, weight: 24, tippable: true },
    { name: 'Wardrobe', sku: 'WRD-01', l: 205, w: 62, h: 22, weight: 58, tippable: false },
  ];

  var COLOURS = ['#C98B4E', '#3F7DB6', '#5E9E6B', '#C9573B', '#8468B8', '#D9AE3C', '#3F9C9E', '#B4557C', '#73808D', '#96703F'];

  var nextId = 1;
  function newId() { return 'p' + Date.now().toString(36) + (nextId++); }

  function product(fields, index) {
    return {
      id: newId(),
      name: fields.name || 'Carton',
      sku: fields.sku || '',
      l: +fields.l || 0, w: +fields.w || 0, h: +fields.h || 0,
      weight: +fields.weight || 0,
      qty: Math.max(0, Math.round(+fields.qty || 0)),
      locked: !!fields.locked,
      maxChange: (fields.maxChange === undefined || fields.maxChange === null || fields.maxChange === '') ? null : +fields.maxChange,
      tippable: fields.tippable === undefined ? false : !!fields.tippable,
      colour: fields.colour || COLOURS[index % COLOURS.length],
    };
  }

  function sampleProducts() { return SAMPLE.map(product); }

  /** A line of the order for a product in the library. */
  function orderLine(item, qty) {
    var line = product(item, 0);
    line.colour = item.colour;
    line.lib = item.id;
    line.qty = Math.max(0, Math.round(+qty || 0));
    return line;
  }

  /** The example: a library of ten products, five of them on order. */
  function sampleState() {
    var library = SAMPLE.concat(LIBRARY_EXTRA).map(function (fields, index) {
      var item = product(fields, index);
      item.qty = 0;
      return item;
    });
    var products = SAMPLE.map(function (fields, index) { return orderLine(library[index], fields.qty); });
    return { library: library, products: products };
  }
  function defaultContainers() { return JSON.parse(JSON.stringify(CONTAINERS)); }

  /** Splits one CSV line, minding quoted fields. */
  function csvLine(line) {
    var out = [], field = '', quoted = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === ';' || ch === '\t') { out.push(field); field = ''; }
      else field += ch;
    }
    out.push(field);
    return out.map(function (s) { return s.trim(); });
  }

  function pick(row, names) {
    for (var i = 0; i < names.length; i++) {
      if (row[names[i]] !== undefined && row[names[i]] !== '') return row[names[i]];
    }
    return undefined;
  }

  /**
   Reads products from a file's text: the app's "Export all products as
   JSON" file, or a CSV with a header row (name, sku, length, width,
   height in cm, weight in kg, quantity). Returns { products, skipped }.
  */
  function parseProducts(text, startIndex) {
    var rows = [];
    var trimmed = text.trim();
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      var json = JSON.parse(trimmed);
      var list = Array.isArray(json) ? json : (json.products || (json.product ? [json.product] : []));
      list.forEach(function (p) {
        rows.push({
          name: p.name || p.description, sku: p.sku,
          l: p.lengthCm !== undefined ? p.lengthCm : p.length,
          w: p.widthCm !== undefined ? p.widthCm : p.width,
          h: p.heightCm !== undefined ? p.heightCm : p.height,
          weight: p.weightKg !== undefined ? p.weightKg : p.weight,
          qty: p.quantity !== undefined ? p.quantity : p.qty,
        });
      });
    } else {
      var lines = trimmed.split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (lines.length < 2) throw new Error('The file needs a header row and at least one product.');
      var header = csvLine(lines[0]).map(function (h) { return h.toLowerCase().replace(/[^a-z]/g, ''); });
      lines.slice(1).forEach(function (line) {
        var cells = csvLine(line), row = {};
        header.forEach(function (h, i) { row[h] = cells[i]; });
        rows.push({
          name: pick(row, ['name', 'product', 'description', 'productname']),
          sku: pick(row, ['sku', 'skunumber', 'code', 'item']),
          l: pick(row, ['lengthcm', 'length', 'l']),
          w: pick(row, ['widthcm', 'width', 'w', 'depth', 'depthcm', 'd']),
          h: pick(row, ['heightcm', 'height', 'h']),
          weight: pick(row, ['weightkg', 'weight', 'kg']),
          qty: pick(row, ['quantity', 'qty', 'cartons', 'orderqty', 'ordered']),
        });
      });
    }
    var usable = rows.filter(function (r) { return +r.l > 0 && +r.w > 0 && +r.h > 0; });
    if (!usable.length) throw new Error('No products with a length, width and height were found in that file.');
    // A product with no quantity in the file comes in with none: it
    // goes in the library, ready to be added to a load.
    var products = usable.map(function (r, i) { return product(r, (startIndex || 0) + i); });
    return { products: products, skipped: rows.length - usable.length };
  }

  var api = {
    COLOURS: COLOURS, product: product, sampleProducts: sampleProducts,
    defaultContainers: defaultContainers, parseProducts: parseProducts, newId: newId,
    sampleState: sampleState, orderLine: orderLine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SPData = api;
})(typeof window !== 'undefined' ? window : globalThis);
