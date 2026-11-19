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

  /** How the page starts: the example products in the library, nothing on order. */
  function fresh() {
    var state = exampleState();
    state.products = [];
    return state;
  }
  /** The example: the same library, with five of its products on order. */
  function exampleState() {
    var sample = D.sampleState();
    return { library: sample.library, products: sample.products, types: D.defaultContainers(), settings: { kpi: 85, maxChange: 5, gap: 5, heavyLow: true, balance: true }, choice: 'auto', example: true };
  }
  var CARTON_FIELDS = ['name', 'sku', 'l', 'w', 'h', 'weight', 'topLoad', 'tippable', 'colour'];
  /** A library product with the same carton as an order line. */
  function libraryCopy(line) {
    var item = { id: D.newId(), qty: 0 };
    CARTON_FIELDS.forEach(function (key) { item[key] = line[key]; });
    return item;
  }
  // Business accounts. Signed in to a business, the library is that
  // business's shared products; otherwise the page works on its own.
  var Cloud = window.SPCloud || { available: false };
  function inBusiness() { return !!(Cloud.available && Cloud.user && Cloud.business && Cloud.paid()); }
  /** Signed in to a business that has not subscribed: the example only. */
  function needsToPay() { return !!(Cloud.available && Cloud.user && Cloud.business && !Cloud.paid()); }
  function businessKey(id) { return 'cubeplanner.business.' + id + '.v1'; }
  function storageKey() { return inBusiness() ? businessKey(Cloud.business.id) : KEY; }
  function blank() {
    return { library: [], products: [], types: D.defaultContainers(), settings: { kpi: 85, maxChange: 5, gap: 5, heavyLow: true, balance: true }, choice: 'auto', example: false };
  }

  function restore(key) {
    try {
      var saved = JSON.parse(window.localStorage.getItem(key || KEY));
      if (saved && Array.isArray(saved.products) && Array.isArray(saved.types) && saved.types.length && saved.settings) {
        // Saved before there was a library: every order line becomes a
        // library product too.
        if (!Array.isArray(saved.library)) saved.library = [];
        // Saved before stacking strength and weight balance: both start on.
        if (saved.settings.heavyLow === undefined) saved.settings.heavyLow = true;
        if (saved.settings.balance === undefined) saved.settings.balance = true;
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
      try { window.localStorage.setItem(storageKey(), JSON.stringify(state)); } catch (ignore) { /* storage is off */ }
    }, 300);
  }
  /** Writes the current order straight away, under the key it belongs to. */
  function saveNow(key) {
    clearTimeout(saveTimer);
    try { window.localStorage.setItem(key, JSON.stringify(state)); } catch (ignore) { /* storage is off */ }
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
    $('in-heavy').checked = !!state.settings.heavyLow;
    $('in-balance').checked = !!state.settings.balance;
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
    var count = state.library.length ? state.library.length + (state.library.length === 1 ? ' product' : ' products') : '';
    $('lib-count').textContent = inBusiness() ? Cloud.business.name + (count ? ' · ' + count : '') : count;
    var mayRemove = !inBusiness() || Cloud.isAdmin();
    $('lib-list').innerHTML = state.library.map(function (item) {
      var line = lineFor(item.id);
      return '<div class="lib-item" draggable="true" data-lib="' + item.id + '" title="Drag onto the container">' +
        '<span class="lib-box">' + cartonDrawing(item.l, item.w, item.h, item.colour) + '</span>' +
        '<span><span class="lib-name">' + esc(item.name) + '</span><span class="lib-size">' + esc(num(item.l) + ' × ' + num(item.w) + ' × ' + num(item.h) + ' cm') + '</span>' +
        (line && line.qty > 0 ? '<span class="lib-in">' + int(line.qty) + ' in the load</span>' : '') + '</span>' +
        '<span class="lib-actions"><button type="button" class="lib-btn" data-act="add" aria-label="Add ' + esc(item.name) + ' to the load" title="Add to the load">+</button>' +
        (line || !mayRemove ? '' : '<button type="button" class="lib-btn remove" data-act="forget" aria-label="Remove ' + esc(item.name) + ' from the library" title="Remove from the library">×</button>') +
        '</span></div>';
    }).join('') || '<p class="lib-empty">' + (inBusiness()
      ? 'No products set up for ' + esc(Cloud.business.name) + ' yet. Import a file from the app, or use Add a product in the order.'
      : 'No products yet. Import a file from the app, or add a product to the order.') + '</p>';
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
  /** How many cartons − and + move a product by: 10, 100, 1,000, or one row of it. */
  function stepFor(p) {
    var step = state.settings.step || 100;
    return step === 'row' ? P.rowSize(p, state.types, state.settings) : +step;
  }

  function renderOrder() {
    var general = state.settings.maxChange;
    var rows = state.products.map(function (p) {
      var open = p.id === openId;
      var html = '<tr class="row' + (open ? ' open' : '') + (p.id === litId ? ' lit' : '') + '" data-id="' + p.id + '">' +
        '<td><button type="button" class="prod" data-act="open" aria-expanded="' + open + '"><i class="dot" style="background:' + esc(p.colour) + '"></i>' +
        '<span><span class="prod-name">' + esc(p.name) + '</span><span class="prod-size">' + esc(sizeText(p)) + '</span></span></button></td>' +
        '<td><span class="qty"><button type="button" class="nudge" data-nudge="-1" aria-label="' + int(stepFor(p)) + ' fewer cartons of ' + esc(p.name) + '" title="−' + int(stepFor(p)) + '">−</button>' +
        '<input class="cell-input" type="number" min="0" step="1" inputmode="numeric" data-f="qty" id="qty-' + p.id + '" value="' + p.qty + '" aria-label="Cartons of ' + esc(p.name) + ' ordered">' +
        '<button type="button" class="nudge" data-nudge="1" aria-label="' + int(stepFor(p)) + ' more cartons of ' + esc(p.name) + '" title="+' + int(stepFor(p)) + '">+</button></span></td>' +
        '<td><button type="button" class="lock" data-act="lock" aria-pressed="' + !!p.locked + '" aria-label="Lock the quantity of ' + esc(p.name) + '" title="' + (p.locked ? 'Locked: this quantity will not change' : 'Lock this quantity') + '">' + (p.locked ? LOCK_ICON : UNLOCK_ICON) + '</button></td>' +
        '<td><input class="cell-input narrow" type="number" min="0" max="100" step="1" inputmode="decimal" data-f="maxChange" id="lim-' + p.id + '" placeholder="' + general + '" value="' + (p.maxChange === null || p.maxChange === undefined ? '' : p.maxChange) + '"' + (p.locked ? ' disabled' : '') + ' aria-label="Limit for ' + esc(p.name) + ', per cent"></td>' +
        '<td class="planned" data-out="planned"></td>' +
        '<td class="row-end"><button type="button" class="row-remove" data-act="remove" aria-label="Remove ' + esc(p.name) + ' from the order" title="Remove from the order">−</button></td></tr>';
      if (open) {
        html += '<tr class="detail" data-id="' + p.id + '"><td colspan="6"><div class="detail-inner">' +
          '<div id="carton-slot"></div>' +
          '<div class="fields">' +
          field('wide', 'Name', 'name', 'text', p.name) + field('', 'SKU', 'sku', 'text', p.sku) +
          field('', 'Length cm', 'l', 'number', p.l) + field('', 'Width cm', 'w', 'number', p.w) + field('', 'Height cm', 'h', 'number', p.h) +
          field('', 'Weight kg', 'weight', 'number', p.weight) +
          field('wide', 'Max weight on top kg', 'topLoad', 'number', p.topLoad).replace('<input', '<input placeholder="No limit" title="The most weight one carton can carry on top of it. Leave empty for no limit of its own; 0 means nothing may be stacked on it."') +
          '<div class="field full"><label class="check" for="d-tip" style="font:inherit;letter-spacing:0;text-transform:none;color:inherit"><input type="checkbox" id="d-tip" data-f="tippable"' + (p.tippable ? ' checked' : '') + '>May be loaded on its side or end</label></div>' +
          '<div class="detail-foot"><span id="d-vol"></span><button type="button" class="btn quiet small danger" data-act="remove">Remove product</button></div>' +
          '</div></div></td></tr>';
      }
      return html;
    }).join('');
    $('order-body').innerHTML = rows || '<tr class="empty"><td colspan="6"><div class="order-empty">' +
      '<strong>The order is empty</strong>' +
      '<span>Drag products in from the library on the left, or press + beside one.</span>' +
      (inBusiness() ? '' : '<button type="button" class="btn solid" data-example="1">Load the example order</button>' +
        '<span class="hint">Five flat-pack products, to see how it works.</span>') +
      '</div></td></tr>';
    document.querySelector('.order-table thead').hidden = !rows;
    $('step-bar').hidden = !rows;
    Array.prototype.forEach.call(document.querySelectorAll('#step-bar .step'), function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-step') === String(state.settings.step || 100)));
    });
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
    function changed(by, of) {
      if (!by) return '';
      return '<small class="change ' + (by > 0 ? 'up' : 'down') + '">' + (by > 0 ? '+' : '−') + int(Math.abs(by)) +
        (of ? ' (' + signedPct(by / Math.max(1, of)) + ')' : '') + '</small>';
    }
    Array.prototype.forEach.call(document.querySelectorAll('#order-body tr.row'), function (row) {
      var id = row.getAttribute('data-id'), p = product(id), line = lines[id];
      var planned = row.querySelector('[data-out="planned"]');
      row.classList.toggle('lit', id === litId);
      if (oversize.indexOf(id) >= 0) { planned.innerHTML = '—<small class="change down">Too big</small>'; return; }
      if (!line) { planned.textContent = p && p.qty > 0 ? '—' : '0'; return; }
      planned.innerHTML = int(line.planned) + changed(line.change, line.ordered);
    });
    var foot = $('order-foot');
    if (!shown || !shown.lines || !state.products.length) { foot.innerHTML = ''; }
    else {
      foot.innerHTML = '<tr><td>' + m3(shown.orderedVolume) + ' m³ ordered · ' + m3(shown.plannedVolume) + ' m³ planned</td>' +
        '<td>' + int(shown.orderedCartons) + '</td><td></td><td></td><td>' + int(shown.plannedCartons) +
        changed(shown.plannedCartons - shown.orderedCartons, 0) + '</td><td></td></tr>';
    }
    var open = openId && product(openId), volume = $('d-vol');
    if (open && volume) {
      var each = open.l * open.w * open.h / 1e6;
      volume.textContent = each.toFixed(3) + ' m³ a carton · ' + (each * open.qty).toFixed(1) + ' m³ ordered';
    }
  }

  // ---------- options and advice ----------
  /** The three options as one row of switches; the detail of the one on screen goes on a line beneath. */
  function renderOptions() {
    var kpi = state.settings.kpi;
    $('options').innerHTML = MODES.map(function (mode) {
      var key = mode[0], o = result ? result[key] : null;
      if (!o || !o.feasible) {
        var why = !result || !result.asOrdered ? 'Nothing to load yet'
          : key === 'trim' ? (result.asOrdered.containers.length < 2 ? 'There is only one container, so nothing to trim' : 'Not possible within your limits')
          : 'Not possible';
        return '<button type="button" class="option" disabled title="' + why + '"><span class="state none">–</span><span class="option-text"><span class="option-name">' + mode[1] + '</span><span class="option-count"><small>' + (key === 'trim' ? 'not possible' : 'nothing to load') + '</small></span></span></button>';
      }
      var n = o.containers.length;
      var verdict = o.meetsKpi ? 'Every container is ' + kpi + '% full or more' : 'A container is under ' + kpi + '%';
      return '<button type="button" class="option" data-mode="' + key + '" aria-pressed="' + (key === shownMode) + '" title="' + verdict + '">' +
        '<span class="state ' + (o.meetsKpi ? 'good">✓' : 'bad">✕') + '</span>' +
        '<span class="option-text"><span class="option-name">' + mode[1] + '</span>' +
        '<span class="option-count">' + n + '<small> ' + (n === 1 ? 'container' : 'containers') + '</small></span></span>' +
        (key === result.recommended && result.anyPass ? '<span class="tag pick">Suggested</span>' : '') + '</button>';
    }).join('');
    var shown = plan(), summary = '';
    if (shown && shown.feasible) {
      var diff = shown.plannedCartons - shown.orderedCartons;
      summary = 'Emptiest container ' + pct(shown.minFill) + ' full · ' +
        (diff === 0 && shown.productsChanged === 0 ? 'no changes to the order'
          : (diff > 0 ? '+' : '−') + int(Math.abs(diff)) + ' cartons (' + signedPct(shown.changeFraction) + ' by volume)');
    }
    $('option-summary').textContent = summary;
  }
  var neededTimer, needed = null;
  function renderAdvice() {
    var el = $('advice'), kpi = state.settings.kpi;
    el.className = 'advice';
    if (!result || !result.asOrdered) {
      el.textContent = result && result.oversize.length ? 'None of these cartons fits in the containers you have allowed.' : '';
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
    var shown = plan(), uneven = [];
    if (shown) shown.containers.forEach(function (c, i) { if (c.balance && !c.balance.light && !c.balance.ok) uneven.push(i + 1); });
    if (uneven.length) {
      text += ' Container' + (uneven.length === 1 ? ' ' + uneven[0] + ' is' : 's ' + uneven.join(', ') + ' are') + ' out of balance' +
        (state.settings.balance ? ': the cartons only fit one way, so it could not be evened out.' : '. Switch on “Balance the weight” to rearrange.');
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
    return JSON.stringify([state.settings, state.types, state.products.map(function (p) { return [p.l, p.w, p.h, p.weight, p.qty, p.locked, p.maxChange, p.tippable, p.topLoad]; })]);
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
      var facts = [m3(c.volume) + ' of ' + m3(c.capacity) + ' m³'];
      if (c.weight > 0) facts.push(int(c.weight) + (c.type.payload > 0 ? ' of ' + int(c.type.payload) : '') + ' kg' + (byWeight ? ' (at limit)' : ''));
      facts.push(plural(c.cartons, 'carton'));
      if (c.type.cost > 0) facts.push('$' + int(c.type.cost));
      var bal = balanceText(c);
      if (bal) facts.push('<span class="' + (bal.bad ? 'bal bad' : 'bal') + '" title="' + esc(bal.title) + '">' + esc(bal.short) + '</span>');
      var picture = thumbs[thumbKey(c)];
      return '<button type="button" class="cont" data-cont="' + i + '" aria-pressed="' + (i === contIndex) + '">' +
        '<span class="cont-pic" data-thumb="' + i + '">' + (picture ? '<img alt="" src="' + picture + '">' : '') + '</span>' +
        '<span class="cont-head"><span class="cont-name">' + (i + 1) + ' · ' + esc(c.type.code || c.type.name) + '</span>' +
        '<span class="cont-fill ' + (ok ? 'good' : 'bad') + '">' + pct(c.use) + '</span></span>' +
        '<span class="bar" title="Minimum ' + kpi + '%"><span class="bar-fill ' + (ok ? '' : 'bad') + '" style="width:' + Math.min(100, c.use * 100).toFixed(1) + '%"></span><span class="bar-mark" style="left:' + kpi + '%"></span></span>' +
        '<span class="cont-facts">' + facts.join(' · ') + '</span>' +
        '<span class="mix">' + mix + '</span></button>';
    }).join('');
    drawThumbsSoon();
  }

  /**
   A container's weight balance in words. Shares are front (closed end)
   to doors, and side to side; out of balance is more than 60% in one half.
  */
  function balanceText(c) {
    var b = c.balance;
    if (!b) return null;
    function pair(share) { var a = Math.round(share * 100); return a + ' / ' + (100 - a); }
    var limit = Math.round(P.HALF_LIMIT * 100), problems = [];
    if (!b.light) {
      if (!b.lengthOk) problems.push(b.front > 0.5 ? 'front-heavy ' + pair(b.front) : 'door-heavy ' + pair(b.front));
      if (!b.sideOk) problems.push('heavy to one side ' + pair(Math.max(b.left, 1 - b.left)));
    }
    var title = Math.round(b.front * 100) + '% of the weight is in the front half (the closed end), ' + (100 - Math.round(b.front * 100)) + '% in the door half; ' +
      pair(Math.max(b.left, 1 - b.left)) + ' from side to side. ' +
      (b.light ? 'This load is too light for its balance to matter.' : 'No half should carry more than ' + limit + '%.') +
      (b.unweighed ? ' ' + plural(b.unweighed, 'carton') + ' with no weight left out.' : '');
    return {
      bad: problems.length > 0,
      short: problems.length ? problems.join(', ') : 'balance ' + pair(b.front) + (b.unweighed ? '*' : ''),
      long: problems.length ? 'Out of balance: ' + problems.join(', ') + ' (no half should carry more than ' + limit + '%)'
        : 'Weight balance: ' + pair(b.front) + ' front to doors, ' + pair(Math.max(b.left, 1 - b.left)) + ' side to side' + (b.light ? '' : ' (within ' + limit + ' / ' + (100 - limit) + ')'),
      title: title,
    };
  }

  // A small 3D picture of each container for its card. Drawn one at a
  // time once the page is idle, and kept until the load changes.
  var thumbs = {}, thumbViewer = null, thumbTimer;
  function thumbKey(c) {
    return c.type.id + '|' + state.settings.gap + '|' + c.blocks.map(function (b) {
      var p = product(b.id);
      return [p ? p.colour : '', b.x, b.y, b.z, b.a, b.b, b.c, b.nx, b.ny, b.nz, b.tier].join(',');
    }).join(';');
  }
  function drawThumbsSoon() {
    clearTimeout(thumbTimer);
    if (!window.SPViewer) return;
    thumbTimer = setTimeout(function draw() {
      var shown = plan();
      if (!shown) return;
      if (!thumbViewer) thumbViewer = new window.SPViewer(document.createElement('div'), { still: { width: 640, height: 250 } });
      if (!thumbViewer.ok) return;
      var colours = {};
      state.products.forEach(function (p) { colours[p.id] = p.colour; });
      for (var i = 0; i < shown.containers.length; i++) {
        var key = thumbKey(shown.containers[i]);
        if (thumbs[key]) continue;
        // Keep only what is on screen: old loads are not coming back.
        if (Object.keys(thumbs).length > 60) thumbs = {};
        thumbs[key] = thumbViewer.picture(shown.containers[i], colours, state.settings.gap);
        var slot = document.querySelector('.cont-pic[data-thumb="' + i + '"]');
        if (slot && thumbs[key]) slot.innerHTML = '<img alt="" src="' + thumbs[key] + '">';
        thumbTimer = setTimeout(draw, 0);     // the next one, after the page has had a turn
        return;
      }
    }, 220);
  }

  function renderStage(keepView) {
    var shown = plan(), empty = $('stage-empty');
    var container = shown && shown.containers[contIndex];
    $('stage-foot').hidden = !container;
    if (!container) {
      empty.hidden = false;
      empty.textContent = 'Your containers appear here as you add products to the order.';
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

  // ---------- business accounts ----------
  function cloudFailed(error) {
    toast('That could not be saved for your business: ' + (error && error.message ? error.message : 'no connection') + '.');
  }

  /** Sends a changed product to the business a moment after the last edit. */
  var shareTimers = {};
  function shareSoon(item) {
    if (!inBusiness()) return;
    clearTimeout(shareTimers[item.id]);
    shareTimers[item.id] = setTimeout(function () {
      delete shareTimers[item.id];
      if (inBusiness() && libraryItem(item.id)) Cloud.updateProduct(item).catch(cloudFailed);
    }, 700);
  }

  function renderAccount() {
    var el = $('account');
    if (!Cloud.available) { el.hidden = true; return; }
    if (!Cloud.user) {
      el.innerHTML = '<button type="button" class="btn quiet" data-account="signin">Sign in</button>';
    } else if (Cloud.business) {
      el.innerHTML = '<button type="button" class="btn quiet" data-account="team" title="' + esc(Cloud.user.email) + '"><span class="who">' + esc(Cloud.business.name) + '</span></button>' +
        (needsToPay() ? '<button type="button" class="btn solid" data-account="pay">Subscribe</button>' : '') +
        '<button type="button" class="btn quiet" data-account="signout">Sign out</button>';
    } else {
      el.innerHTML = '<button type="button" class="btn quiet" data-account="signout">Sign out</button>';
    }
    $('btn-sample').hidden = inBusiness();
  }

  function resetView() {
    openId = null; litId = null; contIndex = 0; needed = null;
    renderRules(); renderTypes(); renderOrder(); recalc();
  }

  /** The business's products become the library; the order follows them. */
  function applyLibrary(items) {
    items.forEach(function (item, index) { if (!item.colour) item.colour = D.COLOURS[index % D.COLOURS.length]; });
    // Until the shared library can hold stacking limits, the ones set
    // in this browser are kept here.
    if (!Cloud.stacking) {
      var limits = {};
      state.library.forEach(function (item) { if (item.topLoad !== null && item.topLoad !== undefined) limits[item.id] = item.topLoad; });
      items.forEach(function (item) { item.topLoad = limits[item.id] === undefined ? null : limits[item.id]; });
    }
    state.library = items;
    // A product a colleague has changed is changed here too; one they
    // have removed leaves the order.
    state.products = state.products.filter(function (line) { return !!libraryItem(line.lib); });
    state.products.forEach(function (line) {
      var item = libraryItem(line.lib);
      CARTON_FIELDS.forEach(function (key) { line[key] = item[key]; });
    });
    openId = null;
    renderOrder(); recalc();
  }

  /** Which set of data is on screen: a business's id, or null for this browser's own. */
  var showing = null;
  function onCloudChange() {
    renderAccount();
    if (Cloud.user) $('signin-sheet').hidden = true;
    var needsBusiness = !!(Cloud.user && Cloud.ready && !Cloud.business);
    if (needsBusiness && $('business-sheet').hidden) {
      $('business-hint').textContent = 'You are signed in as ' + Cloud.user.email + ', and that address does not belong to a business yet. Create one here; you can then invite your colleagues. If your business is already set up, ask its admin to invite this address instead.';
      $('business-note').hidden = true;
    }
    $('business-sheet').hidden = !needsBusiness;
    // Signed in but not subscribed: say so once, over the example.
    if (needsToPay() && !payShown) { payShown = true; openPay(); }
    if (!needsToPay()) $('pay-sheet').hidden = true;
    var next = inBusiness() ? Cloud.business.id : null;
    if (next === showing) return;
    // Put away what is on screen under its own key before swapping.
    saveNow(showing ? businessKey(showing) : KEY);
    showing = next;
    if (!next) {
      state = restore(KEY) || fresh();
      resetView();
      return;
    }
    state = restore(businessKey(next)) || blank();
    state.example = false;
    resetView();
    Cloud.products().then(function (items) {
      if (showing === next) applyLibrary(items);
    }).catch(function (error) { toast('Your business\'s products could not be loaded: ' + error.message + '.'); });
  }

  var payShown = false;
  function openPay() {
    var admin = Cloud.isAdmin();
    var price = (window.CUBEPLANNER_CONFIG && window.CUBEPLANNER_CONFIG.planText) || '';
    $('pay-title').textContent = 'Subscribe to use CubePlanner for ' + Cloud.business.name;
    $('pay-text').textContent = (Cloud.business.plan === 'canceled'
      ? 'This business\'s subscription has ended. '
      : 'You are signed in, and the example is free to explore. ') +
      'Planning loads with your own products needs a subscription' + (price ? ': ' + price + '.' : '.') +
      (admin ? '' : ' Ask an admin of ' + Cloud.business.name + ' to subscribe; this screen will open up for you as soon as they do.');
    $('pay-go').hidden = !admin;
    $('pay-go').disabled = false;
    note('pay-note', '');
    $('pay-sheet').hidden = false;
  }

  /** Back from Stripe: the plan is recorded a moment later, so look a few times. */
  function awaitPlan() {
    var tries = 0;
    toast('Thank you. Switching your business on…');
    (function look() {
      tries++;
      Cloud.recheck().then(function () {
        if (Cloud.business && Cloud.paid()) { toast(Cloud.business.name + ' is subscribed. Your products are ready.'); return; }
        if (tries < 12) setTimeout(look, 2500);
        else toast('The payment went through but has not shown up here yet. Reload the page in a minute.');
      }).catch(function () { if (tries < 12) setTimeout(look, 2500); });
    })();
  }

  function note(id, message, bad) {
    var el = $(id);
    el.hidden = !message;
    el.textContent = message || '';
    el.className = 'sheet-note' + (bad ? ' bad' : '');
  }

  function renderTeam() {
    if (!inBusiness()) { $('team-sheet').hidden = true; return; }
    $('team-title').textContent = Cloud.business.name;
    $('team-hint').textContent = 'You are signed in as ' + Cloud.user.email + '. Everyone listed here sees the products set up for this business.';
    $('invite-form').hidden = !Cloud.isAdmin();
    var several = Cloud.businesses.length > 1;
    $('team-switch-field').hidden = !several;
    if (several) {
      $('team-switch').innerHTML = Cloud.businesses.map(function (b) {
        return '<option value="' + esc(b.id) + '"' + (b.id === Cloud.business.id ? ' selected' : '') + '>' + esc(b.name) + '</option>';
      }).join('');
    }
    $('team-billing').hidden = !(Cloud.isAdmin() && Cloud.business.billed);
    $('team-list').innerHTML = '<div class="team-row"><span class="role">Loading…</span></div>';
    var business = Cloud.business.id;
    Cloud.team().then(function (team) {
      if (!inBusiness() || Cloud.business.id !== business) return;
      var admin = Cloud.isAdmin();
      var rows = team.members.map(function (m) {
        var me = m.user_id === Cloud.user.id;
        return '<div class="team-row"><span class="email">' + esc(m.email || 'Unknown') + (me ? ' (you)' : '') + '</span><span class="side"><span class="role">' + (m.role === 'admin' ? 'Admin' : 'Member') + '</span>' +
          (admin || me ? '<button type="button" class="link" data-remove="' + esc(m.user_id) + '">' + (me ? 'Leave' : 'Remove') + '</button>' : '') + '</span></div>';
      });
      team.invitations.forEach(function (i) {
        rows.push('<div class="team-row"><span class="email">' + esc(i.email) + '</span><span class="side"><span class="role">Invited · joins when they sign in</span>' +
          '<button type="button" class="link" data-cancel="' + esc(i.id) + '">Cancel</button></span></div>');
      });
      $('team-list').innerHTML = rows.join('');
    }).catch(function (error) { note('team-note', error.message, true); });
  }

  function bindAccounts() {
    if (!Cloud.available) return;
    $('account').addEventListener('click', function (e) {
      var button = e.target.closest('[data-account]');
      if (!button) return;
      var what = button.getAttribute('data-account');
      if (what === 'signin') {
        note('signin-note', '');
        $('signin-send').disabled = false;
        $('signin-go').disabled = false;
        $('signin-sheet').hidden = false;
        $('signin-email').focus();
      } else if (what === 'signout') {
        Cloud.signOut().catch(cloudFailed);
      } else if (what === 'pay') {
        openPay();
      } else {
        note('team-note', '');
        $('team-sheet').hidden = false;
        renderTeam();
      }
    });
    $('signin-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('signin-email').value.trim(), password = $('signin-password').value;
      if (!email) return;
      if (!password) { note('signin-note', 'Enter your password, or use the emailed link below.', true); return; }
      $('signin-go').disabled = true;
      note('signin-note', 'Signing in…');
      Cloud.signIn(email, password).then(function () {
        $('signin-password').value = '';
        $('signin-go').disabled = false;
      }).catch(function (error) {
        $('signin-go').disabled = false;
        note('signin-note', /invalid login/i.test(error.message)
          ? 'That email and password do not match. If you have not set a password yet, use the emailed link below.'
          : 'Sign-in failed: ' + error.message, true);
      });
    });
    $('signin-send').addEventListener('click', function () {
      var email = $('signin-email').value.trim();
      if (!email) { note('signin-note', 'Enter your email first.', true); $('signin-email').focus(); return; }
      $('signin-send').disabled = true;
      note('signin-note', 'Sending…');
      Cloud.sendLink(email).then(function () {
        note('signin-note', 'A sign-in link is on its way to ' + email + '. Open it on this device and you will come back here signed in. It can take a minute to arrive.');
      }).catch(function (error) {
        $('signin-send').disabled = false;
        note('signin-note', 'The link could not be sent: ' + error.message, true);
      });
    });
    $('password-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var password = $('new-password').value;
      if (password.length < 8) { note('team-note', 'Use at least 8 characters.', true); return; }
      Cloud.setPassword(password).then(function () {
        $('new-password').value = '';
        note('team-note', 'Password saved. Next time, sign in with ' + Cloud.user.email + ' and this password, here or in the iPhone app.');
      }).catch(function (error) { note('team-note', 'The password could not be saved: ' + error.message, true); });
    });
    $('signin-cancel').addEventListener('click', function () { $('signin-sheet').hidden = true; });
    $('business-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('business-name').value.trim();
      if (!name) return;
      note('business-note', 'Creating…');
      Cloud.createBusiness(name).catch(function (error) { note('business-note', error.message, true); });
    });
    $('business-signout').addEventListener('click', function () { Cloud.signOut().catch(cloudFailed); });
    $('team-close').addEventListener('click', function () { $('team-sheet').hidden = true; });
    $('pay-later').addEventListener('click', function () { $('pay-sheet').hidden = true; });
    $('pay-go').addEventListener('click', function () {
      $('pay-go').disabled = true;
      note('pay-note', 'Opening the secure payment page…');
      Cloud.billing('checkout').then(function (url) { window.location.href = url; }).catch(function (error) {
        $('pay-go').disabled = false;
        note('pay-note', error.message, true);
      });
    });
    $('team-billing').addEventListener('click', function () {
      note('team-note', 'Opening your subscription…');
      Cloud.billing('portal').then(function (url) { window.location.href = url; }).catch(function (error) { note('team-note', error.message, true); });
    });
    $('team-switch').addEventListener('change', function () { Cloud.choose(this.value); renderTeam(); });
    $('invite-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('invite-email').value.trim().toLowerCase();
      if (!email) return;
      Cloud.invite(email, $('invite-role').value).then(function () {
        $('invite-email').value = '';
        note('team-note', email + ' is invited. Ask them to open this site and sign in with that address; they join ' + Cloud.business.name + ' as soon as they do.');
        renderTeam();
      }).catch(function (error) {
        note('team-note', /duplicate|unique/i.test(error.message) ? 'That address has already been invited.' : error.message, true);
      });
    });
    $('team-list').addEventListener('click', function (e) {
      var remove = e.target.closest('[data-remove]'), cancel = e.target.closest('[data-cancel]');
      if (cancel) {
        Cloud.cancelInvitation(cancel.getAttribute('data-cancel')).then(renderTeam).catch(function (error) { note('team-note', error.message, true); });
      } else if (remove) {
        var person = remove.getAttribute('data-remove'), me = person === Cloud.user.id;
        Cloud.removeMember(person).then(function () {
          if (me) { $('team-sheet').hidden = true; window.location.reload(); } else renderTeam();
        }).catch(function (error) { note('team-note', error.message, true); });
      }
    });
  }

  // ---------- copy ----------
  /** The container on screen as a short note anyone can read: what it is, how full, and what goes in it. */
  function planText() {
    var shown = plan(), c = shown && shown.containers[contIndex];
    if (!c) return '';
    var today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    var out = [
      'CubePlanner load plan · ' + today,
      'Container ' + (contIndex + 1) + ' of ' + shown.containers.length + ': ' + c.type.name,
      '',
      pct(c.use) + ' full · ' + m3(c.volume) + ' of ' + m3(c.capacity) + ' m³' +
        (c.weight > 0 ? ' · ' + int(c.weight) + ' kg' + (c.type.payload > 0 ? ' of ' + int(c.type.payload) + ' kg' : '') : '') +
        ' · ' + plural(c.cartons, 'carton'),
    ];
    var bal = balanceText(c);
    if (bal) out.push(bal.long);
    out.push('', 'Load:');
    Object.keys(c.counts).map(function (id) { return { p: product(id) || {}, n: c.counts[id] }; })
      .sort(function (a, b) { return b.n - a.n; })
      .forEach(function (row) {
        var p = row.p;
        out.push('  ' + int(row.n) + ' × ' + (p.name || 'Product') + (p.sku ? ' (' + p.sku + ')' : '') +
          (p.l ? ' — ' + num(p.l) + ' × ' + num(p.w) + ' × ' + num(p.h) + ' cm' : '') +
          (p.weight > 0 ? ', ' + int(row.n * p.weight) + ' kg' : ''));
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
      navigator.clipboard.writeText(text).then(function () { toast('Container ' + (contIndex + 1) + ' copied. Paste it into an email or a message.'); }, fallback);
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
    $('in-heavy').addEventListener('change', function () { state.settings.heavyLow = this.checked; recalc(true); });
    $('in-balance').addEventListener('change', function () { state.settings.balance = this.checked; recalc(true); });

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
        toast(removed.name + ' removed from the order.', 'Undo', function () { state.products.splice(index, 0, removed); renderOrder(); recalc(); });
        return;
      }
      if (row.classList.contains('detail')) return;
      if (e.target.closest('input') || e.target.closest('.nudge')) return;
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
      else if (f === 'topLoad') p.topLoad = el.value === '' ? null : Math.max(0, +el.value || 0);
      else if (f === 'name') p.name = el.value.trim() || 'Carton';
      else if (f === 'sku') p.sku = el.value.trim();
      else p[f] = Math.max(0, +el.value || 0);
      edited();
      updateRowLabel(p);
      // The same carton in the library follows.
      var item = libraryItem(p.lib);
      if (item && CARTON_FIELDS.indexOf(f) >= 0) {
        item[f] = p[f];
        shareSoon(item);
      }
      if ((f === 'l' || f === 'w' || f === 'h') && e.type === 'change' && cartonViewer && cartonViewer.ok && p.id === openId) cartonViewer.showCarton(p);
      recalcSoon();
    }
    // − and + beside a quantity: one step per press, repeating while held.
    function nudge(button) {
      var row = button.closest('tr[data-id]'), p = row && product(row.getAttribute('data-id'));
      if (!p) return;
      p.qty = Math.max(0, p.qty + (+button.getAttribute('data-nudge')) * stepFor(p));
      row.querySelector('[data-f="qty"]').value = p.qty;
      edited();
      recalcSoon();
    }
    var holdTimer = null, holdRepeat = null;
    function stopHold() { clearTimeout(holdTimer); clearInterval(holdRepeat); holdTimer = holdRepeat = null; }
    body.addEventListener('pointerdown', function (e) {
      var button = e.target.closest('.nudge');
      if (!button) return;
      e.preventDefault();
      nudge(button);
      stopHold();
      holdTimer = setTimeout(function () {
        holdRepeat = setInterval(function () {
          if (!document.body.contains(button)) { stopHold(); return; }
          nudge(button);
        }, 110);
      }, 420);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) { body.addEventListener(name, stopHold, true); });
    window.addEventListener('blur', stopHold);
    body.addEventListener('click', function (e) {
      // From the keyboard there is no press-and-hold: one step per key press.
      var button = e.target.closest('.nudge');
      if (button && e.detail === 0) nudge(button);
    });
    $('step-bar').addEventListener('click', function (e) {
      var button = e.target.closest('.step');
      if (!button) return;
      var value = button.getAttribute('data-step');
      state.settings.step = value === 'row' ? 'row' : +value;
      renderOrder();
      save();
    });

    body.addEventListener('input', function (e) {
      var f = e.target.getAttribute('data-f');
      if (f === 'qty' || f === 'maxChange') fieldChanged(e);
    });
    body.addEventListener('change', fieldChanged);

    $('btn-add').addEventListener('click', function () {
      if (inBusiness()) {
        // The product is created for the whole business first.
        var draft = D.product({ name: 'New product', l: 60, w: 40, h: 30, weight: 10, qty: 0, tippable: false }, state.library.length);
        Cloud.addProducts([draft], 'manual').then(function (saved) {
          state.library.push(saved[0]);
          var line = D.orderLine(saved[0], 100);
          state.products.push(line);
          openId = line.id; litId = line.id;
          renderOrder(); recalc();
          var field = $('d-name');
          if (field) { field.focus(); field.select(); }
        }).catch(cloudFailed);
        return;
      }
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
    function loadExample() {
      if (inBusiness()) return;
      var before = JSON.stringify(state);
      state = exampleState(); openId = null; litId = null; contIndex = 0; needed = null;
      renderRules(); renderTypes(); renderOrder(); recalc();
      toast('Example order loaded.', 'Undo', function () {
        state = JSON.parse(before); openId = null; litId = null; contIndex = 0;
        renderRules(); renderTypes(); renderOrder(); recalc();
      });
    }
    $('btn-sample').addEventListener('click', loadExample);
    body.addEventListener('click', function (e) {
      if (e.target.closest('[data-example]')) loadExample();
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
          var replacing = state.example && !inBusiness();
          var read = D.parseProducts(String(reader.result), replacing ? 0 : state.library.length);
          if (inBusiness()) {
            // Into the business's shared products; rows with a quantity also go on this order.
            Cloud.addProducts(read.products, 'import').then(function (saved) {
              var onOrder = 0;
              saved.forEach(function (item, index) {
                state.library.push(item);
                if (read.products[index] && read.products[index].qty > 0) { state.products.push(D.orderLine(item, read.products[index].qty)); onOrder++; }
              });
              state.choice = 'auto'; openId = null; litId = null;
              renderOrder(); recalc();
              toast(plural(saved.length, 'product') + ' added for ' + Cloud.business.name + '.' + (onOrder ? ' ' + onOrder + ' with a quantity ' + (onOrder === 1 ? 'is' : 'are') + ' on the order.' : '') +
                (read.skipped ? ' ' + read.skipped + ' skipped (no size).' : ''));
            }).catch(cloudFailed);
            input.value = '';
            return;
          }
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
      if (inBusiness()) {
        // Removed for everyone in the business.
        Cloud.deleteProduct(id).then(function () {
          state.library.splice(index, 1);
          renderLibrary(); save();
          toast(removed.name + ' removed for everyone at ' + Cloud.business.name + '.', 'Undo', function () {
            var back = {};
            Object.keys(removed).forEach(function (key) { back[key] = removed[key]; });
            back.keepId = true;
            Cloud.addProducts([back], 'manual').then(function (saved) { state.library.splice(index, 0, saved[0]); renderLibrary(); save(); }).catch(cloudFailed);
          });
        }).catch(cloudFailed);
        return;
      }
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
      document.querySelector('.order').classList.remove('drop-over');
      dragging = null;
    });
    [document.querySelector('.order')].forEach(function (target) {
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

    bindAccounts();
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
    if (Cloud.available) {
      $('account').hidden = false;
      renderAccount();
      Cloud.start(onCloudChange);
      // Returning from Stripe's payment page.
      if (/[?&]billing=done/.test(window.location.search)) {
        try { window.history.replaceState(null, '', window.location.pathname); } catch (ignore) { /* address stays as it is */ }
        setTimeout(awaitPlan, 1500);
      }
    }
    // Sprite labels are drawn with the display font; redraw once it has loaded.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { if (openId && cartonViewer && cartonViewer.ok) cartonViewer.showCarton(product(openId)); });
    }
  }

  if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start);
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
