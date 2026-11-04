/* ================= 3D view: sources, models, map tiles, terrain ================= */
const HAS3D = typeof THREE !== 'undefined' && !!THREE.LineSegments2;
const V3DEF = {
  pos: [], vehicle: '', att: '', model: 'plane', modelName: '', modelSize: 2.5, keepVisible: true, rot: [0, 0, 0],
  imagery: 'esri', imageryUrl: '', imageryMax: 19, imageryAttr: '',
  terrain: false, terrainUrl: '', terrainMsl: false, exag: 1, stretchPaths: false, stretchWater: false,
  water: false, waterLevel: 0, waterDepth: 10, waterColor: '#14a3a3', waterAbove: 30, waterUnder: 45, waves: true, wavesMove: true,
  surface: 'geoid', amsl: true, zoff: 0,
  camera: 'follow', range: 'all', colorBy: 'source', curtain: false, waypoints: true
};
/* A page that hosts the plotter (a ground station serving its own imagery and terrain, say)
   can offer them by setting this before the scripts run:
     window.DFPLOT_HOST = {
       imagery: { key: { label, url, max, attr }, ... },    // listed first under Map
       defaults: { imagery: 'key', terrain: true, terrainUrl: '/terrain/layer.json', terrainMsl: true }
     };
   The defaults apply to new 3D views. Without it the page works exactly as before. */
