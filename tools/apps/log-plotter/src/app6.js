/* ================= 3D view: engine, card, playback ================= */
const PLAY = { on: false, speed: 1, last: 0 };
function playToggle(force) {
  if (!st.ix) return;
  PLAY.on = force === undefined ? !PLAY.on : force;
  if (PLAY.on) {
    if (st.pin === null || st.pin < st.view.t0 || st.pin >= st.view.t1 - 1e5) {
      const arm = st.ix.armed.find(a => a.t1 > st.view.t0 && a.t0 < st.view.t1);
      st.pin = arm ? Math.max(st.view.t0, arm.t0 - 2e6) : st.view.t0;
    }
    PLAY.last = performance.now();
    requestAnimationFrame(playTick);
  }
  updatePlayUI();
}
function playTick(now) {
  if (!PLAY.on) return;
  const dt = Math.min(0.25, (now - PLAY.last) / 1000); PLAY.last = now;
  let t = (st.pin === null ? st.view.t0 : st.pin) + dt * 1e6 * PLAY.speed;
  if (t > st.view.t1 || t < st.view.t0) t = st.view.t0;
  st.pin = t;
  requestOverlay();
  requestAnimationFrame(playTick);
}
function updatePlayUI() {
  const b = $('playBtn'); if (b) { b.textContent = PLAY.on ? '❚❚ Pause' : '▶ Play'; b.setAttribute('aria-pressed', String(PLAY.on)); }
  const s = $('playSpeed'); if (s) s.value = String(PLAY.speed);
}

