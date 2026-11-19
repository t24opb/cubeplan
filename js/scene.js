/*
 CubePlanner — the 3D views (three.js).

 One Viewer draws either a loaded container or a single carton. The
 container is drawn the way the app draws it: steel-blue frame, timber
 floor, closed far end, open at the doors. Its walls are only drawn from
 the inside, so the load is never hidden behind a wall as it turns.

 Page coordinates → 3D: container length → X, width → Z, up → Y; metres.
*/
(function (root) {
  'use strict';
  var T = root.THREE;

  var STEEL = 0x33618f, STEEL_DARK = 0x284d73, FLOOR = 0x6b5742;
  var reducedMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function labelSprite(text) {
    var k = 2, canvas = document.createElement('canvas');
    canvas.width = 288 * k; canvas.height = 80 * k;
    var g = canvas.getContext('2d');
    g.font = '600 ' + (40 * k) + 'px "Barlow Semi Condensed", "Arial Narrow", Arial, sans-serif';
    var w = Math.min(canvas.width - 4, g.measureText(text).width + 40 * k), h = 60 * k;
    var x = (canvas.width - w) / 2, y = (canvas.height - h) / 2, r = h / 2;
    g.fillStyle = 'rgba(16, 24, 34, 0.9)';
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, canvas.width / 2, canvas.height / 2 + 2 * k);
    var texture = new T.CanvasTexture(canvas);
    var sprite = new T.Sprite(new T.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.renderOrder = 10;
    sprite.userData.aspect = canvas.width / canvas.height;
    return sprite;
  }

  /** Vertical ribs, like a container's corrugated wall. */
  function ribTexture(repeat) {
    var canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 4;
    var g = canvas.getContext('2d');
    var grad = g.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.35, '#ffffff');
    grad.addColorStop(0.5, '#c4c9cf'); grad.addColorStop(0.85, '#dfe3e7'); grad.addColorStop(1, '#ffffff');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 4);
    var texture = new T.CanvasTexture(canvas);
    texture.wrapS = T.RepeatWrapping; texture.wrapT = T.RepeatWrapping;
    texture.repeat.set(repeat, 1);
    return texture;
  }

  function Viewer(host, options) {
    this.host = host;
    this.options = options || {};
    this.ok = false;
    if (!T) { host.classList.add('no-webgl'); return; }
    try {
      // A viewer that only makes still pictures keeps what it drew, so
      // the picture can be read back.
      this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!this.options.still });
    } catch (error) {
      host.classList.add('no-webgl');
      return;
    }
    this.ok = true;
    var renderer = this.renderer;
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.domElement.className = 'stage-canvas';
    host.insertBefore(renderer.domElement, host.firstChild);

    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(30, 1, 0.05, 500);
    this.content = new T.Group();
    this.scene.add(this.content);
    this.scene.add(new T.AmbientLight(0xffffff, 0.74));
    this.sun = new T.DirectionalLight(0xffffff, 0.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.view = { az: 0.62, el: 0.5, dist: 10, target: new T.Vector3(), home: null };
    this.auto = this.options.auto !== false && !reducedMotion;
    this.mode = null;
    this.visible = true;
    this.pointers = {};
    this.raycaster = new T.Raycaster();
    this._tick = this._tick.bind(this);
    if (this.options.still) {
      // No turning, no mouse: a fixed size, drawn only when asked.
      this.auto = false;
      renderer.setPixelRatio(1);
      renderer.setSize(this.options.still.width, this.options.still.height, false);
      this.camera.aspect = this.options.still.width / this.options.still.height;
      this.camera.updateProjectionMatrix();
      return;
    }
    this._bind();
    this._resize();
  }

  /** A still picture of a loaded container, as an image address. Only for a viewer made with `still`. */
  Viewer.prototype.picture = function (container, colours, gap) {
    if (!this.ok || !this.options.still) return null;
    this.showContainer(container, colours, gap, false);
    if (this._frame) { root.cancelAnimationFrame(this._frame); this._frame = 0; }
    this.view.homeDist *= 0.86; this.view.dist = this.view.homeDist;
    this.view.target.y = this.size.y * 0.5;
    this._tick(0);
    try { return this.renderer.domElement.toDataURL('image/png'); } catch (error) { return null; }
  };

  Viewer.prototype._bind = function () {
    var self = this, el = this.renderer.domElement;
    if (root.ResizeObserver) new ResizeObserver(function () { self._resize(); }).observe(this.host);
    else root.addEventListener('resize', function () { self._resize(); });
    if (root.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        self.visible = entries[0].isIntersecting;
        if (self.visible) self.invalidate();
      }).observe(this.host);
    }

    var moved = 0;
    el.addEventListener('pointerdown', function (e) {
      self.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      moved = 0;
      try { el.setPointerCapture(e.pointerId); } catch (ignore) { /* not capturable */ }
    });
    el.addEventListener('pointermove', function (e) {
      var p = self.pointers[e.pointerId];
      var ids = Object.keys(self.pointers);
      if (!p) { if (e.pointerType === 'mouse') self._hover(e); return; }
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (ids.length === 2) {
        var other = self.pointers[ids[0] === String(e.pointerId) ? ids[1] : ids[0]];
        var before = Math.hypot(p.x - other.x, p.y - other.y);
        var after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 0 && after > 0) self._zoom(before / after);
      } else {
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 4) {
          if (self.auto) self.setAuto(false);
          self.dragging = true;
          self.view.az -= dx * 0.008;
          self.view.el = Math.max(0.06, Math.min(1.45, self.view.el + dy * 0.006));
          self._hoverOff();
        }
      }
      p.x = e.clientX; p.y = e.clientY;
      self.invalidate();
    });
    function release(e) {
      var wasDrag = self.dragging;
      delete self.pointers[e.pointerId];
      if (!Object.keys(self.pointers).length) self.dragging = false;
      if (e.type === 'pointerup' && !wasDrag && moved <= 4) self._pick(e);
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', function () { self._hoverOff(); });
    el.addEventListener('wheel', function (e) {
      // Pinch on a trackpad arrives as a wheel with ctrl held; a plain
      // wheel is left alone so the page still scrolls.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      self._zoom(Math.exp(e.deltaY * 0.01));
    }, { passive: false });
  };

  Viewer.prototype._zoom = function (factor) {
    var home = this.view.homeDist || this.view.dist;
    this.view.dist = Math.max(home * 0.25, Math.min(home * 2.2, this.view.dist * factor));
    this.invalidate();
  };
  Viewer.prototype.zoomBy = function (factor) { if (this.ok) this._zoom(factor); };

  Viewer.prototype._resize = function () {
    if (!this.ok) return;
    var w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.size) this._fit(false);
    this.invalidate();
  };

  /** Sets the camera distance so the whole subject is in the picture. */
  Viewer.prototype._fit = function (resetAngles) {
    var s = this.size;
    var radius = 0.5 * Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
    var vertical = this.camera.fov * Math.PI / 180;
    var horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    var long = s.x > 2.5 * Math.max(s.y, s.z);
    var tight = (long && this.camera.aspect > 1.2) ? 0.8 : 1.06;
    var home = radius / Math.sin(Math.min(vertical, horizontal) / 2) * tight;
    var ratio = this.view.homeDist ? this.view.dist / this.view.homeDist : 1;
    this.view.homeDist = home;
    this.view.dist = resetAngles ? home : home * ratio;
    this.view.target.set(0, s.y * 0.46, 0);
    if (resetAngles) {
      this.view.az = this.mode === 'carton' ? 0.7 : 0.62;
      this.view.el = this.mode === 'carton' ? 0.42 : 0.5;
      this._base = this.view.az; this._phase = 0;
    }
    var reach = radius * 1.4;
    this.sun.position.set(reach * 0.6, reach * 1.6, reach * 0.9);
    this.sun.target.position.set(0, 0, 0);
    var cam = this.sun.shadow.camera;
    cam.left = -reach; cam.right = reach; cam.top = reach; cam.bottom = -reach;
    cam.near = 0.1; cam.far = reach * 5;
    cam.updateProjectionMatrix();
  };

  Viewer.prototype._clear = function () {
    var content = this.content;
    while (content.children.length) {
      var child = content.children[0];
      content.remove(child);
      child.traverse(function (node) {
        if (node.geometry) node.geometry.dispose();
        var materials = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
        materials.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
      });
    }
    this.cartonMesh = null; this.edges = null; this.items = null; this.labels = null;
    this._hoverOff();
  };

  function slab(group, w, h, l, x, y, z, colour) {
    var mesh = new T.Mesh(new T.BoxGeometry(w, h, l), new T.MeshLambertMaterial({ color: colour }));
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  function groundShadow(group, size) {
    var ground = new T.Mesh(new T.PlaneGeometry(size, size), new T.ShadowMaterial({ opacity: 0.16 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.052;
    ground.receiveShadow = true;
    group.add(ground);
  }

  /**
   Draws a loaded container. `colours` maps product id → colour;
   `gap` is the safety gap in cm (the load is centred across it).
  */
  Viewer.prototype.showContainer = function (container, colours, gap, keepView) {
    if (!this.ok) return;
    var sameShape = keepView && this.mode === 'container' && this.size &&
      Math.abs(this.size.x - container.type.length / 100) < 1e-6 && Math.abs(this.size.y - container.type.height / 100) < 1e-6;
    this._clear();
    this.mode = 'container';
    var type = container.type;
    var L = type.length / 100, W = type.width / 100, H = type.height / 100, beam = 0.07;
    var group = new T.Group();
    this.content.add(group);

    // Inside faces of the far end, the two sides and the roof.
    var shell = new T.BoxGeometry(L, H, W);
    function wall(repeat, shade) {
      return new T.MeshLambertMaterial({ color: shade, side: T.BackSide, map: ribTexture(repeat) });
    }
    var hidden = new T.MeshBasicMaterial({ visible: false });
    var walls = new T.Mesh(shell, [
      hidden,                                   // door end: open
      wall(Math.round(W / 0.28), STEEL),        // far end
      wall(1, STEEL_DARK),                      // roof
      hidden,                                   // floor (drawn as a slab)
      wall(Math.round(L / 0.28), STEEL),        // side
      wall(Math.round(L / 0.28), STEEL),        // side
    ]);
    walls.position.set(0, H / 2, 0);
    group.add(walls);

    slab(group, L + beam * 2, 0.05, W + beam * 2, 0, -0.025, 0, FLOOR);
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        slab(group, beam, H + beam, beam, sx * (L / 2 + beam / 2), (H + beam) / 2, sz * (W / 2 + beam / 2), STEEL);
      });
    });
    [-1, 1].forEach(function (sz) {
      slab(group, L + beam * 2, beam, beam, 0, H + beam / 2, sz * (W / 2 + beam / 2), STEEL);
    });
    slab(group, beam, beam, W, L / 2 + beam / 2, H + beam / 2, 0, STEEL);
    slab(group, beam, beam, W, -L / 2 - beam / 2, H + beam / 2, 0, STEEL);
    groundShadow(group, Math.max(L, W) * 4);

    // The cartons: one instanced box, one set of edge lines.
    var list = root.SPPacker.cartons(container);
    var n = list.length;
    this.items = list;
    if (n) {
      var material = new T.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      var mesh = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), material, n);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      var dummy = new T.Object3D(), lines = new Float32Array(n * 72);
      var offsetY = (gap || 0) / 2;
      this.baseColours = [];
      for (var i = 0; i < n; i++) {
        var c = list[i];
        var x0 = -L / 2 + c.x / 100, x1 = x0 + c.a / 100;
        var y0 = c.z / 100, y1 = y0 + c.c / 100;
        var z0 = -W / 2 + (offsetY + c.y) / 100, z1 = z0 + c.b / 100;
        dummy.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        dummy.scale.set(x1 - x0, y1 - y0, z1 - z0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        var colour = new T.Color(colours[c.id] || '#c29e73');
        // Blocks differ a touch in shade so they read apart; cartons
        // added by a top-up are drawn paler.
        colour.multiplyScalar(0.93 + 0.07 * ((c.block * 7) % 5) / 4);
        if (c.tier === 'opt2') colour.lerp(new T.Color(0xffffff), 0.45);
        this.baseColours.push(colour);
        mesh.setColorAt(i, colour);
        var corners = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
        var pairs = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
        for (var k = 0; k < 24; k++) {
          var corner = corners[pairs[k]];
          lines[i * 72 + k * 3] = corner[0]; lines[i * 72 + k * 3 + 1] = corner[1]; lines[i * 72 + k * 3 + 2] = corner[2];
        }
      }
      mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      this.cartonMesh = mesh;
      var edgeGeometry = new T.BufferGeometry();
      edgeGeometry.setAttribute('position', new T.BufferAttribute(lines, 3));
      this.edges = new T.LineSegments(edgeGeometry, new T.LineBasicMaterial({ color: 0x1a120a, transparent: true, opacity: 0.34 }));
      this.edges.frustumCulled = false;
      group.add(this.edges);
    }
    this.count = n;
    this.shown = n;
    this.highlight = null;
    this.size = { x: L, y: H, z: W };
    this._fit(!sameShape);
    this.invalidate();
  };

  /** Shows only the first `n` cartons in loading order. */
  Viewer.prototype.setShown = function (n) {
    if (!this.ok || !this.cartonMesh) return;
    this.shown = Math.max(0, Math.min(this.count, Math.round(n)));
    this.cartonMesh.count = this.shown;
    this.edges.geometry.setDrawRange(0, this.shown * 24);
    this.invalidate();
  };

  /** Fades every product but one (null puts them all back). */
  Viewer.prototype.setHighlight = function (id) {
    if (!this.ok || !this.cartonMesh) return;
    this.highlight = id;
    var grey = new T.Color(0x8a939c), colour = new T.Color();
    for (var i = 0; i < this.count; i++) {
      colour.copy(this.baseColours[i]);
      if (id && this.items[i].id !== id) colour.lerp(grey, 0.82);
      this.cartonMesh.setColorAt(i, colour);
    }
    this.cartonMesh.instanceColor.needsUpdate = true;
    this.invalidate();
  };

  /** Draws one carton, turning, with its three sizes marked. */
  Viewer.prototype.showCarton = function (product) {
    if (!this.ok) return;
    this._clear();
    this.mode = 'carton';
    var l = Math.max(product.l, 1) / 100, w = Math.max(product.w, 1) / 100, h = Math.max(product.h, 1) / 100;
    var group = new T.Group();
    this.content.add(group);
    var colour = new T.Color(product.colour || '#c29e73');
    var body = new T.Mesh(new T.BoxGeometry(l, h, w),
      new T.MeshLambertMaterial({ color: colour, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    body.position.y = h / 2; body.castShadow = true;
    group.add(body);
    var outline = new T.LineSegments(new T.EdgesGeometry(body.geometry), new T.LineBasicMaterial({ color: 0x1a120a, transparent: true, opacity: 0.45 }));
    outline.position.copy(body.position);
    group.add(outline);
    // Packing tape along the top and down both ends.
    var tape = colour.clone().lerp(new T.Color(0xffffff), 0.42);
    var tapeWidth = Math.min(w * 0.3, Math.max(l, w, h) * 0.06), lift = Math.max(l, w, h) * 0.002;
    var top = new T.Mesh(new T.BoxGeometry(l + lift * 2, lift, tapeWidth), new T.MeshLambertMaterial({ color: tape }));
    top.position.set(0, h + lift / 2, 0);
    group.add(top);
    [-1, 1].forEach(function (side) {
      var flap = new T.Mesh(new T.BoxGeometry(lift, Math.min(h * 0.35, tapeWidth * 1.6), tapeWidth), new T.MeshLambertMaterial({ color: tape }));
      flap.position.set(side * (l / 2 + lift / 2), h - flap.geometry.parameters.height / 2, 0);
      group.add(flap);
    });
    var ground = new T.Mesh(new T.PlaneGeometry(8 * Math.max(l, w), 8 * Math.max(l, w)), new T.ShadowMaterial({ opacity: 0.2 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    group.add(ground);

    var radius = 0.5 * Math.sqrt(l * l + w * w + h * h), labelWidth = radius * 0.95;
    function fmt(value) { return (Math.round(value * 10) / 10) + ' cm'; }
    var labels = [
      { sprite: labelSprite(fmt(product.l)), at: [0, 0, w / 2] },
      { sprite: labelSprite(fmt(product.w)), at: [l / 2, 0, 0] },
      { sprite: labelSprite(fmt(product.h)), at: [l / 2, h / 2, w / 2] },
    ];
    labels.forEach(function (label) {
      label.sprite.scale.set(labelWidth, labelWidth / label.sprite.userData.aspect, 1);
      label.sprite.position.set(label.at[0], label.at[1], label.at[2]);
      group.add(label.sprite);
    });
    this.size = { x: l, y: h, z: w };
    this._fit(true);
    this.view.homeDist *= 1.12; this.view.dist = this.view.homeDist;
    this.invalidate();
  };

  Viewer.prototype.setAuto = function (on) {
    this.auto = !!on;
    this._base = this.view.az; this._phase = 0;
    if (this.options.onAuto) this.options.onAuto(this.auto);
    this.invalidate();
  };

  Viewer.prototype.resetView = function () {
    if (!this.ok || !this.size) return;
    this.view.homeDist = 0;
    this._fit(true);
    this.invalidate();
  };

  Viewer.prototype.invalidate = function () {
    if (!this.ok || this._frame) return;
    this._frame = root.requestAnimationFrame(this._tick);
  };

  Viewer.prototype._tick = function (now) {
    this._frame = 0;
    var view = this.view, turning = this.auto && !this.dragging && this.visible && this.size;
    if (turning) {
      var dt = Math.min(0.05, (now - (this._last || now)) / 1000);
      if (this.mode === 'carton') view.az -= dt * (2 * Math.PI / 26);
      else {
        // A long container looks like nothing end-on, so it sways
        // through a three-quarter view instead of spinning.
        this._phase += dt;
        view.az = this._base - 0.375 + 0.375 * Math.cos(this._phase * 2 * Math.PI / 12);
      }
    }
    this._last = now;
    var ce = Math.cos(view.el);
    this.camera.position.set(
      view.target.x + view.dist * ce * Math.sin(view.az),
      view.target.y + view.dist * Math.sin(view.el),
      view.target.z + view.dist * ce * Math.cos(view.az));
    this.camera.lookAt(view.target);
    this.renderer.render(this.scene, this.camera);
    if (turning) this.invalidate();
  };

  Viewer.prototype._hit = function (e) {
    if (!this.cartonMesh || !this.shown) return null;
    var rect = this.renderer.domElement.getBoundingClientRect();
    var point = new T.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(point, this.camera);
    var hits = this.raycaster.intersectObject(this.cartonMesh);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].instanceId !== undefined && hits[i].instanceId < this.shown) {
        return { item: this.items[hits[i].instanceId], x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
    }
    return null;
  };
  Viewer.prototype._hover = function (e) {
    if (!this.options.onHover) return;
    var self = this;
    if (this._hoverQueued) { this._hoverEvent = e; return; }
    this._hoverQueued = true; this._hoverEvent = e;
    root.requestAnimationFrame(function () {
      self._hoverQueued = false;
      self.options.onHover(self._hit(self._hoverEvent));
    });
  };
  Viewer.prototype._hoverOff = function () { if (this.options.onHover) this.options.onHover(null); };
  Viewer.prototype._pick = function (e) {
    if (!this.options.onPick) return;
    var hit = this._hit(e);
    this.options.onPick(hit ? hit.item.id : null);
  };

  root.SPViewer = Viewer;
})(window);