const HOST = (() => {
  const h = typeof window !== 'undefined' ? window.DFPLOT_HOST : null;
  return h && typeof h === 'object' ? h : {};
})();
const IMAGERY_BUILTIN = {
  esri: { label: 'Satellite (Esri World Imagery)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 19, attr: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  osm: { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '© OpenStreetMap contributors' },
  otm: { label: 'OpenTopoMap', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', max: 17, attr: '© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)' },
  carto: { label: 'CARTO Voyager', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', max: 19, attr: '© OpenStreetMap contributors © CARTO' },
  none: { label: 'No map', url: '', max: 0, attr: '' },
  custom: { label: 'Custom XYZ server…', url: '', max: 19, attr: '' }
};
const IMAGERY = (() => {
  const out = {};
  const hi = HOST.imagery && typeof HOST.imagery === 'object' ? HOST.imagery : {};
  for (const [k, v] of Object.entries(hi)) {
    if (IMAGERY_BUILTIN[k] || !v || typeof v.url !== 'string' || !v.url) continue;
    out[k] = { label: String(v.label || k), url: v.url, max: clamp(Number(v.max) || 19, 1, 23), attr: String(v.attr || '') };
  }
  return Object.assign(out, IMAGERY_BUILTIN);
})();
for (const [k, v] of Object.entries(HOST.defaults && typeof HOST.defaults === 'object' ? HOST.defaults : {})) {
  if (k in V3DEF && typeof v === typeof V3DEF[k] && !Array.isArray(V3DEF[k])) V3DEF[k] = v;
}
if (!IMAGERY[V3DEF.imagery]) V3DEF.imagery = 'esri';
const QM_ACCEPT = 'application/vnd.quantized-mesh;extensions=octvertexnormals,application/octet-stream;q=0.9,*/*;q=0.01';
const NO_POS = new Set(['CMD', 'ORGN', 'RALY', 'TERR', 'FNCE', 'HOME', 'MISE', 'GPA', 'POWR', 'FENC']);

/** Position and attitude sources in the open log. */
function v3Sources() {
  const ix = st.ix, pos = [], att = [];
  if (!ix) return { pos, att };
  for (const ty of ix.types) {
    if (ty.count < 10) continue;
    const cols = new Set(ty.cols.map(c => c.col));
    const ids = ty.multi ? ty.insts.map(i => `${ty.name}[${i}]`) : [ty.name];
    if (cols.has('Lat') && cols.has('Lng') && !NO_POS.has(ty.name)) for (const id of ids) pos.push(id);
    if (cols.has('Roll') && cols.has('Pitch') && cols.has('Yaw')) for (const id of ids) att.push({ id, label: id + ' (roll, pitch, yaw)' });
    if (['Q1', 'Q2', 'Q3', 'Q4'].every(c => cols.has(c))) for (const id of ids) att.push({ id: id + ':q', label: id + ' (quaternion)' });
  }
  const rank = s => { const n = s.replace(/[[:].*/, ''); return n === 'POS' ? 0 : n === 'GPS' ? 1 : n === 'AHR2' ? 2 : 3; };
  pos.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const arank = s => { const n = s.id.replace(/[[:].*/, ''); return n === 'ATT' ? 0 : n === 'AHR2' ? 1 : /^(XKQ|NKQ)/.test(n) ? 2 : 3; };
  att.sort((a, b) => arank(a) - arank(b) || (a.id < b.id ? -1 : 1));
  return { pos, att };
}
function posData(src) {
  const ix = st.ix; if (!ix || !src) return null;
  const f = k => ix.fieldIndex.get(src + '.' + k);
  const la = f('Lat'), lo = f('Lng'), al = f('Alt');
  if (!la || !lo) return null;
  return { t: la.series.t, lat: la.series.v, lon: lo.series.v, alt: al ? al.series.v : null };
}
function attData(id) {
  const ix = st.ix; if (!ix || !id) return null;
  const q = id.endsWith(':q'), src = q ? id.slice(0, -2) : id;
  const f = k => { const x = ix.fieldIndex.get(src + '.' + k); return x ? x.series : null; };
  if (q) { const a = f('Q1'), b = f('Q2'), c = f('Q3'), d = f('Q4'); return a && b && c && d ? { q: true, t: a.t, a: a.v, b: b.v, c: c.v, d: d.v } : null; }
  const r = f('Roll'), p = f('Pitch'), y = f('Yaw');
  return r && p && y ? { q: false, t: r.t, r: r.v, p: p.v, y: y.v } : null;
}
const validLL = (la, lo) => la === la && lo === lo && (la !== 0 || lo !== 0) && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
/** Interpolated position at time t (µs), or null. */
function posAt(d, t) {
  if (!d) return null;
  const T = d.t, n = T.length; if (!n) return null;
  let i = EX.lowerBound(T, t);
  if (i >= n) i = n - 1;
  let j = i > 0 ? i - 1 : i;
  if (T[i] - T[j] > 5e6 || t <= T[j]) { const k = Math.abs(T[i] - t) < Math.abs(T[j] - t) ? i : j; return validLL(d.lat[k], d.lon[k]) ? { lat: d.lat[k], lon: d.lon[k], alt: d.alt ? d.alt[k] : 0, i: k } : null; }
  if (!validLL(d.lat[i], d.lon[i]) || !validLL(d.lat[j], d.lon[j])) return null;
  const f = Math.min(1, Math.max(0, (t - T[j]) / (T[i] - T[j] || 1)));
  return { lat: d.lat[j] + (d.lat[i] - d.lat[j]) * f, lon: d.lon[j] + (d.lon[i] - d.lon[j]) * f, alt: d.alt ? d.alt[j] + (d.alt[i] - d.alt[j]) * f : 0, i };
}
/** Roll, pitch, yaw in degrees at time t. Quaternions are ArduPilot NED-to-body (Q1 = w). */
function attAt(d, t) {
  if (!d) return null;
  const T = d.t, n = T.length; if (!n) return null;
  let i = EX.lowerBound(T, t); if (i >= n) i = n - 1;
  const j = i > 0 ? i - 1 : i;
  const f = T[i] > T[j] && T[i] - T[j] < 2e6 ? Math.min(1, Math.max(0, (t - T[j]) / (T[i] - T[j]))) : (Math.abs(T[i] - t) < Math.abs(T[j] - t) ? 1 : 0);
  if (d.q) {
    let a = d.a[i], b = d.b[i], c = d.c[i], e = d.d[i];
    const a0 = d.a[j], b0 = d.b[j], c0 = d.c[j], e0 = d.d[j];
    const s = (a * a0 + b * b0 + c * c0 + e * e0) < 0 ? -1 : 1;
    a = a0 + (a * s - a0) * f; b = b0 + (b * s - b0) * f; c = c0 + (c * s - c0) * f; e = e0 + (e * s - e0) * f;
    const m = Math.hypot(a, b, c, e) || 1; a /= m; b /= m; c /= m; e /= m;
    const roll = Math.atan2(2 * (a * b + c * e), 1 - 2 * (b * b + c * c));
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (a * c - e * b))));
    const yaw = Math.atan2(2 * (a * e + b * c), 1 - 2 * (c * c + e * e));
    return { roll: roll / GEO.D2R, pitch: pitch / GEO.D2R, yaw: yaw / GEO.D2R };
  }
  const lerpA = (x, y) => { let dd = ((y - x + 540) % 360) - 180; return x + dd * f; };
  return { roll: lerpA(d.r[j], d.r[i]), pitch: d.p[j] + (d.p[i] - d.p[j]) * f, yaw: lerpA(d.y[j], d.y[i]) };
}

/* ---------- vehicle models: forward is -Z, up is +Y, right is +X, longest side 1 ---------- */
function mat(color, extra) { return new THREE.MeshLambertMaterial(Object.assign({ color }, extra || {})); }
function planeModel() {
  const g = new THREE.Group();
  const body = mat(0xf1f3f6), trim = mat(0x1f5bc4), glass = mat(0x23303f), dark = mat(0x2a2d33), red = mat(0xc0352b);
  const prof = [[0.001, 0], [0.3, 0.05], [0.5, 0.3], [0.6, 0.7], [0.66, 1.4], [0.68, 2.6], [0.62, 3.5], [0.48, 4.6], [0.3, 6.0], [0.17, 7.4], [0.07, 8.1]];
  const lathe = new THREE.LatheGeometry(prof.map(p => new THREE.Vector2(p[0], p[1])), 20);
  lathe.rotateX(Math.PI / 2); lathe.scale(0.88, 1, 1); lathe.translate(0, 0, -4.1);
  g.add(new THREE.Mesh(lathe, body));
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 4.2), trim); stripe.position.set(0, -0.05, 0.3); stripe.scale.set(1, 1, 1); g.add(stripe);
  stripe.geometry = new THREE.CylinderGeometry(0.585, 0.43, 4.2, 20, 1, true); stripe.rotation.x = Math.PI / 2; stripe.scale.set(0.89, 1, 0.36); stripe.position.set(0, -0.04, 1.6);
  const ws = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.9), glass); ws.position.set(0, 0.52, -1.7); ws.rotation.x = -0.55; g.add(ws);
  for (const sx of [-1, 1]) { const w = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 1.5), glass); w.position.set(sx * 0.6, 0.3, -0.85); g.add(w); }
  for (const sx of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(5.3, 0.13, 1.55), body);
    wing.position.set(sx * 2.85, 0.78, -0.75); wing.rotation.z = sx * 0.03; g.add(wing);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.14, 1.55), trim); tip.position.set(sx * 5.5, 0.86, -0.75); g.add(tip);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.3, 6), body);
    strut.position.set(sx * 1.55, 0.18, -0.7); strut.rotation.z = sx * 1.12; g.add(strut);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.1, 0.12), body); leg.position.set(sx * 0.85, -0.85, -0.3); leg.rotation.z = -sx * 0.5; g.add(leg);
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.13, 14), dark); wh.rotation.z = Math.PI / 2; wh.position.set(sx * 1.15, -1.3, -0.3); g.add(wh);
  }
  const nleg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), body); nleg.position.set(0, -0.85, -3.2); g.add(nleg);
  const nwh = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.11, 14), dark); nwh.rotation.z = Math.PI / 2; nwh.position.set(0, -1.3, -3.2); g.add(nwh);
  const hs = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.07, 1.0), body); hs.position.set(0, 0.15, 3.45); g.add(hs);
  const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(1.5, 0); fin.lineTo(1.25, 1.55); fin.lineTo(0.75, 1.55); fin.closePath();
  const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.08, bevelEnabled: false }); fg.rotateY(-Math.PI / 2); fg.translate(0.04, 0.18, 2.75);
  g.add(new THREE.Mesh(fg, trim));
  const spin = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 14), red); spin.rotation.x = -Math.PI / 2; spin.position.set(0, 0.02, -4.3); g.add(spin);
  const prop = new THREE.Group(); prop.position.set(0, 0.02, -4.22);
  for (const r of [0, Math.PI / 2]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.11, 1.95, 0.04), dark); b.rotation.z = r; prop.add(b); }
  g.add(prop); g.userData.prop = prop; g.userData.spinAxis = 'z';
  g.scale.setScalar(1 / 11.2);
  const w = new THREE.Group(); w.add(g); w.userData = g.userData; return w;
}
function quadModel() {
  const g = new THREE.Group();
  const body = mat(0x30363f), front = mat(0xc0352b), back = mat(0x1f5bc4), motor = mat(0x1d2128), disc = mat(0x9aa7b8, { transparent: true, opacity: 0.35, depthWrite: false });
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.3), body); g.add(b);
  const props = new THREE.Group(); g.add(props);
  [[1, -1], [-1, -1], [1, 1], [-1, 1]].forEach(([sx, sz]) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.5), sz < 0 ? front : back);
    arm.position.set(sx * 0.16, 0, sz * 0.16); arm.rotation.y = sx * sz > 0 ? -Math.PI / 4 : Math.PI / 4; g.add(arm);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.06, 12), motor); m.position.set(sx * 0.32, 0.04, sz * 0.32); g.add(m);
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.006, 24), disc); d.position.set(sx * 0.32, 0.08, sz * 0.32); props.add(d);
  });
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 10), front); nose.rotation.x = -Math.PI / 2; nose.position.set(0, 0, -0.2); g.add(nose);
  g.scale.setScalar(1 / 0.85);
  const w = new THREE.Group(); w.add(g); return w;
}
async function modelFromFile(name, data) {
  const lower = name.toLowerCase();
  let obj;
  if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
    const src = lower.endsWith('.glb') ? data : new TextDecoder().decode(data);
    obj = await new Promise((res, rej) => new THREE.GLTFLoader().parse(src, '', gl => res(gl.scene), e => rej(new Error(e && e.message ? e.message : 'This glTF file could not be read. Use a .glb file, or a .gltf with everything embedded.'))));
  } else if (lower.endsWith('.obj')) obj = new THREE.OBJLoader().parse(new TextDecoder().decode(data));
  else if (lower.endsWith('.stl')) {
    const geo = new THREE.STLLoader().parse(data); geo.computeVertexNormals();
    obj = new THREE.Mesh(geo, mat(0xd8dde4));
  } else throw new Error('Use a .glb, .gltf, .obj or .stl file');
  obj.traverse(o => { if (o.isMesh && o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) m.side = THREE.DoubleSide; } });
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const k = 1 / (Math.max(size.x, size.y, size.z) || 1);
  obj.position.sub(c);
  const inner = new THREE.Group(); inner.add(obj); inner.scale.setScalar(k);
  const w = new THREE.Group(); w.add(inner); return w;
}
const IDB = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('dfplot', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async put(k, v) { try { const db = await this.open(); await new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (_) { /* storage unavailable */ } },
  async get(k) { try { const db = await this.open(); return await new Promise((res) => { const r = db.transaction('files').objectStore('files').get(k); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); } catch (_) { return null; } }
};

/* ---------- image tiles: fetched, never cached when they fail, retried with backoff ---------- */
const IMG = new Map(), IMG_BAD = new Map();
function blobImage(blob) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { URL.revokeObjectURL(u); res(im); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('The tile is not an image')); };
    im.src = u;
  });
}
function httpErr(status, what) { return Object.assign(new Error(`${what}: HTTP ${status}`), { status, transient: status === 408 || status === 429 || status >= 500 }); }
/** Resolves to an image, or null when it failed. A failed URL is fetched again on the next call. */
function loadImage(url) {
  let p = IMG.get(url);
  if (p) { IMG.delete(url); IMG.set(url, p); return p; }
  const retry = IMG_BAD.has(url);
  p = (async () => {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(url, { mode: 'cors', cache: retry ? 'reload' : 'default', signal: ac.signal });
      if (!res.ok) throw httpErr(res.status, 'Map tile');
      const im = await blobImage(await res.blob());
      IMG_BAD.delete(url);
      return im;
    } catch (e) {
      const b = IMG_BAD.get(url) || { n: 0 };
      b.n++; b.status = e.status || 0; b.msg = netMsg(e, 'Map tiles'); IMG_BAD.set(url, b);
      if (IMG_BAD.size > 5000) IMG_BAD.delete(IMG_BAD.keys().next().value);
      IMG.delete(url);
      return null;
    } finally { clearTimeout(to); }
  })();
  IMG.set(url, p);
  if (IMG.size > 400) IMG.delete(IMG.keys().next().value);
  return p;
}
/** Wait before trying a failed tile again: 2, 4, 8, 16, then 30 s; a 404 waits a minute. */
function backoff(n, status) { return status === 404 ? 60000 : Math.min(15000, 2000 * Math.pow(2, Math.max(0, n - 1))); }
/** Browsers word a refused connection differently; say it one way. */
function netMsg(e, what) {
  if (e && e.name === 'AbortError') return `${what}: the server took too long to answer`;
  if (e && e.status) return e.message;
  return `${what}: the server did not answer`;
}
function quadkey(z, x, y) { let q = ''; for (let i = z; i > 0; i--) { let d = 0; const m = 1 << (i - 1); if (x & m) d++; if (y & m) d += 2; q += d; } return q; }
function xyzUrl(tpl, z, x, y) {
  const subs = /\{s\}/.test(tpl) ? (/cartocdn/.test(tpl) ? 'abcd' : 'abc') : 'a';
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{-y}', (1 << z) - 1 - y).replace('{s}', subs[(x + y) % subs.length]).replace('{q}', quadkey(z, x, y)).replace('{r}', '');
}