/* ---------- the engine (one WebGL view, attached to the 3D card) ---------- */
const V3 = {
  g: null, wrap: null, renderer: null, raf: 0, ix: null, cfgKey: {}, models: new Map(), status: '', modelErr: '',
  cam: { az: 0, el: 18, dist: 60, target: null, fresh: true },
  ok() { return HAS3D && !!this.renderer; },
  init() {
    if (this.renderer || !HAS3D) return;
    let r;
    try { r = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true }); }
    catch (e) { this.initErr = 'This browser could not start WebGL, so the 3D view cannot run.'; return; }
    this.renderer = r;
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.domElement.className = 'v3-canvas';
    this.aniso = Math.min(8, r.capabilities.getMaxAnisotropy());
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 2, 0.3, 4e6);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f80, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55); sun.position.set(0.5, 1, 0.35); this.scene.add(sun);
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.pathGroup = new THREE.Group(); this.world.add(this.pathGroup);
    this.vehicle = new THREE.Group(); this.world.add(this.vehicle);
    this.fix = new THREE.Group(); this.vehicle.add(this.fix);
    this.tiles = new TileSet(this); this.world.add(this.tiles.group);
    this.waterGroup = new THREE.Group(); this.world.add(this.waterGroup);
    this.waterColor = new THREE.Color(0x14a3a3);
    this.fogUnder = new THREE.FogExp2(0x0b6f74, 0.006);
    this.ray = new THREE.Raycaster();
    this.attachEvents(r.domElement);
  },
  req() { if (!this.raf && this.g && this.renderer) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); },
  surfH(lat, lon) { return this.cfg && this.cfg.surface === 'geoid' ? GEO.geoidN(lat, lon) : 0; },
  /** Vertical stretch of terrain (and water), active only with terrain on. */
  exag() { const c = this.cfg; return c && c.terrain ? clamp(Number(c.exag) || 1, 0.1, 50) : 1; },
  /** Heights are stretched around the takeoff height, so takeoff stays where it is. */
  href() { const c = this.cfg, H = this.home; return H ? H.alt + (c.amsl && c.surface !== 'sphere' ? GEO.geoidN(H.lat, H.lon) : 0) : 0; },
  vz(h) { const k = this.exag(); if (k === 1) return h; const r = this.href(); return r + (h - r) * k; },
  /** Scene height of a logged altitude: geoid, global Z offset, this path's offset, then the stretch if paths follow it. */
  pathH(lat, lon, alt, dz) {
    const c = this.cfg, raw = alt + (c.amsl && c.surface !== 'sphere' ? GEO.geoidN(lat, lon) : 0) + (Number(c.zoff) || 0) + (Number(dz) || 0);
    return c.stretchPaths ? this.vz(raw) : raw;
  },
  vzWater(h) { return this.cfg.stretchWater ? this.vz(h) : h; },
  dzOf(src) { const p = this.cfg.pos.find(q => q.src === src); return p ? Number(p.dz) || 0 : 0; },
  roiBox() {
    const { lat, lon, r } = this.roi, m = GEO.mPerDeg(lat), dLat = r / m.lat, dLon = r / Math.max(1, m.lon);
    return { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
  },

  /** Attach to a card, or detach when there is none. */
  attach(g, wrap) {
    this.init();
    if (!this.renderer) { wrap.append(h('p', 'v3-msg', this.initErr || '3D needs three.js, which did not load. Check the connection, or use the offline file.')); return; }
    this.g = g; this.wrap = wrap;
    wrap.prepend(this.renderer.domElement);
    this.hud = wrap.querySelector('.v3-hud'); this.attr = wrap.querySelector('.v3-attr'); this.stat = wrap.querySelector('.v3-stat'); this.underEl = wrap.querySelector('.v3-under');
    this.statText = null;
    if (this.io) this.io.disconnect();
    if (typeof IntersectionObserver === 'function') { this.io = new IntersectionObserver(es => { this.onScreen = es[es.length - 1].isIntersecting; if (this.onScreen) this.req(); }); this.io.observe(wrap); }
    this.apply(false);
  },
  detach() { if (this.io) { this.io.disconnect(); this.io = null; } this.g = null; this.wrap = null; if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } },
  readColors() {
    const cs = getComputedStyle(document.documentElement);
    this.sky = new THREE.Color(cs.getPropertyValue('--sky').trim() || '#cfdcea');
    this.groundColor = new THREE.Color(cs.getPropertyValue('--ground').trim() || '#9aa58e');
    if (this.scene) {
      const near = this.roi ? this.roi.r * 0.9 : 1e5, far = this.roi ? this.roi.r * 2.4 : 3e5;
      this.fogSky = new THREE.Fog(this.sky, near, far);
      this.scene.background = this.sky; this.scene.fog = this.fogSky;
    }
  },

  /** Bring the scene in line with the card's settings, rebuilding only what changed. */
  async apply(force) {
    if (!this.renderer || !this.g) return;
    const c = this.g.v3, ix = st.ix;
    this.cfg = c;
    this.readColors();
    const keys = {
      frame: [ix && ix.name, ix && ix.size, ix && ix.tMin, c.surface, c.vehicle, (c.pos || []).filter(p => p.on).map(p => p.src).join()].join('|'),
      paths: JSON.stringify([c.pos, c.dropJumps, c.amsl, c.zoff, c.range, c.colorBy, c.curtain, c.waypoints, c.vehicle, c.range === 'view' ? [Math.round(st.view.t0), Math.round(st.view.t1)] : 0, c.terrain && c.stretchPaths ? c.exag : 1]),
      tiles: JSON.stringify([c.imagery, c.imageryUrl, c.imageryMax, c.terrain, c.terrainUrl, c.terrainMsl, c.terrain ? c.exag : 1, c.terrain && c.exag !== 1 ? c.amsl : 0]),
      water: JSON.stringify([c.water, c.waterLevel, c.waterDepth, c.surface, c.terrain && c.stretchWater ? [c.exag, c.amsl] : 1]),
      model: JSON.stringify([c.model, c.modelName])
    };
    if (!ix) { this.msg('Open a log to see it in 3D.'); this.req(); return; }
    this.sources = v3Sources();
    if (!this.sources.pos.length) { this.msg('This log has no position data (no GPS, POS or AHR2 latitude and longitude).'); this.req(); return; }
    this.fillDefaults(c);
    if (force || keys.frame !== this.cfgKey.frame) { this.buildFrame(); this.cfgKey.paths = null; this.cfgKey.tiles = null; this.cfgKey.water = null; this.cam.fresh = true; }
    if (!this.fr) { this.msg('No valid position fix in this log.'); this.req(); return; }
    this.msg('');
    if (force || keys.paths !== this.cfgKey.paths) this.buildPaths();
    if (force || keys.model !== this.cfgKey.model) await this.buildModel();
    if (force || keys.tiles !== this.cfgKey.tiles) { this.cfgKey.tiles = keys.tiles; this.buildTiles(); }
    if (force || keys.water !== this.cfgKey.water) this.buildWater(); else this.updateWaterLook();
    this.cfgKey.frame = keys.frame; this.cfgKey.paths = keys.paths; this.cfgKey.model = keys.model; this.cfgKey.water = keys.water;
    this.posD = posData(c.vehicle, c.dropJumps); this.attD = attData(c.att);
    this.applyFix();
    this.req();
  },
  fillDefaults(c) {
    const S = this.sources;
    if (!Array.isArray(c.pos)) c.pos = [];
    c.pos = c.pos.filter(p => S.pos.includes(p.src));
    if (!c.pos.length) S.pos.forEach((src, i) => c.pos.push({ src, on: i < 2 || /^POS$|^GPS(\[0\])?$/.test(src), color: i % NC, dz: 0 }));
    else for (const src of S.pos) if (!c.pos.some(p => p.src === src)) c.pos.push({ src, on: false, color: c.pos.length % NC, dz: 0 });
    for (const p of c.pos) if (!Number.isFinite(p.dz)) p.dz = 0;
    for (const k of ['exag', 'waterLevel', 'waterDepth']) if (!Number.isFinite(Number(c[k]))) c[k] = V3DEF[k];
    delete c.exagPaths; delete c.waterBase;
    if (!S.pos.includes(c.vehicle)) c.vehicle = (c.pos.find(p => p.on) || c.pos[0]).src;
    if (!S.att.some(a => a.id === c.att)) c.att = S.att.length ? S.att[0].id : '';
  },
  msg(text) { const el = this.wrap && this.wrap.querySelector('.v3-msg'); if (el) { el.textContent = text; el.hidden = !text; } },

  buildFrame() {
    const c = this.cfg, ix = st.ix;
    // takeoff and the map area always ignore position jumps, so one bad fix cannot spread the map over a continent
    const on = c.pos.filter(p => p.on).map(p => p.src);
    const d = posData(c.vehicle, true) || posData(on[0], true);
    this.fr = null;
    if (!d) return;
    let k = -1;
    const tArm = ix.armed.length ? ix.armed[0].t0 : -Infinity;
    for (let i = EX.lowerBound(d.t, tArm); i < d.t.length; i++) if (goodFix(d, i)) { k = i; break; }
    if (k < 0) for (let i = 0; i < d.t.length; i++) if (goodFix(d, i)) { k = i; break; }
    if (k < 0) return;
    this.home = { lat: d.lat[k], lon: d.lon[k], alt: d.alt ? d.alt[k] : 0 };
    this.fr = GEO.frame(this.home.lat, this.home.lon, c.surface === 'sphere');
    // the map covers the shown paths: 99.5% of their fixes, so a few stray ones do not count
    const m = GEO.mPerDeg(this.home.lat), dist = [];
    for (const src of on.length ? on : [c.vehicle]) {
      const pd = posData(src, true); if (!pd) continue;
      const step = Math.max(1, Math.floor(pd.t.length / 4000));
      for (let i = 0; i < pd.t.length; i += step) if (goodFix(pd, i)) dist.push(Math.hypot((pd.lat[i] - this.home.lat) * m.lat, (pd.lon[i] - this.home.lon) * m.lon));
    }
    dist.sort((a, b) => a - b);
    const far = dist.length ? dist[Math.floor((dist.length - 1) * 0.995)] : 0;
    this.roi = { lat: this.home.lat, lon: this.home.lon, r: clamp(far * 1.6 + 1500, 2500, 250000) };
    if (this.fogSky) { this.fogSky.near = this.roi.r * 0.9; this.fogSky.far = this.roi.r * 2.4; }
  },
  modeColors() {
    const ix = st.ix, map = new Map(); let mc = 0;
    for (const sp of ix.modeSpans) if (!map.has(sp.mode)) map.set(sp.mode, mc < 8 ? st.colors['m' + (++mc)] : st.colors.faint);
    return map;
  },
  buildPaths() {
    const c = this.cfg, ix = st.ix, fr = this.fr;
    for (const o of [...this.pathGroup.children]) { this.pathGroup.remove(o); o.traverse(x => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); }); }
    this.pick = []; this.jumps = {};
    const t0 = c.range === 'view' ? st.view.t0 : -Infinity, t1 = c.range === 'view' ? st.view.t1 : Infinity;
    const mcol = c.colorBy === 'mode' ? this.modeColors() : null;
    const spans = ix.modeSpans;
    const col = new THREE.Color();
    for (const p of c.pos) {
      if (!p.on) continue;
      const d = posData(p.src, c.dropJumps); if (!d) continue;
      this.jumps[p.src] = jumpCount(d);
      const i0 = EX.lowerBound(d.t, t0), i1 = EX.upperBound(d.t, t1), n = i1 - i0;
      if (n < 2) continue;
      const step = Math.max(1, Math.ceil(n / 40000));
      const pts = [], times = [];
      const gap = Math.max(3e6, 5 * EX.medianDt({ t: d.t }));
      const segP = [], segC = [];
      let prev = -1, si = 0;
      const pc = new THREE.Color();
      const base = new THREE.Color(st.colors['c' + ((p.color % NC) + 1)]);
      const tmp = [0, 0, 0];
      for (let i = i0; i < i1; i += step) {
        if (!goodFix(d, i)) { prev = -1; continue; }
        fr.toScene(d.lat[i], d.lon[i], this.pathH(d.lat[i], d.lon[i], d.alt ? d.alt[i] : this.home.alt, p.dz), tmp, 0);
        pts.push(tmp[0], tmp[1], tmp[2]); times.push(d.t[i]);
        const k = pts.length / 3 - 1;
        if (mcol) { while (si + 1 < spans.length && spans[si + 1].t0 <= d.t[i]) si++; col.set(spans.length && spans[si].t0 <= d.t[i] ? mcol.get(spans[si].mode) : st.colors.faint); }
        else col.copy(base);
        if (prev >= 0 && d.t[i] - d.t[prev] <= gap) {
          segP.push(pts[(k - 1) * 3], pts[(k - 1) * 3 + 1], pts[(k - 1) * 3 + 2], tmp[0], tmp[1], tmp[2]);
          segC.push(pc.r, pc.g, pc.b, col.r, col.g, col.b);
        }
        pc.copy(col);
        prev = i;
      }
      if (!segP.length) continue;
      const geo = new THREE.LineSegmentsGeometry(); geo.setPositions(segP); geo.setColors(segC);
      const m = new THREE.LineMaterial({ linewidth: p.src === c.vehicle ? 3 : 2, vertexColors: true, worldUnits: false });
      m.resolution.set(this.w || 800, this.h || 400);
      const line = new THREE.LineSegments2(geo, m); line.computeLineDistances(); line.renderOrder = 100;
      this.pathGroup.add(line);
      this.pick.push({ src: p.src, pts: Float32Array.from(pts), t: Float64Array.from(times) });
      if (c.curtain && p.src === c.vehicle) this.pathGroup.add(this.curtain(pts, base));
    }
    if (c.waypoints) { const w = this.missionObj(); if (w) this.pathGroup.add(w); }
    this.showJumps();
  },
  showJumps() {
    const el = this.g && this.g._el.body && this.g._el.body.querySelector('.v3-jumps'); if (!el) return;
    const c = this.cfg, list = Object.entries(this.jumps || {}).filter(([, n]) => n > 0);
    el.textContent = !c.dropJumps ? '' : list.length ? 'Jumps hidden: ' + list.map(([s, n]) => `${s} ${n} fix${n === 1 ? '' : 'es'}`).join(', ') + '.' : '';
    el.hidden = !el.textContent;
  },
  curtain(pts, color) {
    const n = pts.length / 3, gh = [0, 0, 0];
    this.fr.toScene(this.home.lat, this.home.lon, this.pathH(this.home.lat, this.home.lon, this.home.alt, this.dzOf(this.cfg.vehicle)), gh, 0);
    const step = Math.max(1, Math.floor(n / 6000)), m = Math.floor((n - 1) / step) + 1;
    const pos = new Float32Array(m * 6);
    for (let k = 0, i = 0; k < m; i += step, k++) {
      const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
      pos[k * 6] = x; pos[k * 6 + 1] = y; pos[k * 6 + 2] = z; pos[k * 6 + 3] = x; pos[k * 6 + 4] = gh[1]; pos[k * 6 + 5] = z;
    }
    const idx = [];
    for (let k = 0; k + 1 < m; k++) { const a = k * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, c, b, d); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.11, side: THREE.DoubleSide, depthWrite: false }));
    mesh.renderOrder = 99;
    return mesh;
  },
  missionObj() {
    const ix = st.ix, f = k => ix.fieldIndex.get('CMD.' + k);
    const la = f('Lat'), lo = f('Lng'), al = f('Alt'), cn = f('CNum'), fm = f('Frame');
    if (!la || !lo || !al) return null;
    const byNum = new Map();
    for (let i = 0; i < la.series.v.length; i++) {
      const lat = la.series.v[i], lon = lo.series.v[i];
      if (!validLL(lat, lon) || (cn && cn.series.v[i] === 0)) continue;
      byNum.set(cn ? cn.series.v[i] : i, { lat, lon, alt: al.series.v[i], frame: fm ? fm.series.v[i] : 3 });
    }
    if (!byNum.size) return null;
    const g = new THREE.Group(), pts = [], tmp = [0, 0, 0];
    const homeAmsl = this.home.alt;
    const mk = new THREE.MeshBasicMaterial({ color: st.colors.sel });
    const geo = new THREE.OctahedronGeometry(1);
    for (const num of [...byNum.keys()].sort((a, b) => a - b)) {
      const w = byNum.get(num);
      const amsl = w.frame === 0 ? w.alt : homeAmsl + w.alt;
      this.fr.toScene(w.lat, w.lon, this.pathH(w.lat, w.lon, amsl), tmp, 0);
      const s = new THREE.Mesh(geo, mk); s.position.set(tmp[0], tmp[1], tmp[2]); s.userData.wp = true; g.add(s);
      pts.push(new THREE.Vector3(tmp[0], tmp[1], tmp[2]));
    }
    if (pts.length > 1) {
      const lg = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: st.colors.sel, dashSize: 6, gapSize: 4 }));
      line.computeLineDistances(); g.add(line);
    }
    g.userData.mission = true;
    return g;
  },
  /** Tileable white wave crests and foam on a transparent background. */
  waveTexture() {
    if (this.waveImg) return this.waveImg;
    const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d');
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const each = (fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { g.save(); g.translate(ox, oy); fn(); g.restore(); } };
    g.lineCap = 'round';
    for (let k = 0; k < 75; k++) {
      const x = rnd() * S, y = rnd() * S, len = 60 + rnd() * 120, amp = 3 + rnd() * 7, w = 1.8 + rnd() * 3.2, a = 0.45 + rnd() * 0.45, tilt = (rnd() - 0.5) * 0.35;
      each(() => {
        g.translate(x, y); g.rotate(tilt);
        g.strokeStyle = `rgba(255,255,255,${a})`; g.lineWidth = w;
        g.beginPath();
        for (let i = 0; i <= 24; i++) { const u = i / 24, px = (u - 0.5) * len, py = Math.sin(u * Math.PI * 2.2) * amp * Math.sin(u * Math.PI); if (i) g.lineTo(px, py); else g.moveTo(px, py); }
        g.stroke();
        g.strokeStyle = `rgba(255,255,255,${a * 0.3})`; g.lineWidth = w * 3.2; g.stroke();
      });
    }
    for (let k = 0; k < 220; k++) {
      const x = rnd() * S, y = rnd() * S, r = 0.9 + rnd() * 2, a = 0.3 + rnd() * 0.5;
      each(() => { g.fillStyle = `rgba(255,255,255,${a})`; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); });
    }
    this.waveImg = cv;
    return cv;
  },
  /** A water volume over the map area: its surface at sea level + level, reaching down by depth. */
  buildWater() {
    for (const o of [...this.waterGroup.children]) { this.waterGroup.remove(o); o.geometry.dispose(); if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    this.wMat = null;
    const c = this.cfg;
    this.waterOn = !!(c.water && this.fr && this.roi);
    if (!this.waterOn) return;
    const box = this.roiBox(), N = 72, n = N + 1, level = Number(c.waterLevel) || 0, depth = Math.max(0.1, Number(c.waterDepth) || 10);
    // the surface is lifted 15 cm so it never flickers against a map drawn at the same height
    const heights = (lat, lon) => { const top = this.surfH(lat, lon) + level; return [this.vzWater(top - depth), this.vzWater(top) + 0.15]; };
    const tmp = [0, 0, 0], m = GEO.mPerDeg(this.home.lat), TILE = 60;
    // surface, with wave texture coordinates in 60 m tiles
    const tp = [], tuv = [], tidx = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const lat = box.s + (box.n - box.s) * j / N, lon = box.w + (box.e - box.w) * i / N;
      this.fr.toScene(lat, lon, heights(lat, lon)[1], tmp, 0); tp.push(tmp[0], tmp[1], tmp[2]);
      tuv.push((lon - this.home.lon) * m.lon / TILE, (lat - this.home.lat) * m.lat / TILE);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1; tidx.push(a, b, cc, b, d, cc); }
    const topGeo = new THREE.BufferGeometry();
    topGeo.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
    topGeo.setAttribute('uv', new THREE.Float32BufferAttribute(tuv, 2));
    topGeo.setIndex(tidx); topGeo.computeBoundingSphere();
    // bottom and side walls
    const bp = [], bidx = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const lat = box.s + (box.n - box.s) * j / N, lon = box.w + (box.e - box.w) * i / N;
      this.fr.toScene(lat, lon, heights(lat, lon)[0], tmp, 0); bp.push(tmp[0], tmp[1], tmp[2]);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1; bidx.push(a, b, cc, b, d, cc); }
    const wall = pts => {
      const first = bp.length / 3;
      for (const [lat, lon] of pts) { const hh = heights(lat, lon); for (const k of [0, 1]) { this.fr.toScene(lat, lon, hh[k], tmp, 0); bp.push(tmp[0], tmp[1], tmp[2]); } }
      for (let k = 0; k + 1 < pts.length; k++) { const a = first + k * 2; bidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    };
    const edge = (f) => Array.from({ length: n }, (_, k) => f(k / N));
    wall(edge(u => [box.s, box.w + (box.e - box.w) * u])); wall(edge(u => [box.n, box.w + (box.e - box.w) * u]));
    wall(edge(u => [box.s + (box.n - box.s) * u, box.w])); wall(edge(u => [box.s + (box.n - box.s) * u, box.e]));
    const bodyGeo = new THREE.BufferGeometry();
    bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    bodyGeo.setIndex(bidx); bodyGeo.computeBoundingSphere();
    const glass = () => new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const waveMat = (rep, rot) => {
      const tex = new THREE.CanvasTexture(this.waveTexture());
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = this.aniso;
      tex.repeat.set(rep, rep); tex.center.set(0.5, 0.5); tex.rotation = rot;
      const mt = glass(); mt.map = tex; mt.color.set(0xffffff); return mt;
    };
    this.wMat = { body: glass(), top: glass(), w1: waveMat(1, 0), w2: waveMat(60 / 23, 0.9) };
    const add = (geo, mt, order) => { const me = new THREE.Mesh(geo, mt); me.renderOrder = order; this.waterGroup.add(me); return me; };
    add(bodyGeo, this.wMat.body, 95); add(topGeo, this.wMat.top, 96);
    this.waveMeshes = [add(topGeo, this.wMat.w1, 97), add(topGeo, this.wMat.w2, 98)];
    this.waterBox = box;
    this.updateWaterLook();
  },
  /** Colour, opacity and waves, without rebuilding the water. */
  updateWaterLook() {
    const c = this.cfg; if (!c) return;
    const col = new THREE.Color(/^#[0-9a-f]{6}$/i.test(c.waterColor || '') ? c.waterColor : V3DEF.waterColor);
    const above = clamp(Number(c.waterAbove), 0, 100) / 100, under = clamp(Number(c.waterUnder), 0, 100) / 100;
    if (this.wMat) {
      this.wMat.top.color.copy(col); this.wMat.top.opacity = above;
      this.wMat.body.color.copy(col); this.wMat.body.opacity = above * 0.7;
      this.wMat.w1.opacity = 0.9; this.wMat.w2.opacity = 0.5;
      for (const me of this.waveMeshes || []) me.visible = !!c.waves;
    }
    const dark = col.clone().multiplyScalar(0.5);
    this.fogUnder.color.copy(dark);
    this.fogUnder.density = 0.0003 + under * under * 0.03;
    if (this.underEl) {
      const rgb = x => `${Math.round(x.r * 255)},${Math.round(x.g * 255)},${Math.round(x.b * 255)}`;
      this.underEl.style.background = `radial-gradient(ellipse at 50% 35%, rgba(${rgb(col)},${(under * 0.3).toFixed(3)}), rgba(${rgb(dark)},${(0.08 + under * 0.62).toFixed(3)}))`;
    }
    this.req();
  },
  /** How far the camera is under the water surface, or null when it is not inside the water. */
  underwater() {
    if (!this.waterOn || !this.fr) return null;
    const c = this.cfg, p = this.camera.position, g = this.fr.fromScene(p.x, p.y, p.z), b = this.waterBox;
    if (g.lat < b.s || g.lat > b.n || g.lon < b.w || g.lon > b.e) return null;
    const top = this.surfH(g.lat, g.lon) + (Number(c.waterLevel) || 0), lo = this.vzWater(top - Math.max(0.1, Number(c.waterDepth) || 10)), hi = this.vzWater(top) + 0.15;
    return g.h >= lo && g.h <= hi ? (hi - g.h) / (c.stretchWater ? this.exag() : 1) : null;
  },
  async buildModel() {
    const c = this.cfg;
    for (const o of [...this.fix.children]) this.fix.remove(o);
    this.modelErr = '';
    let m = null;
    if (c.model === 'custom') {
      const rec = await IDB.get('model');
      if (rec && rec.name === c.modelName) {
        try { m = await modelFromFile(rec.name, rec.data); } catch (e) { this.modelErr = e.message; }
      } else this.modelErr = `Load ${c.modelName || 'your model file'} again to show it here.`;
    }
    if (!m) m = c.model === 'quad' ? quadModel() : planeModel();
    this.model = m;
    this.fix.add(m);
    this.applyFix();
    this.req();
  },
  applyFix() {
    const c = this.cfg; if (!c || !this.fix) return;
    const r = c.rot || [0, 0, 0];
    this.fix.rotation.set(r[1] * GEO.D2R, r[0] * GEO.D2R, r[2] * GEO.D2R, 'YXZ');
  },
  async buildTiles(isRetry) {
    const c = this.cfg, key = this.cfgKey.tiles;
    clearTimeout(this.layerTimer);
    if (!isRetry) this.layerTries = 0;
    this.layerErr = ''; this.layerNext = 0;
    let layer = null;
    if (c.terrain && c.terrainUrl) {
      this.layerLoading = true; this.updateStatus();
      try { layer = await loadLayer(c.terrainUrl); this.layer = layer; this.layerTries = 0; }
      catch (e) {
        this.layerErr = e.message; layer = null;
        if (e.transient) {
          this.layerTries++;
          const wait = backoff(this.layerTries);
          this.layerNext = performance.now() + wait;
          this.layerTimer = setTimeout(() => { if (this.cfgKey.tiles === key && this.g) this.buildTiles(true); }, wait);
        }
      }
      this.layerLoading = false;
      if (this.cfgKey.tiles !== key) return;
    }
    this.tiles.reset(c, layer);
    this.updateAttribution(layer);
    this.req();
  },
  retryNow() {
    if (this.layerErr && this.cfg.terrain && this.cfg.terrainUrl) { this.buildTiles(true); return; }
    this.tiles.retryAll();
  },
  updateAttribution(layer) {
    if (!this.attr) return;
    const c = this.cfg, img = c.imagery === 'custom' ? (c.imageryAttr || '') : (IMAGERY[c.imagery] || {}).attr || '';
    this.attr.textContent = [img, layer && layer.attribution ? 'Terrain ' + layer.attribution.replace(/<[^>]+>/g, '') : ''].filter(Boolean).join(' · ');
  },
  updateStatus() {
    if (!this.stat) return;
    const T = this.tiles, parts = [], now = performance.now();
    let retry = false;
    const secs = ms => Math.max(1, Math.ceil(ms / 1000));
    if (this.layerLoading) parts.push('Loading terrain…');
    else if (this.layerErr) { parts.push(this.layerErr + (this.layerNext ? ` Trying again in ${secs(this.layerNext - now)} s.` : '')); retry = true; }
    const pend = T ? T.pending() : 0;
    if (pend) parts.push(`Loading ${pend} tile${pend === 1 ? '' : 's'}…`);
    const f = T ? T.failures() : { n: 0 };
    if (f.n) {
      const none = !T.good;
      parts.push((none ? 'Tiles did not load. Check the connection and the link; the server must allow cross-origin requests (CORS). ' : `${f.n} tile${f.n === 1 ? '' : 's'} did not load. `) + (f.err ? `(${f.err}) ` : '') + (f.next ? `Trying again in ${secs(f.next)} s.` : 'Trying again…'));
      retry = true;
    }
    if (this.modelErr) parts.push(this.modelErr);
    const txt = parts.join(' · ');
    if (this.statText !== txt || this.statRetry !== retry) {
      this.statText = txt; this.statRetry = retry;
      this.stat.replaceChildren(h('span', null, txt));
      if (retry) { const b = h('button', 'btn small', 'Retry now'); b.type = 'button'; b.onclick = () => this.retryNow(); this.stat.append(b); }
    }
    this.stat.hidden = !txt;
    if ((f.n || this.layerNext) && !this.statTimer) this.statTimer = setTimeout(() => { this.statTimer = 0; if (this.g) this.updateStatus(); }, 1000);
  },

  /* ---------- per-frame ---------- */
  showTime() {
    if (PLAY.on && st.pin !== null) return st.pin;
    if (st.cursor !== null) return st.cursor;
    if (st.pin !== null) return st.pin;
    const ix = st.ix;
    return ix && ix.armed.length ? ix.armed[0].t0 : ix ? ix.tMin : 0;
  },
  vehiclePose(t) {
    const c = this.cfg, P = posAt(this.posD, t);
    if (!P) return null;
    const p = this.fr.toScene(P.lat, P.lon, this.pathH(P.lat, P.lon, P.alt, this.dzOf(c.vehicle)), [0, 0, 0]);
    let A = attAt(this.attD, t);
    let hdg = A ? A.yaw : null;
    if (hdg === null) {
      const Q = posAt(this.posD, t - 1e6);
      if (Q) { const m = GEO.mPerDeg(P.lat); hdg = Math.atan2((P.lon - Q.lon) * m.lon, (P.lat - Q.lat) * m.lat) / GEO.D2R; }
      else hdg = 0;
      A = { roll: 0, pitch: 0, yaw: hdg };
    }
    const enu = this.fr.enu(P.lat, P.lon);
    const B = new THREE.Matrix4().makeBasis(new THREE.Vector3(...enu.E), new THREE.Vector3(...enu.U), new THREE.Vector3(-enu.N[0], -enu.N[1], -enu.N[2]));
    const q = new THREE.Quaternion().setFromRotationMatrix(B).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(A.pitch * GEO.D2R, -A.yaw * GEO.D2R, -A.roll * GEO.D2R, 'YXZ')));
    return { P, A, pos: new THREE.Vector3(p[0], p[1], p[2]), q, enu, c };
  },
  render() {
    if (!this.renderer || !this.g || !this.wrap) return;
    const w = Math.max(200, this.wrap.clientWidth), hh = this.g.height;
    if (w !== this.w || hh !== this.h) {
      this.w = w; this.h = hh;
      this.renderer.setSize(w, hh, false);
      this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = hh + 'px';
      this.camera.aspect = w / hh; this.camera.updateProjectionMatrix();
      this.pathGroup.traverse(o => { if (o.material && o.material.resolution) o.material.resolution.set(w, hh); });
    }
    if (!this.fr || !st.ix) { this.renderer.render(this.scene, this.camera); return; }
    const c = this.cfg, t = this.showTime(), pose = this.vehiclePose(t);
    let animate = false;
    if (pose) {
      this.vehicle.visible = true;
      this.vehicle.position.copy(pose.pos); this.vehicle.quaternion.copy(pose.q);
    } else this.vehicle.visible = false;
    // camera
    const cam = this.cam, up = pose ? new THREE.Vector3(...pose.enu.U) : new THREE.Vector3(0, 1, 0);
    const nowMs = performance.now(), dt = Math.min(0.1, (nowMs - (this.lastFrame || nowMs)) / 1000); this.lastFrame = nowMs;
    if (this.keys && this.keys.size && c.camera === 'free' && cam.target) { this.fly(dt, up); animate = true; }
    let target;
    if (c.camera === 'free') {
      if (!cam.target || cam.fresh) cam.target = pose ? pose.pos.clone() : new THREE.Vector3();
      target = cam.target;
    } else target = pose ? pose.pos.clone() : (cam.target || new THREE.Vector3());
    if (cam.fresh) { cam.az = 0; cam.el = c.camera === 'free' ? 35 : 14; cam.dist = c.camera === 'free' ? 400 : (Number(c.modelSize) || 2.5) * 5 + 6; cam.fresh = false; cam.snap = true; }
    const baseAz = c.camera === 'follow' && pose ? pose.A.yaw : 0;
    const az = (baseAz + cam.az) * GEO.D2R, el = cam.el * GEO.D2R;
    const E3 = pose ? new THREE.Vector3(...pose.enu.E) : new THREE.Vector3(1, 0, 0);
    const N3 = pose ? new THREE.Vector3(...pose.enu.N) : new THREE.Vector3(0, 0, -1);
    const back = N3.clone().multiplyScalar(-Math.cos(az)).add(E3.clone().multiplyScalar(-Math.sin(az)));
    const want = target.clone().add(back.multiplyScalar(cam.dist * Math.cos(el))).add(up.clone().multiplyScalar(cam.dist * Math.sin(el)));
    if (cam.snap || !this.camPos || this.camPos.distanceTo(want) > cam.dist * 4) { this.camPos = want.clone(); cam.snap = false; }
    else { this.camPos.lerp(want, 0.35); if (this.camPos.distanceTo(want) > cam.dist * 0.002) animate = true; }
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(up);
    this.camera.lookAt(target);
    this.lastPose = pose; this.lastTarget = target.clone();
    this.updateHint();
    const camH = Math.max(10, this.camPos.length() > 0 ? cam.dist * Math.sin(el) + 50 : 100);
    this.camera.near = Math.max(0.2, cam.dist * 0.01); this.camera.far = Math.max(2e4, this.roi.r * 4 + camH * 30);
    this.camera.updateProjectionMatrix();
    // model size: real size, or bigger far away so it stays visible
    const size = Math.max(0.05, Number(c.modelSize) || 2.5);
    const dCam = pose ? this.camera.position.distanceTo(pose.pos) : 100;
    const s = c.keepVisible ? Math.max(size, dCam * 0.09) : size;
    this.fix.scale.setScalar(s);
    if (this.model && this.model.userData.prop && pose) { this.model.userData.prop.rotation.z += armedAt(t) ? 0.9 : 0; animate = animate || (armedAt(t) && PLAY.on); }
    this.pathGroup.traverse(o => { if (o.userData && o.userData.wp) o.scale.setScalar(Math.max(0.5, this.camera.position.distanceTo(o.position) * 0.006)); });
    // tiles
    const pxK = (this.h / 2) / Math.tan(this.camera.fov * GEO.D2R / 2);
    this.tiles.update(this.camera.position, pxK);
    if (this.tiles.pending()) animate = true;
    if (this.waterOn && c.waves && c.wavesMove && this.wMat && this.onScreen !== false && !document.hidden) {
      const ts = nowMs / 1000;
      this.wMat.w1.map.offset.set(ts * 0.011, ts * 0.006);
      this.wMat.w2.map.offset.set(-ts * 0.017, ts * 0.012);
      if (!this.waveTimer) this.waveTimer = setTimeout(() => { this.waveTimer = 0; this.req(); }, 45);
    }
    const under = this.underwater();
    this.under = under;
    if (under !== null) { this.scene.fog = this.fogUnder; this.scene.background = this.fogUnder.color; }
    else if (this.scene.fog === this.fogUnder) { this.scene.fog = this.fogSky; this.scene.background = this.sky; }
    if (this.underEl) this.underEl.hidden = under === null;
    this.renderer.render(this.scene, this.camera);
    this.drawHud(t, pose);
    this.updateStatus();
    if (animate) this.req();
  },
  drawHud(t, pose) {
    if (!this.hud) return;
    const ix = st.ix, m = modeAt(t);
    let html = `<b>${fmtT(t, 1)}</b> <span>${esc([m !== null ? DF.modeName(ix, m) : '', armedAt(t) ? 'ARMED' : ''].filter(Boolean).join(' · '))}</span>`;
    if (pose) {
      const P = pose.P, A = pose.A, Q = posAt(this.posD, t - 1e6);
      let spd = NaN;
      if (Q) { const mm = GEO.mPerDeg(P.lat); spd = Math.hypot((P.lat - Q.lat) * mm.lat, (P.lon - Q.lon) * mm.lon, P.alt - Q.alt); }
      html += `<br>Alt ${fmtNum(P.alt, 5)} m · ${fmtNum(P.alt - this.home.alt, 4)} m above takeoff`;
      html += `<br>Speed ${isFinite(spd) ? spd.toFixed(1) + ' m/s' : '–'} · heading ${Math.round(((A.yaw % 360) + 360) % 360)}°`;
      html += `<br>Roll ${A.roll.toFixed(1)}° · pitch ${A.pitch.toFixed(1)}°`;
    } else html += '<br>No position at this time';
    if (this.under !== null && this.under !== undefined) html += `<br>Camera under water, ${this.under.toFixed(1)} m deep`;
    if (this.hud.innerHTML !== html) this.hud.innerHTML = html;
  },
  terrainHeightAt(lat, lon) {
    const top = this.fr.toScene(lat, lon, 12000, [0, 0, 0]), bot = this.fr.toScene(lat, lon, -2000, [0, 0, 0]);
    const o = new THREE.Vector3(...top), d = new THREE.Vector3(...bot).sub(o).normalize();
    this.ray.set(o, d); this.ray.far = 14000;
    const meshes = [...this.tiles.cache.values()].filter(t => t.mesh && t.state === 'ready').map(t => t.mesh);
    const hit = this.ray.intersectObjects(meshes, false).sort((a, b) => a.distance - b.distance)[0];
    return hit ? 12000 - hit.distance : null;
  },
  /** Z offset that puts the takeoff point on the ground (terrain if loaded, else the map surface). */
  snapToGround() {
    const c = this.cfg, H = this.home; if (!H) return null;
    const hit = c.terrain ? this.terrainHeightAt(H.lat, H.lon) : null;
    const ground = hit !== null ? hit : this.surfH(H.lat, H.lon);
    // the vehicle path at takeoff sits at vz(href + zoff + dz) when paths are stretched, else at href + zoff + dz
    const k = c.stretchPaths ? this.exag() : 1;
    const zoff = (ground - this.href()) / k - this.dzOf(c.vehicle) + 0.3;
    return { zoff: Math.round(zoff * 10) / 10, onTerrain: hit !== null };
  },
  /** Height offset for path src that matches the vehicle path over the first seconds after takeoff. */
  matchOffset(src) {
    const c = this.cfg, a = posData(c.vehicle, c.dropJumps), b = posData(src, c.dropJumps); if (!a || !b || !a.alt || !b.alt) return null;
    const ix = st.ix, t0 = ix.armed.length ? ix.armed[0].t0 : Math.max(a.t[0], b.t[0]);
    const diffs = [];
    for (let k = 0; k < 20; k++) { const t = t0 + 1e6 + k * 0.5e6, P = posAt(a, t), Q = posAt(b, t); if (P && Q) diffs.push(P.alt - Q.alt); }
    if (!diffs.length) return null;
    diffs.sort((x, y) => x - y);
    return Math.round((diffs[diffs.length >> 1] + this.dzOf(c.vehicle)) * 10) / 10;
  },
  pickTime(x, y) {
    if (!this.pick || !this.pick.length) return null;
    const v = new THREE.Vector3(); let best = null, bd = 14 * 14;
    for (const p of this.pick) {
      const step = Math.max(1, Math.floor(p.t.length / 20000));
      for (let i = 0; i < p.t.length; i += step) {
        v.set(p.pts[i * 3], p.pts[i * 3 + 1], p.pts[i * 3 + 2]).project(this.camera);
        if (v.z > 1) continue;
        const sx = (v.x + 1) / 2 * this.w, sy = (1 - v.y) / 2 * this.h, d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
        if (d < bd) { bd = d; best = p.t[i]; }
      }
    }
    return best;
  },
  /** Switch to the free camera without moving the view. */
  toFree() {
    const c = this.cfg; if (!c || c.camera === 'free') return;
    if (c.camera === 'follow' && this.lastPose) this.cam.az += this.lastPose.A.yaw;
    this.cam.target = this.lastTarget ? this.lastTarget.clone() : null;
    c.camera = 'free';
    const sel = this.g && this.g._el.root.querySelector('select[id$="-cam"]'); if (sel) sel.value = 'free';
    changed();
  },
  /** Directions on the ground: forward is where the camera looks, flattened. */
  groundAxes(up) {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    right.sub(up.clone().multiplyScalar(right.dot(up))).normalize();
    const fwd = new THREE.Vector3().crossVectors(up, right).normalize();
    return { right, fwd };
  },
  fly(dt, up) {
    const K = this.keys, fast = K.has('shift') ? 4 : 1, v = Math.max(5, this.cam.dist) * 0.9 * fast * dt;
    const { right, fwd } = this.groundAxes(up);
    const m = new THREE.Vector3();
    if (K.has('w')) m.add(fwd); if (K.has('s')) m.sub(fwd);
    if (K.has('d')) m.add(right); if (K.has('a')) m.sub(right);
    if (K.has('e')) m.add(up); if (K.has('q')) m.sub(up);
    if (m.lengthSq()) this.cam.target.add(m.normalize().multiplyScalar(v));
  },
  updateHint() {
    const el = this.wrap && this.wrap.querySelector('.v3-help'); if (!el) return;
    const txt = this.cfg.camera === 'free'
      ? 'Drag to turn · right-drag or Shift-drag to move · W A S D to fly, Q E down and up · scroll to zoom · double-click to go back to the vehicle'
      : 'Drag to turn, also below the vehicle · scroll to zoom · right-drag or W A S D to move freely · double-click to reset';
    if (el.textContent !== txt) el.textContent = txt;
  },
  attachEvents(cv) {
    const ptrs = new Map();
    let drag = null;
    this.keys = new Set();
    cv.tabIndex = 0;
    cv.setAttribute('aria-label', '3D view. Drag to turn, right-drag to move, W A S D to fly.');
    cv.addEventListener('pointerdown', e => {
      if (!this.g) return;
      cv.focus({ preventScroll: true });
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, pan: e.button === 2 || e.button === 1 || e.shiftKey, az: this.cam.az, el: this.cam.el, dist: this.cam.dist, pinch: ptrs.size === 2 ? this.pinchDist(ptrs) : 0 };
    });
    cv.addEventListener('pointermove', e => {
      if (!drag || !ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y, mx = e.clientX - drag.lx, my = e.clientY - drag.ly;
      drag.lx = e.clientX; drag.ly = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (ptrs.size === 2 && drag.pinch) { this.cam.dist = clamp(drag.dist * drag.pinch / Math.max(10, this.pinchDist(ptrs)), 2, 2e5); this.req(); return; }
      if (drag.pan) {
        if (!drag.moved) return;
        if (this.cfg.camera !== 'free') { this.toFree(); drag.az = this.cam.az; }
        if (!this.cam.target) return;
        const up = this.camera.up.clone(), { right, fwd } = this.groundAxes(up), k = this.cam.dist / this.h * 1.4;
        this.cam.target.add(right.multiplyScalar(-mx * k)).add(fwd.multiplyScalar(my * k));
      } else {
        this.cam.az = drag.az + dx * 0.35;
        this.cam.el = clamp(drag.el + dy * 0.3, -89, 89);
      }
      this.req();
    });
    const up = e => {
      ptrs.delete(e.pointerId);
      if (drag && !drag.moved && e.type === 'pointerup' && e.button === 0 && !e.shiftKey) {
        const r = cv.getBoundingClientRect(), t = this.pickTime(e.clientX - r.left, e.clientY - r.top);
        if (t !== null) { st.pin = t; requestDraw(); }
      }
      if (!ptrs.size) drag = null;
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => {
      if (!this.g) return;
      e.preventDefault();
      this.cam.dist = clamp(this.cam.dist * Math.pow(1.0015, e.deltaY * (e.deltaMode === 1 ? 30 : 1)), 2, 2e5);
      this.req();
    }, { passive: false });
    cv.addEventListener('dblclick', () => { this.cam.fresh = true; this.req(); });
    const KEYMAP = { w: 'w', a: 'a', s: 's', d: 'd', q: 'q', e: 'e', arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd', pageup: 'e', pagedown: 'q' };
    cv.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = KEYMAP[e.key.toLowerCase()];
      if (!k) return;
      e.preventDefault(); e.stopPropagation();
      if (this.cfg.camera !== 'free') this.toFree();
      this.keys.add(k); if (e.shiftKey) this.keys.add('shift');
      this.req();
    });
    cv.addEventListener('keyup', e => {
      const k = KEYMAP[e.key.toLowerCase()];
      if (k) { this.keys.delete(k); e.stopPropagation(); }
      if (e.key === 'Shift') this.keys.delete('shift');
    });
    cv.addEventListener('blur', () => this.keys.clear());
  },
  pinchDist(ptrs) { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); },
  imageOf() { if (!this.renderer || !this.g) return null; this.render(); return this.renderer.domElement; }
};

