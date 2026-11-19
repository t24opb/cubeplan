/*
 CubePlanner — the page: state, tables, options and
 the wiring between the controls, the optimiser and the 3D views.
*/
(function () {
  'use strict';
  var P = window.SPPacker, D = window.SPData;
  // The key keeps the product's first name so plans saved before the
  // rename are still found.
  var KEY = 'smartpallet.containerBuilder.v1';
  function $(id) { return document.getElementById(id); }

  var MODES = [['asOrdered', 'As ordered'], ['topUp', 'Top up'], ['trim', 'Trim']];
  var LOCK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  var UNLOCK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.3-1.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  function fresh() {
    var sample = D.sampleState();
    return { library: sample.library, products: sample.products, types: D.defaultContainers(), settings: { kpi: 85, maxChange: 5, gap: 5 }, choice: 'auto', example: true };
  }
  var CARTON_FIELDS = ['name', 'sku', 'l', 'w', 'h', 'weight', 'tippable', 'colour'];
  /** A library product with the same carton as an order line. */
  function libraryCopy(line) {
    var item = { id: D.newId(), qty: 0 };
    CARTON_FIELDS.forEach(function (key) { item[key] = line[key]; });
    return item;
  }
  function restore() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(KEY));
      if (saved && Array.isArray(saved.products) && Array.isArray(saved.types) && saved.types.length && saved.settings) {
        // Saved before there was a library: every order line becomes a
        // library product too.
        if (!Array.isArray(saved.library)) saved.library = [];
        saved.products.forEach(function (line) {
          if (line.lib && saved.library.some(function (item) { return item.id === line.lib; })) return;
          var item = libraryCopy(line);
          saved.library.push(item);
          line.lib = item.id;
        });
        return saved;
      }
    } catch (ignore) { /* nothing saved, or storage is off */ }
    return null;
  }
  var saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch (ignore) { /* storage is off */ }
    }, 300);
  }

  var state = restore() || fresh();
  var result = null, shownMode = null, contIndex = 0, openId = null, litId = null;
  var viewer = null, cartonViewer = null, cartonHost = null;

  // ---------- formatting ----------
  function esc(text) {
    return String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function int(n) { return Math.round(n).toLocaleString('en-AU'); }
  function num(n) { return (Math.round(n * 10) / 10).toLocaleString('en-AU'); }
  /** Rounded down, so a container just under the minimum never reads as meeting it. */
  function pct(fraction) { return (Math.floor(fraction * 1000 + 1e-6) / 10).toFixed(1) + '%'; }
  function signedPct(fraction) {
    var value = Math.round(fraction * 1000) / 10;
    return (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toFixed(1) + '%';
  }
  function m3(cubicCm) { return (cubicCm / 1e6).toFixed(1); }
  function plural(n, word) { return int(n) + ' ' + word + (n === 1 ? '' : 's'); }
  function product(id) { return state.products.filter(function (p) { return p.id === id; })[0]; }
  function libraryItem(id) { return state.library.filter(function (item) { return item.id === id; })[0]; }
  /** The order line for a library product, if it is on order. */
  function lineFor(libId) { return state.products.filter(function (p) { return p.lib === libId; })[0]; }
  function sizeText(p) {
    return num(p.l) + ' × ' + num(p.w) + ' × ' + num(p.h) + ' cm' + (p.weight > 0 ? ' · ' + num(p.weight) + ' kg' : '');
  }
  function plan() { return result && shownMode ? result[shownMode] : null; }

  // ---------- toast ----------
  var toastTimer;
  function toast(message, actionLabel, action) {
    var el = $('toast');
    el.innerHTML = esc(message) + (actionLabel ? ' <button type="button" class="link" id="toast-action" style="color:inherit;margin-left:8px">' + esc(actionLabel) + '</button>' : '');
    el.hidden = false;
    if (actionLabel) $('toast-action').addEventListener('click', function () { el.hidden = true; action(); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, actionLabel ? 8000 : 3200);
  }

  // ---------- rules ----------
  function renderRules() {
    $('type-chips').innerHTML = state.types.map(function (t) {
      return '<button type="button" class="chip" data-type="' + esc(t.id) + '" aria-pressed="' + (t.enabled !== false) + '">' + esc(t.name) + '</button>';
    }).join('');
    $('in-kpi').value = state.settings.kpi;
    $('out-kpi').textContent = state.settings.kpi + '%';
    $('in-change').value = state.settings.maxChange;
    $('in-gap').value = state.settings.gap;
  }

  function renderTypes() {
    $('types-body').innerHTML = state.types.map(function (t) {
      function cell(field, step) {
        return '<td><input class="cell-input" type="number" min="0" step="' + step + '" inputmode="decimal" data-type="' + esc(t.id) + '" data-tf="' + field + '" id="type-' + esc(t.id) + '-' + field + '" value="' + (t[field] || 0) + '" aria-label="' + esc(t.name) + ' ' + field + '"></td>';
      }
      return '<tr>' +
        '<td><input type="checkbox" data-type="' + esc(t.id) + '" data-tf="enabled" id="type-' + esc(t.id) + '-on" ' + (t.enabled !== false ? 'checked' : '') + ' aria-label="Use ' + esc(t.name) + '"></td>' +
        '<td class="left"><input type="text" data-type="' + esc(t.id) + '" data-tf="name" id="type-' + esc(t.id) + '-name" value="' + esc(t.name) + '" aria-label="Container name"></td>' +
        cell('length', 0.1) + cell('width', 0.1) + cell('height', 0.1) + cell('payload', 1) + cell('cost', 1) +
        '<td>' + (t.custom ? '<button type="button" class="btn quiet small danger" data-type="' + esc(t.id) + '" data-tf="remove">Remove</button>' : '') + '</td></tr>';
    }).join('');
  }

  // ---------- product library ----------
  /** A small drawing of the carton, to its own proportions. */
  function cartonDrawing(l, w, h, colour) {
    var c = Math.cos(Math.PI / 6);
    function at(x, y, z) { return [(x - y) * c, (x + y) * 0.5 - z]; }
    var p = { x: at(l, 0, 0), y: at(0, w, 0), xy: at(l, w, 0), z: at(0, 0, h), xz: at(l, 0, h), yz: at(0, w, h), xyz: at(l, w, h) };
    var all = Object.keys(p).map(function (key) { return p[key]; });
    var minX = Math.min.apply(null, all.map(function (q) { return q[0]; })), maxX = Math.max.apply(null, all.map(function (q) { return q[0]; }));
    var minY = Math.min.apply(null, all.map(function (q) { return q[1]; })), maxY = Math.max.apply(null, all.map(function (q) { return q[1]; }));
    var k = Math.min(50 / Math.max(1, maxX - minX), 40 / Math.max(1, maxY - minY));
    var ox = (54 - (maxX - minX) * k) / 2, oy = (44 - (maxY - minY) * k) / 2;
    function points(keys) {
      return keys.map(function (key) { return ((p[key][0] - minX) * k + ox).toFixed(1) + ',' + ((p[key][1] - minY) * k + oy).toFixed(1); }).join(' ');
    }
    var fill = esc(colour || '#c29e73');
    return '<svg viewBox="0 0 54 44" aria-hidden="true">' +
      '<polygon class="edge" fill="' + fill + '" points="' + points(['x', 'xy', 'xyz', 'xz']) + '"/>' +
      '<polygon class="edge" fill="' + fill + '" points="' + points(['y', 'xy', 'xyz', 'yz']) + '"/>' +
      '<polygon fill="#000" fill-opacity="0.2" points="' + points(['y', 'xy', 'xyz', 'yz']) + '"/>' +
      '<polygon class="edge" fill="' + fill + '" points="' + points(['z', 'xz', 'xyz', 'yz']) + '"/>' +
      '<polygon fill="#fff" fill-opacity="0.28" points="' + points(['z', 'xz', 'xyz', 'yz']) + '"/></svg>';
  }

  function renderLibrary() {
    $('lib-count').textContent = state.library.length ? state.library.length + (state.library.length === 1 ? ' product' : ' products') : '';
    $('lib-list').innerHTML = state.library.map(function (item) {
      var line = lineFor(item.id);
      return '<div class="lib-item" draggable="true" data-lib="' + item.id + '" title="Drag onto the container">' +
        '<span class="lib-box">' + cartonDrawing(item.l, item.w, item.h, item.colour) + '</span>' +
        '<span><span class="lib-name">' + esc(item.name) + '</span><span class="lib-size">' + esc(num(item.l) + ' × ' + num(item.w) + ' × ' + num(item.h) + ' cm') + '</span>' +
        (line && line.qty > 0 ? '<span class="lib-in">' + int(line.qty) + ' in the load</span>' : '') + '</span>' +
        '<span class="lib-actions"><button type="button" class="lib-btn" data-act="add" aria-label="Add ' + esc(item.name) + ' to the load" title="Add to the load">+</button>' +
        (line ? '' : '<button type="button" class="lib-btn remove" data-act="forget" aria-label="Remove ' + esc(item.name) + ' from the library" title="Remove from the library">×</button>') +
        '</span></div>';
    }).join('') || '<p class="lib-empty">No products yet. Import a file from the app, or add a product to the order.</p>';
  }

  /** Asks how many cartons of a library product to add, offering what fits. */
  var adding = null;
  function openAdd(libId) {
    var item = libraryItem(libId);
    if (!item) return;
    var line = lineFor(libId);
    var candidate = {};
    Object.keys(item).forEach(function (key) { candidate[key] = item[key]; });
    candidate.id = line ? line.id : 'candidate';
    var room = P.roomFor(state.products, state.types, state.settings, candidate);
    adding = libId;
    $('add-title').textContent = 'Add ' + item.name;
    var hint;
    if (room.tooBig) hint = 'This carton is too big for the containers you have allowed, so it will be left out of the plan.';
    else if (room.containers === 0) hint = plural(room.count, 'carton') + ' would fill one container.';
    else if (room.opensNew) hint = 'The ' + plural(room.containers, 'container') + ' planned ' + (room.containers === 1 ? 'is' : 'are') + ' full. ' + plural(room.count, 'carton') + ' would fill one more.';
    else hint = plural(room.count, (line ? 'more ' : '') + 'carton') + ' fit in the space left in the ' + plural(room.containers, 'container') + ' already planned.';
    $('add-hint').textContent = hint;
    $('add-qty').value = Math.max(1, room.count);
    $('add-sheet').hidden = false;
    $('add-qty').focus();
    $('add-qty').select();
  }
  function confirmAdd() {
    var item = adding && libraryItem(adding);
    var qty = Math.max(0, Math.round(+$('add-qty').value || 0));
    $('add-sheet').hidden = true;
    adding = null;
    if (!item || !qty) return;
    var line = lineFor(item.id);
    if (line) line.qty += qty;
    else {
      line = D.orderLine(item, qty);
      state.products.push(line);
    }
    edited();
    // Show where it went: the product just added stands out in the picture.
    litId = line.id;
    renderOrder(); recalc();
    toast('Added ' + plural(qty, 'carton') + ' of ' + item.name + '.');
  }

  // ---------- order table ----------
  function renderOrder() {
    var general = state.settings.maxChange;
    var rows = state.products.map(function (p) {
      var open = p.id === openId;
      var html = '<tr class="row' + (open ? ' open' : '') + (p.id === litId ? ' lit' : '') + '" data-id="' + p.id + '">' +
        '<td><button type="button" class="prod" data-act="open" aria-expanded="' + open + '"><i class="dot" style="background:' + esc(p.colour) + '"></i>' +
        '<span><span class="prod-name">' + esc(p.name) + '</span><span class="prod-size">' + esc(sizeText(p)) + '</span></span></button></td>' +
        '<td><input class="cell-input" type="number" min="0" step="1" inputmode="numeric" data-f="qty" id="qty-' + p.id + '" value="' + p.qty + '" aria-label="Cartons of ' + esc(p.name) + ' ordered"></td>' +
        '<td><button type="button" class="lock" data-act="lock" aria-pressed="' + !!p.locked + '" aria-label="Lock the quantity of ' + esc(p.name) + '" title="' + (p.locked ? 'Locked: this quantity will not change' : 'Lock this quantity') + '">' + (p.locked ? LOCK_ICON : UNLOCK_ICON) + '</button></td>' +
        '<td><input class="cell-input narrow" type="number" min="0" max="100" step="1" inputmode="decimal" data-f="maxChange" id="lim-' + p.id + '" placeholder="' + general + '" value="' + (p.maxChange === null || p.maxChange === undefined ? '' : p.maxChange) + '"' + (p.locked ? ' disabled' : '') + ' aria-label="Limit for ' + esc(p.name) + ', per cent"></td>' +
        '<td class="planned" data-out="planned"></td><td class="change" data-out="change"></td></tr>';
      if (open) {
        html += '<tr class="detail" data-id="' + p.id + '"><td colspan="6"><div class="detail-inner">' +
          '<div id="carton-slot"></div>' +
          '<div class="fields">' +
          field('wide', 'Name', 'name', 'text', p.name) + field('', 'SKU', 'sku', 'text', p.sku) +
          field('', 'Length cm', 'l', 'number', p.l) + field('', 'Width cm', 'w', 'number', p.w) + field('', 'Height cm', 'h', 'number', p.h) +
          field('', 'Weight kg', 'weight', 'number', p.weight) +
          '<div class="field wide" style="justify-content:flex-end"><label class="check" for="d-tip" style="font:inherit;letter-spacing:0;text-transform:none;color:inherit"><input type="checkbox" id="d-tip" data-f="tippable"' + (p.tippable ? ' checked' : '') + '>May be loaded on its side or end</label></div>' +
          '<div class="detail-foot"><span id="d-vol"></span><button type="button" class="btn quiet small danger" data-act="remove">Remove product</button></div>' +
          '</div></div></td></tr>';
      }
      return html;
    }).join('');
    $('order-body').innerHTML = rows || '<tr><td colspan="6" style="text-align:left;color:var(--ink-2);padding:18px 14px">No products yet. Add one, import a file from the app, or load the example.</td></tr>';
    var slot = $('carton-slot');
    if (slot && openId) {
      slot.parentNode.replaceChild(cartonHost, slot);
      if (cartonViewer && cartonViewer.ok) cartonViewer.showCarton(product(openId));
    }
    updateOutputs();
  }
  function field(extra, label, key, type, value) {
    var id = 'd-' + key;
    return '<div class="field ' + extra + '"><label for="' + id + '">' + label + '</label><input id="' + id + '" data-f="' + key + '" type="' + type + '"' +
      (type === 'number' ? ' min="0" step="0.1" inputmode="decimal"' : '') + ' value="' + esc(value === undefined || value === null ? '' : value) + '"></div>';
  }

  function updateRowLabel(p) {
    var row = document.querySelector('#order-body tr.row[data-id="' + p.id + '"]');
    if (!row) return;
    row.querySelector('.prod-name').textContent = p.name;
    row.querySelector('.prod-size').textContent = sizeText(p);
  }

  function updateOutputs() {
    var shown = plan(), lines = {};
    if (shown && shown.lines) shown.lines.forEach(function (line) { lines[line.id] = line; });
    var oversize = result ? result.oversize.map(function (p) { return p.id; }) : [];
    Array.prototype.forEach.call(document.querySelectorAll('#order-body tr.row'), function (row) {
      var id = row.getAttribute('data-id'), p = product(id), line = lines[id];
      var planned = row.querySelector('[data-out="planned"]'), change = row.querySelector('[data-out="change"]');
      row.classList.toggle('lit', id === litId);
      change.className = 'change';
      if (oversize.indexOf(id) >= 0) { planned.textContent = '—'; change.textContent = 'Too big'; change.classList.add('down'); return; }
      if (!line) { planned.textContent = p && p.qty > 0 ? '—' : '0'; change.textContent = ''; return; }
      planned.textContent = int(line.planned);
      if (!line.change) { change.textContent = '—'; return; }
      change.classList.add(line.change > 0 ? 'up' : 'down');
      change.innerHTML = (line.change > 0 ? '+' : '−') + int(Math.abs(line.change)) +
        '<small>' + signedPct(line.change / Math.max(1, line.ordered)) + '</small>';
    });
    var foot = $('order-foot');
    if (!shown || !shown.lines || !state.products.length) { foot.innerHTML = ''; }
    else {
      var diff = shown.plannedCartons - shown.orderedCartons;
      foot.innerHTML = '<tr><td>' + m3(shown.orderedVolume) + ' m³ ordered · ' + m3(shown.plannedVolume) + ' m³ planned</td>' +
        '<td>' + int(shown.orderedCartons) + '</td><td></td><td></td><td>' + int(shown.plannedCartons) + '</td>' +
        '<td class="change ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '') + '">' + (diff ? (diff > 0 ? '+' : '−') + int(Math.abs(diff)) : '—') + '</td></tr>';
    }
    var open = openId && product(openId), volume = $('d-vol');
    if (open && volume) {
      var each = open.l * open.w * open.h / 1e6;
      volume.textContent = each.toFixed(3) + ' m³ a carton · ' + (each * open.qty).toFixed(1) + ' m³ ordered';
    }
  }

  // ---------- options and advice ----------
  function renderOptions() {
    var kpi = state.settings.kpi;
    $('options').innerHTML = MODES.map(function (mode) {
      var key = mode[0], o = result ? result[key] : null;
      if (!o || !o.feasible) {
        var why = !result || !result.asOrdered ? 'Nothing to load yet'
          : key === 'trim' ? (result.asOrdered.containers.length < 2 ? 'There is only one container' : 'Not possible within your limits')
          : 'Not possible';
        return '<button type="button" class="option" disabled><span class="option-name">' + mode[1] + '</span><span class="option-count">—</span><span class="option-line">' + why + '</span></button>';
      }
      var diff = o.plannedCartons - o.orderedCartons;
      var changeLine = diff === 0 && o.productsChanged === 0 ? 'No changes to the order'
        : '<b>' + (diff > 0 ? '+' : '−') + int(Math.abs(diff)) + ' cartons</b> (' + signedPct(o.changeFraction) + ' by volume)';
      var tag = key === result.recommended ? '<span class="tag pick">' + (result.anyPass ? 'Suggested' : 'Closest') + '</span>' : '';
      return '<button type="button" class="option" data-mode="' + key + '" aria-pressed="' + (key === shownMode) + '">' +
        '<span class="option-name">' + mode[1] + tag + '</span>' +
        '<span class="option-count">' + o.containers.length + '<small>' + (o.containers.length === 1 ? 'container' : 'containers') + '</small></span>' +
        '<span class="option-line">Emptiest <b>' + pct(o.minFill) + '</b> full</span>' +
        '<span class="option-line">' + changeLine + '</span>' +
        '<span class="pill ' + (o.meetsKpi ? 'good">✓ Every container ' + kpi + '% or more' : 'bad">✕ A container is under ' + kpi + '%') + '</span></button>';
    }).join('');
  }

  var neededTimer, needed = null;
  function renderAdvice() {
    var el = $('advice'), kpi = state.settings.kpi;
    el.className = 'advice';
    if (!result || !result.asOrdered) {
      el.textContent = result && result.oversize.length ? 'None of these cartons fits in the containers you have allowed.' : 'Add products and quantities to build a load.';
      return;
    }
    var text = '', a = result.asOrdered, best = result[result.recommended];
    if (result.anyPass) {
      if (result.recommended === 'asOrdered') {
        text = 'The order as it stands fills ' + plural(a.containers.length, 'container') + ', each at least ' + kpi + '% full. Nothing needs to change.';
      } else if (result.recommended === 'trim') {
        text = 'Trimming ' + signedPct(best.changeFraction).replace('−', '') + ' off the order saves a container: ' + best.containers.length + ' instead of ' + a.containers.length +
          ', each at least ' + kpi + '% full. ' + plural(best.productsChanged, 'product') + ' changed, none past its limit.';
      } else {
        text = 'Adding ' + signedPct(best.changeFraction).replace('+', '') + ' to the order fills the last container to ' + pct(best.minFill) + '. ' +
          plural(best.productsChanged, 'product') + ' changed, none past its limit. The paler cartons in the picture are the extras.';
      }
    } else {
      el.className = 'advice warn';
      var full = a.containers.slice(0, -1), fullMin = full.length ? Math.min.apply(null, full.map(function (c) { return c.use; })) : 1;
      text = 'No option gets every container to ' + kpi + '% within your limits.';
      if (fullMin * 100 < kpi) {
        text += ' These cartons pack to about ' + pct(fullMin) + ' of a container at best, so the minimum cannot be met. Lower it, or let more products be loaded on their side.';
      } else if (needed && needed.key === neededKey()) {
        text += needed.pct === null ? ' Even ±40% would not be enough. Allowing a smaller container type may help.'
          : ' Allowing ±' + needed.pct + '% would do it.';
      }
    }
    if (result.oversize.length) {
      text += ' ' + result.oversize.map(function (p) { return p.name; }).join(', ') + (result.oversize.length === 1 ? ' is' : ' are') + ' too big for the containers allowed and left out.';
    }
    el.textContent = text;
    if (!result.anyPass && needed && needed.key === neededKey() && needed.pct !== null && el.textContent.indexOf('would do it') >= 0) {
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'link'; button.textContent = 'Use ±' + needed.pct + '%';
      button.addEventListener('click', function () {
        state.settings.maxChange = needed.pct;
        renderRules(); renderOrder(); recalc();
      });
      el.appendChild(button);
    }
  }
  function neededKey() {
    return JSON.stringify([state.settings, state.types, state.products.map(function (p) { return [p.l, p.w, p.h, p.weight, p.qty, p.locked, p.maxChange, p.tippable]; })]);
  }
  /** Works out, once the page is idle, how much change would be needed. */
  function scheduleNeeded() {
    clearTimeout(neededTimer);
    if (!result || !result.asOrdered || result.anyPass) return;
    var key = neededKey();
    if (needed && needed.key === key) return;
    neededTimer = setTimeout(function () {
      var s = state.settings;
      var found = P.changeNeeded(state.products, state.types, { kpi: s.kpi, gap: s.gap, maxChange: s.maxChange, effort: 4 }, 40);
      // The quick search uses fewer tries; confirm it at full effort.
      for (var tries = 0; found !== null && tries < 4; tries++) {
        if (P.optimise(state.products, state.types, { kpi: s.kpi, gap: s.gap, maxChange: found }).anyPass) break;
        found = found < 40 ? found + 1 : null;
      }
      needed = { key: key, pct: found };
      renderAdvice();
    }, 400);
  }

  // ---------- containers and stage ----------
  function renderContainers() {
    var shown = plan(), kpi = state.settings.kpi;
    if (!shown || !shown.containers.length) { $('containers').innerHTML = ''; return; }
    $('containers').innerHTML = shown.containers.map(function (c, i) {
      var ok = c.use * 100 >= kpi - 1e-9;
      var byWeight = c.weightFill > c.fill;
      var mix = Object.keys(c.counts).map(function (id) {
        var p = product(id);
        return '<span><i class="dot" style="background:' + esc(p ? p.colour : '#999') + '"></i>' + esc(p ? p.name : 'Product') + ' ' + int(c.counts[id]) + '</span>';
      }).join('');
      return '<button type="button" class="cont" data-cont="' + i + '" aria-pressed="' + (i === contIndex) + '">' +
        '<span class="cont-head"><span class="cont-name">' + (i + 1) + ' · ' + esc(c.type.code || c.type.name) + '</span>' +
        '<span class="cont-fill ' + (ok ? 'good' : 'bad') + '">' + pct(c.use) + '</span></span>' +
        '<span class="bar"><span class="bar-fill ' + (ok ? '' : 'bad') + '" style="width:' + Math.min(100, c.use * 100).toFixed(1) + '%"></span><span class="bar-mark" style="left:' + kpi + '%" title="Minimum ' + kpi + '%"></span></span>' +
        '<dl class="plate"><dt>Loaded</dt><dd>' + m3(c.volume) + ' of ' + m3(c.capacity) + ' m³</dd>' +
        (c.weight > 0 ? '<dt>Weight</dt><dd>' + int(c.weight) + (c.type.payload > 0 ? ' of ' + int(c.type.payload) : '') + ' kg' + (byWeight ? ' · at limit' : '') + '</dd>' : '') +
        '<dt>Cartons</dt><dd>' + int(c.cartons) + '</dd>' +
        (c.type.cost > 0 ? '<dt>Freight</dt><dd>$' + int(c.type.cost) + '</dd>' : '') + '</dl>' +
        '<span class="mix">' + mix + '</span></button>';
    }).join('');
  }

  function renderStage(keepView) {
    var shown = plan(), empty = $('stage-empty');
    var container = shown && shown.containers[contIndex];
    $('stage-foot').hidden = !container;
    if (!container) {
      empty.hidden = false;
      empty.textContent = 'The loaded container appears here.';
      $('stage-title').innerHTML = '';
      if (viewer && viewer.ok) { viewer._clear(); viewer.size = null; viewer.invalidate(); }
      return;
    }
    empty.hidden = true;
    $('stage-title').innerHTML = 'Container ' + (contIndex + 1) + ' of ' + shown.containers.length +
      '<small>' + esc(container.type.name) + ' · ' + pct(container.use) + ' full · ' + plural(container.cartons, 'carton') + '</small>';
    var colours = {};
    state.products.forEach(function (p) { colours[p.id] = p.colour; });
    if (viewer && viewer.ok) {
      viewer.showContainer(container, colours, state.settings.gap, keepView);
      if (litId) viewer.setHighlight(litId);
    }
    var slider = $('in-seq');
    slider.max = container.cartons; slider.value = container.cartons;
    $('out-seq').textContent = int(container.cartons) + ' of ' + int(container.cartons);
  }

  // ---------- recalculation ----------
  function recalc(keepView) {
    result = P.optimise(state.products, state.types, state.settings);
    var wanted = state.choice !== 'auto' && result[state.choice] && result[state.choice].feasible ? state.choice : result.recommended;
    shownMode = wanted || null;
    var shown = plan();
    if (!shown || contIndex >= shown.containers.length) contIndex = 0;
    if (litId && !product(litId)) litId = null;
    renderOptions(); renderAdvice(); renderContainers(); renderStage(keepView); updateOutputs(); renderLibrary();
    save();
    scheduleNeeded();
  }
  var recalcTimer;
  function recalcSoon() { clearTimeout(recalcTimer); recalcTimer = setTimeout(function () { recalc(true); }, 90); }
  function edited() { state.example = false; }

  // ---------- copy ----------
  function planText() {
    var shown = plan();
    if (!shown) return '';
    function q(value) { value = String(value); return /[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value; }
    var name = MODES.filter(function (m) { return m[0] === shownMode; })[0][1];
    var out = ['CubePlanner,' + name + ' plan', '', 'Container,Type,Full %,Loaded m3,Weight kg,Product,SKU,Cartons'];
    shown.containers.forEach(function (c, i) {
      Object.keys(c.counts).forEach(function (id) {
        var p = product(id) || {};
        out.push([i + 1, q(c.type.name), (c.use * 100).toFixed(1), m3(c.volume), Math.round(c.weight), q(p.name || ''), q(p.sku || ''), c.counts[id]].join(','));
      });
    });
    out.push('', 'Product,SKU,Length cm,Width cm,Height cm,Ordered,Planned,Change');
    shown.lines.forEach(function (line) {
      var p = product(line.id) || {};
      out.push([q(p.name || ''), q(p.sku || ''), p.l, p.w, p.h, line.ordered, line.planned, line.change].join(','));
    });
    return out.join('\n');
  }
  function copyPlan() {
    var text = planText();
    if (!text) { toast('There is no plan to copy yet.'); return; }
    function fallback() {
      $('copy-text').value = text;
      $('copy-sheet').hidden = false;
      $('copy-text').focus(); $('copy-text').select();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Plan copied. Paste it into a spreadsheet or an email.'); }, fallback);
    } else fallback();
  }

  // ---------- events ----------
  function bind() {
    $('in-kpi').addEventListener('input', function () {
      state.settings.kpi = +this.value;
      $('out-kpi').textContent = this.value + '%';
      recalcSoon();
    });
    $('in-change').addEventListener('input', function () {
      state.settings.maxChange = Math.max(0, Math.min(100, +this.value || 0));
      Array.prototype.forEach.call(document.querySelectorAll('[data-f="maxChange"]'), function (el) { el.placeholder = state.settings.maxChange; });
      recalcSoon();
    });
    $('in-gap').addEventListener('input', function () {
      state.settings.gap = Math.max(0, Math.min(50, +this.value || 0));
      recalcSoon();
    });

    $('type-chips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      var type = state.types.filter(function (t) { return t.id === chip.getAttribute('data-type'); })[0];
      var on = state.types.filter(function (t) { return t.enabled !== false; });
      if (type.enabled !== false && on.length === 1) { toast('Keep at least one container type.'); return; }
      type.enabled = type.enabled === false;
      renderRules(); renderTypes(); recalc();
    });
    $('btn-types').addEventListener('click', function () {
      var editor = $('types-editor');
      editor.hidden = !editor.hidden;
      this.setAttribute('aria-expanded', String(!editor.hidden));
      this.textContent = editor.hidden ? 'Sizes and costs' : 'Hide sizes and costs';
    });
    $('types-body').addEventListener('change', function (e) {
      var el = e.target, type = state.types.filter(function (t) { return t.id === el.getAttribute('data-type'); })[0];
      if (!type) return;
      var f = el.getAttribute('data-tf');
      if (f === 'enabled') {
        var on = state.types.filter(function (t) { return t.enabled !== false; });
        if (!el.checked && on.length === 1) { el.checked = true; toast('Keep at least one container type.'); return; }
        type.enabled = el.checked;
      } else if (f === 'name') {
        type.name = el.value.trim() || type.name; el.value = type.name;
        if (type.custom) type.code = type.name;
      } else {
        type[f] = Math.max(0, +el.value || 0);
      }
      renderRules(); recalc();
    });
    $('types-body').addEventListener('click', function (e) {
      var button = e.target.closest('[data-tf="remove"]');
      if (!button) return;
      state.types = state.types.filter(function (t) { return t.id !== button.getAttribute('data-type'); });
      if (!state.types.some(function (t) { return t.enabled !== false; })) state.types[0].enabled = true;
      renderRules(); renderTypes(); recalc();
    });
    $('btn-add-type').addEventListener('click', function () {
      var n = state.types.filter(function (t) { return t.custom; }).length + 1;
      state.types.push({ id: 'x' + Date.now().toString(36), name: 'Custom ' + n, code: 'Custom ' + n, length: 1203.2, width: 235.2, height: 239.3, payload: 26000, cost: 0, enabled: true, custom: true });
      renderRules(); renderTypes(); recalc();
    });

    $('options').addEventListener('click', function (e) {
      var option = e.target.closest('.option[data-mode]');
      if (!option) return;
      state.choice = option.getAttribute('data-mode');
      contIndex = 0;
      recalc();
    });
    $('containers').addEventListener('click', function (e) {
      var card = e.target.closest('.cont');
      if (!card) return;
      contIndex = +card.getAttribute('data-cont');
      renderContainers(); renderStage(true);
    });

    var body = $('order-body');
    body.addEventListener('click', function (e) {
      var row = e.target.closest('tr[data-id]');
      if (!row) return;
      var id = row.getAttribute('data-id'), p = product(id), act = e.target.closest('[data-act]');
      if (act && act.getAttribute('data-act') === 'lock') {
        p.locked = !p.locked; edited();
        renderOrder(); recalc(true);
        return;
      }
      if (act && act.getAttribute('data-act') === 'remove') {
        var index = state.products.indexOf(p), removed = p;
        state.products.splice(index, 1);
        openId = null; edited();
        renderOrder(); recalc();
        toast(removed.name + ' removed.', 'Undo', function () { state.products.splice(index, 0, removed); renderOrder(); recalc(); });
        return;
      }
      if (row.classList.contains('detail')) return;
      if (e.target.closest('input')) return;
      openId = openId === id ? null : id;
      litId = openId;
      renderOrder();
      if (viewer && viewer.ok) viewer.setHighlight(litId);
    });
    function fieldChanged(e) {
      var el = e.target, f = el.getAttribute('data-f');
      var row = el.closest('tr[data-id]');
      if (!f || !row) return;
      var p = product(row.getAttribute('data-id'));
      if (!p) return;
      if (f === 'qty') p.qty = Math.max(0, Math.round(+el.value || 0));
      else if (f === 'maxChange') p.maxChange = el.value === '' ? null : Math.max(0, Math.min(100, +el.value || 0));
      else if (f === 'tippable') p.tippable = el.checked;
      else if (f === 'name') p.name = el.value.trim() || 'Carton';
      else if (f === 'sku') p.sku = el.value.trim();
      else p[f] = Math.max(0, +el.value || 0);
      edited();
      updateRowLabel(p);
      // The same carton in the library follows.
      var item = libraryItem(p.lib);
      if (item && CARTON_FIELDS.indexOf(f) >= 0) item[f] = p[f];
      if ((f === 'l' || f === 'w' || f === 'h') && e.type === 'change' && cartonViewer && cartonViewer.ok && p.id === openId) cartonViewer.showCarton(p);
      recalcSoon();
    }
    body.addEventListener('input', function (e) {
      var f = e.target.getAttribute('data-f');
      if (f === 'qty' || f === 'maxChange') fieldChanged(e);
    });
    body.addEventListener('change', fieldChanged);

    $('btn-add').addEventListener('click', function () {
      var p = D.product({ name: 'New product', l: 60, w: 40, h: 30, weight: 10, qty: 100, tippable: false }, state.library.length);
      var entry = libraryCopy(p);
      state.library.push(entry);
      p.lib = entry.id;
      state.products.push(p);
      openId = p.id; litId = p.id; edited();
      renderOrder(); recalc();
      var name = $('d-name');
      if (name) { name.focus(); name.select(); }
    });
    $('btn-sample').addEventListener('click', function () {
      var before = JSON.stringify(state);
      state = fresh(); openId = null; litId = null; contIndex = 0; needed = null;
      renderRules(); renderTypes(); renderOrder(); recalc();
      toast('Example order loaded.', 'Undo', function () {
        state = JSON.parse(before); openId = null; litId = null; contIndex = 0;
        renderRules(); renderTypes(); renderOrder(); recalc();
      });
    });
    $('lbl-import').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-import').click(); }
    });
    $('file-import').addEventListener('change', function () {
      var file = this.files && this.files[0], input = this;
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          // An untouched example is replaced; otherwise the file is added.
          var replacing = state.example;
          var read = D.parseProducts(String(reader.result), replacing ? 0 : state.library.length);
          if (replacing) { state.library = []; state.products = []; }
          var ordered = 0;
          read.products.forEach(function (p) {
            var item = libraryCopy(p);
            state.library.push(item);
            if (p.qty > 0) { state.products.push(D.orderLine(item, p.qty)); ordered++; }
          });
          state.example = false; state.choice = 'auto'; openId = null; litId = null;
          renderOrder(); recalc();
          var n = read.products.length;
          toast(plural(n, 'product') + ' added to the library. ' +
            (ordered === n ? 'All are on the order.' : ordered ? ordered + ' had a quantity and ' + (ordered === 1 ? 'is' : 'are') + ' on the order.' : 'Drag them onto the container to build a load.') +
            (read.skipped ? ' ' + read.skipped + ' skipped (no size).' : ''));
        } catch (error) {
          toast(error instanceof SyntaxError ? 'That file could not be read. Use the app\'s JSON export, or a CSV with a header row.' : error.message);
        }
        input.value = '';
      };
      reader.onerror = function () { toast('That file could not be opened.'); };
      reader.readAsText(file);
    });
    // The library: drag onto the container (or the order), or press +.
    var list = $('lib-list'), dragging = null;
    list.addEventListener('click', function (e) {
      var card = e.target.closest('.lib-item'), act = e.target.closest('[data-act]');
      if (!card || !act) return;
      var id = card.getAttribute('data-lib');
      if (act.getAttribute('data-act') === 'add') { openAdd(id); return; }
      var index = state.library.indexOf(libraryItem(id)), removed = state.library[index];
      if (index < 0 || lineFor(id)) return;
      state.library.splice(index, 1);
      edited(); renderLibrary(); save();
      toast(removed.name + ' removed from the library.', 'Undo', function () { state.library.splice(index, 0, removed); renderLibrary(); save(); });
    });
    list.addEventListener('dragstart', function (e) {
      var card = e.target.closest ? e.target.closest('.lib-item') : null;
      if (!card) return;
      dragging = card.getAttribute('data-lib');
      try { e.dataTransfer.setData('text/plain', libraryItem(dragging).name); e.dataTransfer.effectAllowed = 'copy'; } catch (ignore) { /* some browsers refuse */ }
      card.classList.add('dragging');
      document.body.classList.add('dragging-product');
    });
    list.addEventListener('dragend', function (e) {
      var card = e.target.closest ? e.target.closest('.lib-item') : null;
      if (card) card.classList.remove('dragging');
      document.body.classList.remove('dragging-product');
      $('stage').classList.remove('drop-over');
      dragging = null;
    });
    [$('stage'), document.querySelector('.order')].forEach(function (target) {
      target.addEventListener('dragover', function (e) {
        if (!dragging) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (ignore) { /* not settable everywhere */ }
        target.classList.add('drop-over');
      });
      target.addEventListener('dragleave', function (e) {
        if (!target.contains(e.relatedTarget)) target.classList.remove('drop-over');
      });
      target.addEventListener('drop', function (e) {
        if (!dragging) return;
        e.preventDefault();
        var id = dragging;
        target.classList.remove('drop-over');
        document.body.classList.remove('dragging-product');
        dragging = null;
        openAdd(id);
      });
    });
    $('add-form').addEventListener('submit', function (e) { e.preventDefault(); confirmAdd(); });
    $('add-cancel').addEventListener('click', function () { $('add-sheet').hidden = true; adding = null; });

    $('btn-copy').addEventListener('click', copyPlan);
    $('btn-copy-close').addEventListener('click', function () { $('copy-sheet').hidden = true; });

    $('in-seq').addEventListener('input', function () {
      var shown = plan(), container = shown && shown.containers[contIndex];
      if (!container) return;
      if (viewer && viewer.ok) viewer.setShown(+this.value);
      $('out-seq').textContent = int(+this.value) + ' of ' + int(container.cartons);
    });
    $('btn-auto').addEventListener('click', function () { if (viewer && viewer.ok) viewer.setAuto(!viewer.auto); });
    $('btn-reset').addEventListener('click', function () { if (viewer && viewer.ok) viewer.resetView(); });
    $('btn-zoom-in').addEventListener('click', function () { if (viewer) viewer.zoomBy(0.8); });
    $('btn-zoom-out').addEventListener('click', function () { if (viewer) viewer.zoomBy(1.25); });
  }

  function setAutoButton(on) {
    var button = $('btn-auto');
    button.setAttribute('aria-pressed', String(!!on));
    button.textContent = on ? 'Turning' : 'Turn';
  }

  function start() {
    cartonHost = document.createElement('div');
    cartonHost.className = 'carton-stage';
    if (window.SPViewer) {
      viewer = new window.SPViewer($('stage'), {
        onAuto: setAutoButton,
        onHover: function (hit) {
          var tip = $('stage-tip');
          if (!hit) { tip.hidden = true; return; }
          var p = product(hit.item.id), shown = plan(), block = shown && shown.containers[contIndex] && shown.containers[contIndex].blocks[hit.item.block];
          tip.innerHTML = '<b>' + esc(p ? p.name : 'Carton') + '</b>' + (hit.item.tier === 'opt2' ? ' · extra' : '') +
            (block ? '<br>Block of ' + int(block.count) + ' · ' + block.nx + ' deep × ' + block.ny + ' across × ' + block.nz + ' high' : '');
          tip.style.left = Math.min(hit.x, $('stage').clientWidth - 200) + 'px';
          tip.style.top = hit.y + 'px';
          tip.hidden = false;
        },
        onPick: function (id) {
          litId = id && id !== litId ? id : null;
          viewer.setHighlight(litId);
          updateOutputs();
        },
      });
      cartonViewer = new window.SPViewer(cartonHost, {});
      setAutoButton(viewer.auto);
    } else {
      $('stage').classList.add('no-webgl');
    }
    renderRules(); renderTypes(); bind(); renderOrder(); recalc();
    // Sprite labels are drawn with the display font; redraw once it has loaded.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { if (openId && cartonViewer && cartonViewer.ok) cartonViewer.showCarton(product(openId)); });
    }
  }

  if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start);
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