/* ---------- quantized-mesh terrain ---------- */
async function gunzipIfNeeded(buf) {
  const b = new Uint8Array(buf);
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b && typeof DecompressionStream === 'function')
    return await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return buf;
}
function decodeQM(buf) {
  const dv = new DataView(buf);
  const minH = dv.getFloat32(24, true), maxH = dv.getFloat32(28, true);
  let p = 88;
  const nV = dv.getUint32(p, true); p += 4;
  const rd = () => { const a = new Uint16Array(nV); let v = 0; for (let i = 0; i < nV; i++) { const d = dv.getUint16(p + i * 2, true); v += (d >> 1) ^ (-(d & 1)); a[i] = v; } p += nV * 2; return a; };
  const u = rd(), v = rd(), hh = rd();
  const w32 = nV > 65536, isz = w32 ? 4 : 2;
  if (p % isz) p += isz - (p % isz);
  const nT = dv.getUint32(p, true); p += 4;
  const nI = nT * 3, idx = w32 ? new Uint32Array(nI) : new Uint16Array(nI);
  let hi = 0;
  for (let i = 0; i < nI; i++) { const c = w32 ? dv.getUint32(p + i * 4, true) : dv.getUint16(p + i * 2, true); idx[i] = hi - c; if (c === 0) hi++; }
  p += nI * isz;
  const edges = [];
  for (let k = 0; k < 4; k++) {
    const c = dv.getUint32(p, true); p += 4;
    const a = new Uint32Array(c);
    for (let i = 0; i < c; i++) a[i] = w32 ? dv.getUint32(p + i * 4, true) : dv.getUint16(p + i * 2, true);
    p += c * isz; edges.push(a);
  }
  let normals = null;
  while (p + 5 <= buf.byteLength) {
    const id = dv.getUint8(p), len = dv.getUint32(p + 1, true); p += 5;
    if (id === 1 && len >= nV * 2) normals = new Uint8Array(buf.slice(p, p + nV * 2));
    p += len;
  }
  return { minH, maxH, nV, u, v, h: hh, idx, edges, normals };
}
function octDecode(x, y, out) {
  let fx = x / 255 * 2 - 1, fy = y / 255 * 2 - 1;
  const fz = 1 - Math.abs(fx) - Math.abs(fy);
  if (fz < 0) { const ox = fx; fx = (1 - Math.abs(fy)) * (ox >= 0 ? 1 : -1); fy = (1 - Math.abs(ox)) * (fy >= 0 ? 1 : -1); }
  const m = Math.hypot(fx, fy, fz) || 1;
  out[0] = fx / m; out[1] = fy / m; out[2] = fz / m;
  return out;
}
async function loadLayer(url) {
  let u = url.trim();
  if (!/\.json(\?|$)/i.test(u)) u = u.replace(/\/?(\?|$)/, '/layer.json$1');
  const base = new URL(u, location.href);
  let res;
  try { res = await fetch(base.href, { mode: 'cors', cache: 'no-cache' }); } catch (e) { throw Object.assign(new Error('Could not reach the terrain server. Check the link, and that the server allows cross-origin requests (CORS).'), { transient: true }); }
  if (!res.ok) throw Object.assign(new Error(`The terrain server answered ${res.status} for layer.json.`), { transient: res.status === 408 || res.status === 429 || res.status >= 500 });
  let j;
  try { j = JSON.parse(new TextDecoder().decode(await gunzipIfNeeded(await res.arrayBuffer()))); } catch (e) { throw new Error('layer.json is not valid JSON.'); }
  if (j.format && !/quantized-mesh/.test(j.format)) throw new Error(`This terrain is ${j.format}. Only quantized-mesh terrain is supported.`);
  if (j.projection && j.projection !== 'EPSG:4326') throw new Error(`This terrain uses ${j.projection}. Only EPSG:4326 terrain is supported.`);
  const avail = Array.isArray(j.available) ? j.available : null;
  return {
    base, tpl: (j.tiles && j.tiles[0]) || '{z}/{x}/{y}.terrain?v={version}', version: j.version || '', scheme: j.scheme || j.schema || 'tms',
    maxzoom: Number.isFinite(j.maxzoom) ? j.maxzoom : avail ? avail.length - 1 : 14, avail, attribution: j.attribution || '',
    ext: Array.isArray(j.extensions) ? j.extensions : []
  };
}
function terrainTileUrl(L, z, x, y) {
  const yy = L.scheme === 'tms' ? y : (1 << z) - 1 - y;
  const s = L.tpl.replace('{z}', z).replace('{x}', x).replace('{y}', yy).replace('{version}', encodeURIComponent(L.version));
  const u = new URL(s, L.base);
  for (const [k, v] of L.base.searchParams) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.href;
}
function terrainAvailable(L, z, x, y) {
  if (z > L.maxzoom) return false;
  if (!L.avail) return true;
  const lev = L.avail[z]; if (!lev) return false;
  return lev.some(r => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY);
}