/* ---------- the 3D card ---------- */
function buildGraph3d(g) {
  const root = h('section', 'graph g3d');
  root.dataset.id = g.id;
  const head = h('div', 'g-head');
  const title = h('input', 'g-title'); title.id = `g${g.id}-title`; title.value = g.title; title.spellcheck = false; title.setAttribute('aria-label', 'Graph title');
  const fitTitle = () => { title.style.width = Math.min(48, Math.max(8, title.value.length + 2)) + 'ch'; }; fitTitle();
  title.addEventListener('input', fitTitle);
  title.addEventListener('change', () => { g.title = title.value.trim() || '3D view'; changed(); });
  title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') title.blur(); });
  const camSel = h('select', 'sel'); camSel.id = `g${g.id}-cam`; camSel.setAttribute('aria-label', 'Camera');
  for (const [v, l] of [['follow', 'Camera: follow behind'], ['north', 'Camera: follow, north up'], ['free', 'Camera: free']]) { const o = h('option', null, l); o.value = v; camSel.append(o); }
  camSel.value = g.v3.camera;
  camSel.onchange = () => { g.v3.camera = camSel.value; V3.cam.fresh = true; changed(); V3.req(); };
  const resetCam = h('button', 'btn small ghost', 'Reset view'); resetCam.type = 'button'; resetCam.title = 'Put the camera back behind the vehicle (or double-click the view)';
  resetCam.onclick = () => { V3.cam.fresh = true; V3.req(); };
  resetCam.title = 'Put the camera back on the vehicle (or double-click the view)';
  const acts = h('span', 'g-acts');
  acts.append(pinBtn(g), iconBtn(ICON.up, g.pin ? 'Move up in the pinned panels' : 'Move up', () => moveGraph(g, -1)), iconBtn(ICON.down, g.pin ? 'Move down in the pinned panels' : 'Move down', () => moveGraph(g, 1)), iconBtn(ICON.close, 'Remove 3D view', () => removeGraph(g)));
  root.classList.toggle('pinned', !!g.pin);
  head.append(title, h('span', 'badge3d', '3D'), camSel, resetCam, acts);
  const wrap = h('div', 'v3-wrap');
  const hud = h('div', 'v3-hud'), attr = h('div', 'v3-attr'), stat = h('div', 'v3-stat'), msgEl = h('p', 'v3-msg'), under = h('div', 'v3-under');
  stat.hidden = true; msgEl.hidden = true; under.hidden = true;
  const help = h('div', 'v3-help', 'Drag to turn · scroll to zoom · click the path to jump there · double-click to reset');
  wrap.append(under, hud, msgEl, stat, attr, help);
  const rz = h('div', 'g-resize'); rz.title = 'Drag to change the height';
  const set = h('details', 'v3-set'); set.open = !!g._setOpen;
  set.addEventListener('toggle', () => { g._setOpen = set.open; });
  set.append(h('summary', null, 'Paths, vehicle, map, heights and water'));
  const body = h('div', 'v3-grid'); set.append(body);
  root.append(head, wrap, rz, set);
  g._el = { root, title, wrap, rz, body, plot: wrap, base: null, over: null, fields: h('div'), resetY: h('span'), fReset: h('span'), specOpts: h('span'), seg: h('span') };
  root.addEventListener('pointerdown', () => setActive(g), true);
  attachResize(g);
  fill3dSettings(g);
  return root;
}
function fill3dSettings(g) {
  const body = g._el && g._el.body; if (!body) return;
  const c = g.v3, id = k => `g${g.id}-${k}`;
  body.replaceChildren();
  if (!st.ix) { body.append(h('p', 'note', 'Open a log to set up the 3D view.')); return; }
  const S = v3Sources();
  V3.sources = S; V3.cfg = c; if (S.pos.length) V3.fillDefaults(c);
  const commit = (rebuild) => { changed(); if (rebuild) fill3dSettings(g); V3.apply(); };
  const sec = (title) => { const s = h('section', 'v3-sec'); s.append(h('h4', null, title)); body.append(s); return s; };
  const row = (parent, label, el, hint) => { const l = h('label', 'v3-row'); l.append(h('span', null, label), el); if (hint) l.title = hint; parent.append(l); return l; };
  const select = (k, opts, onCh) => { const s = h('select', 'sel'); s.id = id(k); for (const [v, l] of opts) { const o = h('option', null, l); o.value = v; s.append(o); } s.value = String(c[k]); s.onchange = () => { c[k] = s.value; if (onCh) onCh(); else commit(); }; return s; };
  const check = (k, label, onCh) => { const l = h('label', 'v3-check'); const b = h('input'); b.type = 'checkbox'; b.id = id(k); b.checked = !!c[k]; b.onchange = () => { c[k] = b.checked; if (onCh) onCh(); else commit(); }; l.append(b, document.createTextNode(label)); return l; };

  const num = (k, o) => {
    const i = h('input', 'inp num'); i.id = id(k); i.type = 'number'; i.step = String(o.step || 1); if (o.min !== undefined) i.min = String(o.min); if (o.max !== undefined) i.max = String(o.max);
    i.value = c[k]; i.style.width = o.width || '5.5em';
    const set = v => { v = clamp(Number.isFinite(v) ? v : V3DEF[k], o.min !== undefined ? o.min : -1e6, o.max !== undefined ? o.max : 1e6); c[k] = Math.round(v * 100) / 100; i.value = c[k]; changed(); V3.apply(); };
    i.onchange = () => set(parseFloat(i.value));
    const wrapEl = h('div', 'v3-inline');
    for (const d of o.steps || []) { const b = h('button', 'btn small', (d > 0 ? '+' : '−') + Math.abs(d)); b.type = 'button'; b.onclick = () => set((Number(c[k]) || 0) + d); if (d < 0) wrapEl.append(b); }
    wrapEl.append(i);
    for (const d of o.steps || []) { if (d > 0) { const b = h('button', 'btn small', '+' + d); b.type = 'button'; b.onclick = () => set((Number(c[k]) || 0) + d); wrapEl.append(b); } }
    return wrapEl;
  };

  // paths
  const P = sec('Paths');
  const list = h('div', 'v3-paths');
  const ph = h('div', 'v3-path v3-phead');
  ph.append(h('span'), h('span'), h('span', null, 'Source'), h('span', null, 'Height offset, m'), h('span'), h('span', null, 'Vehicle'));
  list.append(ph);
  for (const p of c.pos) {
    const r = h('div', 'v3-path');
    const on = h('input'); on.type = 'checkbox'; on.checked = p.on; on.id = id('p-' + p.src); on.setAttribute('aria-label', 'Show ' + p.src);
    on.onchange = () => { p.on = on.checked; commit(); };
    const sw = h('button', 'f-sw'); sw.type = 'button'; sw.style.setProperty('--c', `var(--c${(p.color % NC) + 1})`); sw.title = 'Change colour'; sw.setAttribute('aria-label', 'Colour of ' + p.src);
    sw.onclick = () => { p.color = (p.color + 1) % NC; sw.style.setProperty('--c', `var(--c${p.color + 1})`); commit(); };
    const lab = h('label', 'mono', p.src); lab.htmlFor = on.id;
    const dz = h('input', 'inp num'); dz.type = 'number'; dz.step = '0.5'; dz.id = id('dz-' + p.src); dz.value = p.dz || 0;
    dz.setAttribute('aria-label', 'Height offset of ' + p.src + ' in metres'); dz.title = 'Moves this path up (+) or down (−), in metres';
    dz.onchange = () => { p.dz = Math.round((parseFloat(dz.value) || 0) * 100) / 100; dz.value = p.dz; changed(); V3.apply(); };
    const match = h('button', 'icon-btn', '≡'); match.type = 'button'; match.title = `Match the height of the vehicle path (${c.vehicle}) just after takeoff`;
    match.setAttribute('aria-label', 'Match ' + p.src + ' to the vehicle path height');
    match.disabled = p.src === c.vehicle;
    match.onclick = () => {
      const v = V3.matchOffset(p.src);
      if (v === null) { toast(`Could not compare ${p.src} with ${c.vehicle}: one of them has no altitude after takeoff.`); return; }
      p.dz = v; dz.value = v; p.on = true; on.checked = true; changed(); V3.apply();
      toast(`${p.src} moved ${v >= 0 ? 'up' : 'down'} ${Math.abs(v)} m to match ${c.vehicle} after takeoff.`);
    };
    const rb = h('input'); rb.type = 'radio'; rb.name = id('veh'); rb.checked = c.vehicle === p.src; rb.id = id('v-' + p.src);
    rb.setAttribute('aria-label', 'The vehicle follows ' + p.src); rb.title = 'The vehicle follows this path';
    rb.onchange = () => { c.vehicle = p.src; p.on = true; commit(true); };
    r.append(on, sw, lab, dz, match, rb); list.append(r);
  }
  P.append(list);
  row(P, 'Show', select('range', [['all', 'Whole log'], ['view', 'Time range shown in the graphs']]));
  row(P, 'Colour', select('colorBy', [['source', 'One colour per source'], ['mode', 'By flight mode']]));
  P.append(check('dropJumps', 'Hide position jumps (faster than 600 m/s)'));
  const jl = h('div', 'v3-sub v3-jumps'); jl.hidden = true; P.append(jl);
  P.append(check('curtain', 'Curtain down to takeoff height'), check('waypoints', 'Mission waypoints (CMD)'));

  // vehicle
  const Vs = sec('Vehicle');
  const attOpts = S.att.map(a => [a.id, a.label]); if (!attOpts.length) attOpts.push(['', 'None in this log: heading from the path']);
  row(Vs, 'Attitude from', select('att', attOpts));
  const modelOpts = [['plane', 'Plane (built in)'], ['quad', 'Quadcopter (built in)']];
  if (c.modelName) modelOpts.push(['custom', c.modelName]);
  row(Vs, 'Model', select('model', modelOpts));
  const fileIn = h('input'); fileIn.type = 'file'; fileIn.accept = '.glb,.gltf,.obj,.stl'; fileIn.hidden = true; fileIn.id = id('mfile');
  const loadBtn = h('button', 'btn small', 'Load model file…'); loadBtn.type = 'button'; loadBtn.title = '.glb, .gltf (embedded), .obj or .stl';
  loadBtn.onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const f = fileIn.files[0]; fileIn.value = ''; if (!f) return;
    try {
      const data = await f.arrayBuffer();
      await modelFromFile(f.name, data.slice(0));
      await IDB.put('model', { name: f.name, data });
      const lower = f.name.toLowerCase();
      c.model = 'custom'; c.modelName = f.name;
      c.rot = lower.endsWith('.stl') ? [0, -90, 0] : lower.endsWith('.glb') || lower.endsWith('.gltf') ? [180, 0, 0] : [0, 0, 0];
      commit(true);
      toast(`Loaded ${f.name}. Use Turn to point its nose forward if needed.`);
    } catch (e) { toast('Could not load the model: ' + e.message); }
  };
  Vs.append(h('div', 'v3-inline', null)); Vs.lastChild.append(loadBtn, fileIn);
  const size = h('input', 'inp num'); size.id = id('size'); size.type = 'number'; size.min = '0.1'; size.step = '0.1'; size.value = c.modelSize; size.style.width = '6em';
  size.onchange = () => { c.modelSize = clamp(parseFloat(size.value) || 2.5, 0.05, 100); changed(); V3.req(); };
  row(Vs, 'Size (m)', size, 'Longest side of the model in metres');
  Vs.append(check('keepVisible', 'Enlarge when far away so it stays visible', () => { changed(); V3.req(); }));
  const turn = h('div', 'v3-turn');
  ['Yaw', 'Pitch', 'Roll'].forEach((nm, k) => {
    const val = h('span', 'mono', `${c.rot[k]}°`);
    const mk = (d) => { const b = h('button', 'btn small', (d > 0 ? '+' : '−') + '90°'); b.type = 'button'; b.title = `Turn the model ${nm.toLowerCase()} ${d > 0 ? '+' : '−'}90°`; b.onclick = () => { c.rot[k] = ((c.rot[k] + d + 540) % 360) - 180; val.textContent = `${c.rot[k]}°`; changed(); V3.applyFix(); V3.req(); }; return b; };
    const r = h('div', 'v3-turnrow'); r.append(h('span', null, nm), mk(-90), val, mk(90)); turn.append(r);
  });
  Vs.append(h('div', 'v3-sub', 'Turn the model if its nose does not point forward:'), turn);

  // map
  const Mp = sec('Map and terrain');
  row(Mp, 'Map', select('imagery', Object.entries(IMAGERY).map(([k, v]) => [k, v.label]), () => commit(true)));
  if (c.imagery === 'custom') {
    const url = h('input', 'inp mono'); url.id = id('xyz'); url.value = c.imageryUrl; url.placeholder = 'https://server/{z}/{x}/{y}.png'; url.spellcheck = false;
    const mx = h('input', 'inp num'); mx.id = id('xyzmax'); mx.type = 'number'; mx.min = '1'; mx.max = '23'; mx.value = c.imageryMax; mx.style.width = '4.5em';
    const at = h('input', 'inp'); at.id = id('xyzattr'); at.value = c.imageryAttr; at.placeholder = 'Attribution, e.g. © My tiles';
    const ap = h('button', 'btn small primary', 'Use this server'); ap.type = 'button';
    ap.onclick = () => { c.imageryUrl = url.value.trim(); c.imageryMax = clamp(parseInt(mx.value, 10) || 19, 1, 23); c.imageryAttr = at.value.trim(); commit(); };
    Mp.append(h('div', 'v3-sub', 'Tile link with {z}, {x} and {y}. Also understood: {-y} for TMS rows, {s} for a, b, c servers, {q} for a Bing quadkey.'), url);
    row(Mp, 'Max zoom', mx); Mp.append(at, ap);
  }
  Mp.append(check('terrain', 'Terrain (quantized-mesh)', () => commit(true)));
  if (c.terrain) {
    const tu = h('input', 'inp mono'); tu.id = id('terrainurl'); tu.value = c.terrainUrl; tu.placeholder = 'https://server/terrain/layer.json'; tu.spellcheck = false;
    const tb = h('button', 'btn small primary', 'Load terrain'); tb.type = 'button';
    tb.onclick = () => { c.terrainUrl = tu.value.trim(); commit(); };
    tu.addEventListener('keydown', e => { if (e.key === 'Enter') tb.click(); });
    Mp.append(h('div', 'v3-sub', 'Link to layer.json, or to the folder that holds it. Gzipped tiles and the octvertexnormals extension are fine.'), tu, tb);
    Mp.append(check('terrainMsl', 'Terrain heights are above sea level (not the ellipsoid)'));
    const ex = num('exag', { step: 0.5, min: 0.1, max: 50, width: '4.5em' });
    for (const k of [1, 2, 3, 5]) { const b = h('button', 'btn small' + (Number(c.exag) === k ? ' on' : ''), '×' + k); b.type = 'button'; b.onclick = () => { c.exag = k; changed(); fill3dSettings(g); V3.apply(); }; ex.append(b); }
    const exl = h('label', 'v3-sub', 'Stretch heights ×'); exl.htmlFor = id('exag');
    Mp.append(exl, ex, h('div', 'v3-sub', 'Stretches terrain heights around the takeoff height, so takeoff stays in place. Also stretch:'),
      check('stretchPaths', 'Paths and vehicle (keeps their height over terrain)'), check('stretchWater', 'Water'));
  }
  Mp.append(h('p', 'note', 'Tiles come from the server you choose and need a connection. The server must allow cross-origin requests (CORS).'));

  // heights
  const Hs = sec('Heights');
  row(Hs, 'Ground surface', select('surface', [['geoid', 'Geoid (mean sea level, EGM96)'], ['ellipsoid', 'WGS84 ellipsoid'], ['sphere', 'Sphere']], () => { V3.cam.fresh = true; commit(); }));
  Hs.append(check('amsl', 'Log altitudes are above sea level (add geoid height)'));
  const zo = h('input', 'inp num'); zo.id = id('zoff'); zo.type = 'number'; zo.step = '1'; zo.value = c.zoff; zo.style.width = '5.5em';
  const setZ = v => { c.zoff = Math.round(v * 10) / 10; zo.value = c.zoff; changed(); V3.apply(); };
  zo.onchange = () => setZ(parseFloat(zo.value) || 0);
  const zb = (d) => { const b = h('button', 'btn small', (d > 0 ? '+' : '−') + Math.abs(d)); b.type = 'button'; b.onclick = () => setZ((Number(c.zoff) || 0) + d); return b; };
  const zr = h('div', 'v3-inline'); zr.append(zb(-10), zb(-1), zo, zb(1), zb(10));
  const zl = h('label', 'v3-sub', 'Z offset of paths and vehicle (m)'); zl.htmlFor = zo.id;
  Hs.append(zl, zr);
  const snap = h('button', 'btn small', 'Put takeoff on the ground'); snap.type = 'button';
  snap.title = 'Sets the Z offset so the first armed point sits on the terrain, or on the map surface without terrain';
  snap.onclick = () => { const r = V3.snapToGround(); if (!r) return; setZ(r.zoff); toast(`Z offset set to ${r.zoff} m ${r.onTerrain ? 'from the terrain under takeoff' : 'from the map surface'}.`); };
  Hs.append(snap);

  // water
  const Wt = sec('Water');
  Wt.append(check('water', 'Water layer', () => commit(true)));
  if (c.water) {
    const wb = h('label', 'v3-sub', 'Surface at, m above sea level'); wb.htmlFor = id('waterLevel');
    Wt.append(wb, num('waterLevel', { step: 1, steps: [-10, 10] }));
    const wd = h('label', 'v3-sub', 'Depth below the surface, m'); wd.htmlFor = id('waterDepth');
    Wt.append(wd, num('waterDepth', { step: 1, min: 0.1, max: 20000, steps: [-5, 5] }));
    // colour
    const cl = h('label', 'v3-sub', 'Colour'); cl.htmlFor = id('waterColor');
    const cw = h('div', 'v3-inline v3-colors');
    const pick = h('input', 'v3-color'); pick.type = 'color'; pick.id = id('waterColor'); pick.value = /^#[0-9a-f]{6}$/i.test(c.waterColor || '') ? c.waterColor : V3DEF.waterColor;
    const setCol = (v, commitIt) => { c.waterColor = v; pick.value = v; for (const b of cw.querySelectorAll('.v3-preset')) b.setAttribute('aria-pressed', String(b.dataset.c === v)); V3.updateWaterLook(); if (commitIt) changed(); };
    pick.addEventListener('input', () => setCol(pick.value, false));
    pick.addEventListener('change', () => setCol(pick.value, true));
    cw.append(pick);
    for (const [nm, hex] of [['Teal', '#14a3a3'], ['Tropical', '#25c9c0'], ['Ocean', '#1d63b0'], ['Lake', '#3d7d68'], ['Murky', '#6e7a4c']]) {
      const b = h('button', 'v3-preset'); b.type = 'button'; b.dataset.c = hex; b.style.background = hex; b.title = nm; b.setAttribute('aria-label', nm + ' water');
      b.setAttribute('aria-pressed', String(c.waterColor === hex)); b.onclick = () => setCol(hex, true); cw.append(b);
    }
    Wt.append(cl, cw);
    // opacity above and under
    const slider = (k, label) => {
      const l = h('label', 'v3-slide'); const top = h('span', null, label), val = h('b', 'mono', c[k] + '%');
      const r = h('input'); r.type = 'range'; r.min = '0'; r.max = '100'; r.step = '1'; r.id = id(k); r.value = c[k];
      r.addEventListener('input', () => { c[k] = Number(r.value); val.textContent = r.value + '%'; V3.updateWaterLook(); });
      r.addEventListener('change', () => changed());
      const row1 = h('span', 'v3-slide-top'); row1.append(top, val); l.append(row1, r); return l;
    };
    Wt.append(slider('waterAbove', 'Opacity seen from above'), slider('waterUnder', 'Opacity under water'));
    Wt.append(check('waves', 'White waves on the surface', () => { changed(); fill3dSettings(g); V3.updateWaterLook(); }));
    if (c.waves) Wt.append(check('wavesMove', 'Moving waves', () => { changed(); V3.req(); }));
    Wt.append(h('div', 'v3-sub', 'A see-through layer over the map area, from the surface down. Inside it, the view takes on the water colour.'));
  }
}

/* ---------- integration ---------- */
function sync3d() {
  const g = st.graphs.find(x => x.type === '3d' && x._el && x._el.wrap);
  if (!g) { V3.detach(); return; }
  if (!HAS3D) { if (!g._el.wrap.querySelector('.v3-msg:not([hidden])')) { const m = g._el.wrap.querySelector('.v3-msg'); m.textContent = '3D needs three.js, which did not load. Check the connection, or use the offline file.'; m.hidden = false; } return; }
  V3.attach(g, g._el.wrap);
}
function add3dView() {
  const ex = st.graphs.find(g => g.type === '3d');
  if (ex) { setActive(ex); ex._el && ex._el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); toast('There is already a 3D view.'); return; }
  const g = insertGraph(mkGraph({ title: '3D flight', type: '3d', height: 420 }), 0);
  renderGraphs(); changed();
  setTimeout(() => g._el && g._el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
}
$('add3d').onclick = add3dView;
$('playBtn').onclick = () => playToggle();
$('playSpeed').onchange = () => { PLAY.speed = parseFloat($('playSpeed').value) || 1; };
updatePlayUI();