/* ---------- raw terrain cache, so rebuilding tiles (a new height setting) does not refetch them ---------- */
const TQM = new Map();
function tqmGet(url) { const v = TQM.get(url); if (v) { TQM.delete(url); TQM.set(url, v); } return v; }
function tqmPut(url, v) { TQM.set(url, v); if (TQM.size > 600) TQM.delete(TQM.keys().next().value); }

/* ---------- tile manager: quadtree around the camera, parents shown until children are ready.
   States: new → queued → loading → ready | none (no tile there) | failed (retried after a wait).
   A ready tile with missing imagery is "partial" and is rebuilt when its wait is over. ---------- */
class TileSet {
  constructor(E) { this.E = E; this.group = new THREE.Group(); this.cache = new Map(); this.queue = []; this.roots = []; this.active = 0; this.gen = 0; this.loaded = 0; this.lastErr = ''; this.wake = 0; }
  reset(cfg, layer) {
    this.gen++;
    for (const t of this.cache.values()) this.disposeTile(t);
    this.cache.clear(); this.queue = []; this.loaded = 0; this.good = 0; this.active = 0; this.lastErr = '';
    const imgDef = IMAGERY[cfg.imagery] || IMAGERY.none;
    this.imgTpl = cfg.imagery === 'custom' ? (cfg.imageryUrl || '') : imgDef.url;
    this.imgMax = cfg.imagery === 'custom' ? clamp(Number(cfg.imageryMax) || 19, 1, 23) : imgDef.max;
    this.layer = layer || null;
    this.terrain = !!layer;
    this.cfg = cfg;
    this.maxZ = this.terrain ? layer.maxzoom : (this.imgTpl ? this.imgMax : 0);
    this.roots = [];
    const E = this.E;
    if (!E.roi || (!this.terrain && !this.imgTpl)) return;
    this.box = E.roiBox();
    const { lat } = E.roi;
    if (this.terrain) {
      const z0 = clamp(Math.floor(Math.log2(180 / (this.box.n - this.box.s))), 0, this.maxZ);
      const sz = 180 / (1 << z0);
      for (let x = Math.floor((this.box.w + 180) / sz); x <= Math.floor((this.box.e + 180) / sz); x++)
        for (let y = Math.floor((this.box.s + 90) / sz); y <= Math.floor((this.box.n + 90) / sz); y++) this.roots.push(this.tile(z0, x, y));
    } else {
      const z0 = clamp(Math.floor(Math.log2(40075016 * Math.cos(lat * GEO.D2R) / (E.roi.r * 2))), 0, this.maxZ);
      const x0 = Math.floor(GEO.merc.x(this.box.w, z0)), x1 = Math.floor(GEO.merc.x(this.box.e, z0));
      const y0 = Math.floor(GEO.merc.y(this.box.n, z0)), y1 = Math.floor(GEO.merc.y(this.box.s, z0));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.roots.push(this.tile(z0, x, y));
    }
    for (const r of this.roots) r.root = true;
  }
  bounds(z, x, y) {
    if (this.terrain) { const s = 180 / (1 << z); return { w: -180 + x * s, e: -180 + (x + 1) * s, s: -90 + y * s, n: -90 + (y + 1) * s }; }
    return { w: GEO.merc.lon(x, z), e: GEO.merc.lon(x + 1, z), n: GEO.merc.lat(y, z), s: GEO.merc.lat(y + 1, z) };
  }
  tile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let t = this.cache.get(key);
    if (t) return t;
    const b = this.bounds(z, x, y), clat = (b.s + b.n) / 2, clon = (b.w + b.e) / 2, m = GEO.mPerDeg(clat);
    const size = Math.max((b.n - b.s) * m.lat, (b.e - b.w) * m.lon);
    const c = this.E.fr.toScene(clat, clon, this.E.surfH(clat, clon), [0, 0, 0]);
    t = { key, z, x, y, b, size, c: new THREE.Vector3(c[0], c[1], c[2]), state: 'new', mesh: null, used: 0, want: 0, noKids: false, partial: false, tries: 0, retryAt: 0, refreshing: false, root: false, err: '' };
    this.cache.set(key, t);
    return t;
  }
  kids(t) {
    const out = [];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const k = this.tile(t.z + 1, t.x * 2 + dx, t.y * 2 + dy);
      if (k.b.e >= this.box.w && k.b.w <= this.box.e && k.b.n >= this.box.s && k.b.s <= this.box.n) out.push(k);
    }
    return out;
  }
  update(cam, pxK) {
    if (!this.roots.length) return;
    const out = [];
    this.pxK = pxK; this.cam = cam; this.now = performance.now();
    for (const r of this.roots) this.visit(r, out);
    const now = this.now;
    for (const t of this.cache.values()) if (t.mesh) t.mesh.visible = false;
    for (const t of out) { t.mesh.visible = true; t.used = now; }
    this.pump();
    // wake up for the next retry even if nothing else is moving
    let next = Infinity;
    for (const t of this.cache.values()) if (this.missing(t, now) && !t.refreshing) next = Math.min(next, t.retryAt);
    if (next < Infinity) {
      const due = Math.max(150, next - now + 20);
      if (!this.wake || this.wakeAt > now + due + 50) { clearTimeout(this.wake); this.wakeAt = now + due; this.wake = setTimeout(() => { this.wake = 0; this.E.req(); }, due); }
    }
    if (this.cache.size > 700) {
      const old = [...this.cache.values()].filter(t => t.state !== 'loading' && !t.refreshing && now - t.used > 8000 && now - t.want > 8000 && !t.root).sort((a, b) => a.used - b.used);
      for (const t of old.slice(0, this.cache.size - 500)) { this.disposeTile(t); this.cache.delete(t.key); }
    }
  }
  sse(t) {
    const d = Math.max(1, this.cam.distanceTo(t.c) - t.size * 0.75);
    return t.size / d * this.pxK / (this.terrain ? 420 : 300);
  }
  ask(t) {
    t.want = this.now;
    if (t.state === 'new' || (t.state === 'failed' && this.now >= t.retryAt)) this.request(t);
  }
  visit(t, out) {
    this.ask(t);
    if (t.state === 'ready' && t.z < this.maxZ && !t.noKids && this.sse(t) > 1) {
      const kids = this.kids(t);
      for (const k of kids) this.ask(k);
      if (kids.some(k => k.state === 'none')) t.noKids = true;
      else if (kids.length && kids.every(k => k.state === 'ready')) { for (const k of kids) this.visit(k, out); return; }
    }
    if (t.state === 'ready') {
      out.push(t); t.used = this.now;
      if (t.partial && !t.refreshing && this.now >= t.retryAt) { t.refreshing = true; this.queue.push(t); }
    }
  }
  request(t) { t.state = 'queued'; this.queue.push(t); }
  pump() {
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a.z - b.z || a.c.distanceToSquared(this.cam) - b.c.distanceToSquared(this.cam));
    while (this.active < 6 && this.queue.length) {
      const t = this.queue.shift();
      const refresh = t.state === 'ready' && t.refreshing;
      if (!refresh && t.state !== 'queued') continue;
      if (!refresh) t.state = 'loading';
      this.active++;
      const gen = this.gen;
      (this.terrain ? this.loadTerrain(t) : this.loadImagery(t)).then(r => {
        if (gen !== this.gen) { if (r && r.mesh) this.disposeMesh(r.mesh); return; }
        if (!r) { if (!refresh) t.state = 'none'; return; }
        if (t.mesh) { this.group.remove(t.mesh); this.disposeMesh(t.mesh); }
        t.mesh = r.mesh; r.mesh.visible = false; this.group.add(r.mesh);
        if (!refresh) this.loaded++;
        if (!r.partial) this.good++;
        t.state = 'ready'; t.partial = !!r.partial;
        if (r.partial) { t.tries++; t.retryAt = performance.now() + backoff(t.tries, r.status); t.err = r.err || ''; }
        else { t.tries = 0; t.err = ''; }
      }, e => {
        if (gen !== this.gen) return;
        t.tries++; t.retryAt = performance.now() + backoff(t.tries, e.status);
        t.err = this.terrain && !e.status && !/^Map/.test(e.message || '') ? netMsg(e, 'Terrain tiles') : (e.message || 'failed');
        this.lastErr = t.err;
        if (!refresh) t.state = 'failed';
      }).finally(() => { if (gen === this.gen) { this.active--; t.refreshing = false; this.E.req(); } });
    }
  }
  /** Try every failed tile again now. */
  retryAll() {
    for (const t of this.cache.values()) { if (t.state === 'failed' || t.partial) { t.retryAt = 0; t.tries = 0; } }
    clearTimeout(this.wake); this.wake = 0;
    this.E.req();
  }
  /** A tile the view needs right now that failed: a wanted tile with no data, or a shown tile missing imagery. */
  missing(t, now) { return (t.state === 'failed' && now - t.want < 3000) || (t.partial && t.mesh && now - t.used < 1000); }
  /** Tiles that are wanted on screen but failed, and when the next try is. */
  failures() {
    const now = performance.now();
    let n = 0, next = Infinity, err = '';
    for (const t of this.cache.values()) {
      if (this.missing(t, now)) { n++; next = Math.min(next, t.retryAt); err = err || t.err; }
    }
    return { n, next: next === Infinity ? 0 : Math.max(0, next - now), err };
  }
  async loadImagery(t) {
    const url = xyzUrl(this.imgTpl, t.z, t.x, t.y);
    const img = await loadImage(url);
    if (!img && !t.root) { const b = IMG_BAD.get(url) || {}; throw Object.assign(new Error(b.msg || 'Map tile failed'), { status: b.status }); }
    const segs = t.z < 5 ? 24 : t.z < 9 ? 12 : 4, n = segs + 1;
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) {
      const lat = GEO.merc.lat(t.y + j / segs, t.z);
      for (let i = 0; i < n; i++) {
        const lon = GEO.merc.lon(t.x + i / segs, t.z), k = j * n + i;
        this.E.fr.toScene(lat, lon, this.E.surfH(lat, lon), pos, k * 3);
        uv[k * 2] = i / segs; uv[k * 2 + 1] = 1 - j / segs;
      }
    }
    const idx = new Uint16Array(segs * segs * 6);
    let q = 0;
    for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) { const a = j * n + i, b = a + 1, c = a + n, d = c + 1; idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    let m;
    if (img) { const tex = new THREE.Texture(img); tex.anisotropy = this.E.aniso; tex.needsUpdate = true; m = new THREE.MeshBasicMaterial({ map: tex }); }
    else m = new THREE.MeshBasicMaterial({ color: this.E.groundColor });
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = t.z;
    if (img) return { mesh };
    const b = IMG_BAD.get(url) || {};
    return { mesh, partial: true, status: b.status, err: b.msg };
  }
  async loadTerrain(t) {
    const L = this.layer;
    if (!terrainAvailable(L, t.z, t.x, t.y)) return null;
    const url = terrainTileUrl(L, t.z, t.x, t.y);
    let raw = tqmGet(url);
    if (raw === undefined) {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 30000);
      let res;
      try { res = await fetch(url, { headers: { Accept: QM_ACCEPT }, mode: 'cors', cache: t.tries ? 'reload' : 'default', signal: ac.signal }); }
      finally { clearTimeout(to); }
      if (res.status === 404 || res.status === 204) { tqmPut(url, null); return null; }
      if (!res.ok) throw httpErr(res.status, 'Terrain tile');
      raw = await gunzipIfNeeded(await res.arrayBuffer());
      tqmPut(url, raw);
    }
    if (raw === null) return null;
    const qm = decodeQM(raw);
    const E = this.E, fr = E.fr, b = t.b, msl = this.cfg.terrainMsl && this.cfg.surface !== 'sphere';
    const vz = h => E.vz(h), stretched = E.exag() !== 1;
    // imagery composite in web mercator, sampled per vertex
    let tex = null, zm = 0, X0 = 0, Y0 = 0, nx = 1, ny = 1, missing = 0, status = 0, err = '';
    if (this.imgTpl) {
      zm = clamp(t.z + (t.z >= this.maxZ ? 3 : 2), 0, this.imgMax);
      for (;;) {
        X0 = Math.floor(GEO.merc.x(b.w, zm)); Y0 = Math.floor(GEO.merc.y(b.n, zm));
        nx = Math.floor(GEO.merc.x(b.e, zm) - 1e-9) - X0 + 1; ny = Math.floor(GEO.merc.y(b.s, zm) - 1e-9) - Y0 + 1;
        if (nx * ny <= 24 || zm === 0) break;
        zm--;
      }
      const urls = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) urls.push(xyzUrl(this.imgTpl, zm, X0 + i, Y0 + j));
      const got = await Promise.all(urls.map(loadImage));
      const cv = document.createElement('canvas'); cv.width = nx * 256; cv.height = ny * 256;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#' + E.groundColor.getHexString(); cx.fillRect(0, 0, cv.width, cv.height);
      got.forEach((im, k) => {
        if (im) cx.drawImage(im, (k % nx) * 256, Math.floor(k / nx) * 256, 256, 256);
        else { missing++; const bad = IMG_BAD.get(urls[k]) || {}; status = status || bad.status; err = err || bad.msg; }
      });
      tex = new THREE.CanvasTexture(cv); tex.anisotropy = E.aniso;
    }
    const nV = qm.nV, edgeCount = qm.edges.reduce((sum, e) => sum + e.length, 0), total = nV + edgeCount;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
    const lats = new Float64Array(nV), lons = new Float64Array(nV), hs = new Float64Array(nV), nn = [0, 0, 0];
    const dh = qm.maxH - qm.minH;
    for (let i = 0; i < nV; i++) {
      const lon = b.w + qm.u[i] / 32767 * (b.e - b.w), lat = b.s + qm.v[i] / 32767 * (b.n - b.s);
      let hgt = qm.minH + qm.h[i] / 32767 * dh;
      if (msl) hgt += GEO.geoidN(lat, lon);
      hgt = vz(hgt);
      lats[i] = lat; lons[i] = lon; hs[i] = hgt;
      fr.toScene(lat, lon, hgt, pos, i * 3);
      if (qm.normals && !stretched) { octDecode(qm.normals[i * 2], qm.normals[i * 2 + 1], nn); fr.dir(nn[0], nn[1], nn[2], nor, i * 3); }
      if (tex) { uv[i * 2] = (GEO.merc.x(lon, zm) - X0) / nx; uv[i * 2 + 1] = 1 - (GEO.merc.y(lat, zm) - Y0) / ny; }
    }
    const skirt = Math.max(5, t.size * 0.015 + dh * 0.05 * E.exag());
    const tris = Array.from(qm.idx);
    let k = nV;
    qm.edges.forEach((e, side) => {
      const arr = Array.from(e).sort((a, c) => side === 0 || side === 2 ? qm.v[a] - qm.v[c] : qm.u[a] - qm.u[c]);
      const first = k;
      for (const vi of arr) {
        fr.toScene(lats[vi], lons[vi], hs[vi] - skirt, pos, k * 3);
        uv[k * 2] = uv[vi * 2]; uv[k * 2 + 1] = uv[vi * 2 + 1];
        k++;
      }
      for (let q = 0; q + 1 < arr.length; q++) { const a = arr[q], c = arr[q + 1], a2 = first + q, c2 = first + q + 1; tris.push(a, c, c2, a, c2, a2); }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (tex) geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(total > 65535 ? new THREE.BufferAttribute(Uint32Array.from(tris), 1) : new THREE.BufferAttribute(Uint16Array.from(tris), 1));
    if (qm.normals && !stretched) {
      // skirts take the normal of the edge vertex they hang from
      k = nV;
      qm.edges.forEach((e, side) => {
        const arr = Array.from(e).sort((a, c) => side === 0 || side === 2 ? qm.v[a] - qm.v[c] : qm.u[a] - qm.u[c]);
        for (const vi of arr) { nor[k * 3] = nor[vi * 3]; nor[k * 3 + 1] = nor[vi * 3 + 1]; nor[k * 3 + 2] = nor[vi * 3 + 2]; k++; }
      });
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    } else geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const clat = (b.s + b.n) / 2, clon = (b.w + b.e) / 2;
    const cc = fr.toScene(clat, clon, vz((qm.minH + qm.maxH) / 2 + (msl ? GEO.geoidN(clat, clon) : 0)), [0, 0, 0]);
    t.c.set(cc[0], cc[1], cc[2]);
    const m = new THREE.MeshLambertMaterial(tex ? { map: tex, side: THREE.DoubleSide } : { color: E.groundColor, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = t.z;
    mesh.userData.terrain = true;
    return missing ? { mesh, partial: true, status, err } : { mesh };
  }
  disposeMesh(mesh) { mesh.geometry.dispose(); if (mesh.material.map) mesh.material.map.dispose(); mesh.material.dispose(); }
  disposeTile(t) { if (t.mesh) { this.group.remove(t.mesh); this.disposeMesh(t.mesh); t.mesh = null; } }
  pending() { let n = this.active; for (const t of this.queue) if (t.state === 'queued' || t.refreshing) n++; return n; }
}
