/* ================= state, formatting, layout model ================= */
const $ = id => document.getElementById(id);
function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; }
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const NC = 8;
const PT = 22, PB = 20;
const LS_LAYOUT = 'dfplot.layout.v1', LS_SAVED = 'dfplot.saved.v1', LS_SET = 'dfplot.settings.v1';
const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage unavailable */ } }
};
const ICON = {
  up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M4 9l4 4 4-4"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3 10.5V4a1.5 1.5 0 0 1 1.5-1.5H10"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  pin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.6 2.2l4.2 4.2M11.7 4.3L8.9 7.1 5.6 6.6 4.5 7.7l3.8 3.8 1.1-1.1-.5-3.3 2.8-2.8M6.4 9.6L2.4 13.6"/></svg>',
  list: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"/><circle cx="2.8" cy="4.5" r=".6"/><circle cx="2.8" cy="8" r=".6"/><circle cx="2.8" cy="11.5" r=".6"/></svg>',
  fx: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5c-1.6 0-2.2.9-2.5 2.6L5.6 13c-.3 1.4-.9 1.9-2.1 1.9M4.5 6.5h5M10 8.5l4 4M14 8.5l-4 4"/></svg>'
};

const st = {
  ix: null, file: null, demo: false,
  view: { t0: 0, t1: 1 }, viewAt: 0, sel: null, pin: null, cursor: null, band: null, hoverG: null, hoverXY: null,
  graphs: [], active: null, vars: new Map(), varOwner: new Map(),
  set: Object.assign({ drag: 'zoom', wheel: false, armed: true, modes: true, errs: true, detail: 'auto', tlPin: 1 }, store.get(LS_SET) || {}),
  hist: [], undo: [], redo: [], snap: '[]', colors: {}, fonts: {}, dpr: 1, scanning: false, cancel: false, wheelHinted: false
};
let uid = 1;
const nid = () => uid++;
const M = { L: 62, R: 14, axw: 54 };

/* ---------- formatting ---------- */
function fmtT(us, digits = 1) {
  if (us === null || us === undefined || !isFinite(us)) return '–';
  const neg = us < 0; let s = Math.abs(us) / 1e6;
  const hh = Math.floor(s / 3600); s -= hh * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  let ss = s.toFixed(digits);
  if (parseFloat(ss) >= 60) ss = (59.999999).toFixed(digits);
  if (s < 10) ss = '0' + ss;
  return (neg ? '-' : '') + (hh ? hh + ':' + String(m).padStart(2, '0') : String(m)) + ':' + ss;
}
function fmtDur(us) {
  const s0 = us / 1e6;
  if (s0 < 10) return s0.toFixed(s0 < 1 ? 3 : 2) + ' s';
  const s = Math.round(s0);
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return hh ? `${hh} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${String(r).padStart(2, '0')} s` : `${r} s`;
}
function fmtTFile(us) {
  const s = Math.floor(us / 1e6), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (hh ? hh + 'h' : '') + String(m).padStart(hh ? 2 : 1, '0') + 'm' + String(r).padStart(2, '0') + 's';
}
function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' kB';
  return b + ' B';
}
function trimZ(s) { return s.indexOf('e') < 0 && s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s; }
function fmtNum(v, sig = 7) {
  if (v === null || v === undefined || v !== v) return '–';
  if (!isFinite(v)) return v > 0 ? '∞' : '−∞';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e9 || a < 1e-5) return v.toExponential(3);
  if (a >= 1e6) return v.toFixed(0);
  return trimZ(v.toPrecision(a < 1 ? Math.min(sig, 5) : sig));
}
const fmtShort = v => fmtNum(v, 4);
function fmtHz(hz) { return hz >= 10 ? Math.round(hz) + ' Hz' : hz >= 1 ? hz.toFixed(1) + ' Hz' : hz > 0 ? (1 / hz).toFixed(hz < 0.1 ? 0 : 1) + ' s period' : ''; }
function fmtTick(v, step) {
  if (Math.abs(v) < step * 1e-6) v = 0;
  const a = Math.abs(v);
  if (a >= 1e6 || (a > 0 && a < 1e-4)) return v.toExponential(1);
  const e = Math.floor(Math.log10(step) + 1e-9);
  let dec = Math.max(0, -e);
  const mant = step / Math.pow(10, e);
  if (Math.abs(mant - 2.5) < 1e-6 || (mant % 1 > 0.01 && mant % 1 < 0.99)) dec++;
  return v.toFixed(Math.min(dec, 7));
}
function esc(s) { return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function baseName() { return (st.ix ? st.ix.name : 'log').replace(/\.(bin|log)$/i, ''); }
function slug(s) { return String(s).trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'graph'; }
function setStatus() { /* status goes to toasts */ }

/* ---------- colours from tokens ---------- */
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const keys = ['surface', 'surface-2', 'ink', 'ink-2', 'muted', 'faint', 'line', 'grid', 'accent', 'accent-ink', 'sel', 'selfill', 'zoomfill', 'armed', 'armed-line', 'crit'];
  for (let i = 1; i <= 8; i++) keys.push('c' + i, 'm' + i);
  for (const k of keys) st.colors[k] = cs.getPropertyValue('--' + k).trim();
  st.fonts.mono = cs.getPropertyValue('--font-mono').trim();
  st.fonts.ui = cs.getPropertyValue('--font-ui').trim();
  st.fonts.cond = cs.getPropertyValue('--font-cond').trim();
}
const fieldColor = f => st.colors['c' + ((f.color % NC) + 1)];

/* ---------- layout model ---------- */
function mkField(o) {
  return { id: nid(), expr: String(o.expr || ''), color: Number.isInteger(o.color) ? o.color : 0, visible: o.visible !== false, axis: o.axis > 0 ? o.axis : 1, _r: null, _row: null, _spec: null, _stat: null };
}
function mkGraph(o = {}) {
  return {
    id: nid(), title: o.title || 'Graph', type: o.type === 'spectrum' || o.type === '3d' ? o.type : 'time',
    height: clamp(Number(o.height) || (o.type === '3d' ? 420 : 230), 120, 1400),
    pin: Number(o.pin) > 0 ? Number(o.pin) : 0, compact: !!o.compact,
    v3: o.type === '3d' ? JSON.parse(JSON.stringify(Object.assign({}, V3DEF, o.v3 || {}))) : undefined,
    spec: Object.assign({ db: false, logf: false, f0: null, f1: null }, o.spec || {}),
    axes: Object.assign({}, o.axes || {}), fields: (o.fields || []).map(mkField),
    _dirty: true, _el: null, _plan: [], _w: 0, _h: 0
  };
}
function plainGraph(g) {
  const o = { title: g.title, type: g.type, height: g.height, spec: g.spec, axes: g.axes, fields: g.fields.map(f => ({ expr: f.expr, color: f.color, visible: f.visible, axis: f.axis })) };
  if (g.pin) o.pin = g.pin;
  if (g.compact) o.compact = true;
  if (g.type === '3d') o.v3 = g.v3;
  return o;
}
const serialize = () => JSON.stringify(st.graphs.map(plainGraph));
function changed() {
  const snap = serialize();
  if (snap === st.snap) return;
  st.undo.push(st.snap);
  if (st.undo.length > 120) st.undo.shift();
  st.redo = [];
  st.snap = snap;
  persist(); updateUndo();
}
function persist() { clearTimeout(persist.t); persist.t = setTimeout(() => store.set(LS_LAYOUT, { graphs: JSON.parse(st.snap) }), 250); }
function saveSettings() { store.set(LS_SET, st.set); }
function restoreSnap(snap) {
  const activeIdx = Math.max(0, st.graphs.findIndex(g => g.id === st.active));
  st.snap = snap;
  st.graphs = JSON.parse(snap).map(mkGraph);
  st.active = st.graphs.length ? st.graphs[Math.min(activeIdx, st.graphs.length - 1)].id : null;
  evalAll(); renderGraphs(); persist(); updateUndo();
}
function undo() { if (!st.undo.length) return; st.redo.push(st.snap); restoreSnap(st.undo.pop()); }
function redo() { if (!st.redo.length) return; st.undo.push(st.snap); restoreSnap(st.redo.pop()); }
function updateUndo() { $('undoBtn').disabled = !st.undo.length; $('redoBtn').disabled = !st.redo.length; }

/* ---------- evaluation ---------- */
function evalAll() {
  const vars = new Map(), owner = new Map();
  for (const g of st.graphs) for (const f of g.fields) {
    const sp = EX.splitName(f.expr);
    if (sp.name && !vars.has(sp.name)) { vars.set(sp.name, f.expr); owner.set(sp.name, f.id); }
  }
  st.vars = vars; st.varOwner = owner;
  for (const g of st.graphs) { for (const f of g.fields) { f._r = evalField(f); f._stat = null; } g._dirty = true; }
}
function evalField(f) {
  if (!st.ix) return { error: { message: 'Open a log to see this field', pos: 0, end: 0 } };
  const sp = EX.splitName(f.expr);
  if (!f.expr.trim()) return { error: { message: 'Empty formula. Click to type one.', pos: 0, end: 0 } };
  if (sp.name && st.varOwner.get(sp.name) !== f.id) return { error: { message: `Another field is already named ${sp.name}. Pick another name.`, pos: 0, end: sp.name.length }, name: sp.name };
  return EX.run(f.expr, st.vars);
}
function fieldLabel(f) {
  const sp = EX.splitName(f.expr);
  return sp.name || sp.body.trim();
}
const ok = f => f._r && f._r.series;

/* ---------- axes ---------- */
function axisPlan(g) {
  const order = [], map = new Map();
  for (const f of g.fields) {
    if (!f.visible || !ok(f)) continue;
    if (g.type === 'spectrum' && f._r.series.konst) continue;
    if (!map.has(f.axis)) { map.set(f.axis, []); order.push(f.axis); }
    map.get(f.axis).push(f);
  }
  return order.map((ax, i) => ({ ax, side: i % 2 ? 'R' : 'L', slot: i >> 1, fields: map.get(ax), lo: 0, hi: 1, step: 0.25 }));
}
function normalizeAxes(g) {
  const map = new Map(); let k = 1;
  for (const f of g.fields) if (!map.has(f.axis)) map.set(f.axis, k++);
  const axes = {};
  for (const f of g.fields) f.axis = map.get(f.axis);
  for (const [o, n] of map) if (g.axes[o]) axes[n] = g.axes[o];
  g.axes = axes;
}
const RANGE = new WeakMap();
function fullRange(s) {
  let r = RANGE.get(s.v);
  if (r) return r;
  let lo = Infinity, hi = -Infinity;
  const v = s.v;
  for (let i = 0; i < v.length; i++) { const x = v[i]; if (x === x && x !== Infinity && x !== -Infinity) { if (x < lo) lo = x; if (x > hi) hi = x; } }
  r = [lo, hi]; RANGE.set(s.v, r);
  return r;
}
/** Put a new field on an axis that already shows the same unit over a similar range, or on a new axis. */
function smartAxis(g, f) {
  const others = g.fields.filter(o => o !== f && ok(o));
  const maxAx = g.fields.reduce((m, o) => o !== f ? Math.max(m, o.axis) : m, 0);
  if (!others.length) return Math.max(1, maxAx || 1);
  if (!ok(f)) return maxAx + 1;
  const u = f._r.unit || '';
  const [a0, a1] = fullRange(f._r.series);
  if (!(a1 >= a0)) return maxAx + 1;
  const byAx = new Map();
  for (const o of others) { if (!byAx.has(o.axis)) byAx.set(o.axis, []); byAx.get(o.axis).push(o); }
  let best = null, bestScore = -Infinity;
  for (const [ax, list] of byAx) {
    const units = new Set(list.map(o => o._r.unit || ''));
    const same = u ? units.has(u) : [...units].every(x => !x);
    if (!same) continue;
    if (g.type === 'spectrum') { if (best === null) best = ax; continue; }
    let b0 = Infinity, b1 = -Infinity;
    for (const o of list) { const [x0, x1] = fullRange(o._r.series); if (x0 < b0) b0 = x0; if (x1 > b1) b1 = x1; }
    if (!(b1 >= b0)) continue;
    const sa = a1 - a0, sb = b1 - b0, tiny = 1e-9 * Math.max(1, Math.abs(a1), Math.abs(b1));
    let good = false, score = 0;
    if (sa <= tiny || sb <= tiny) {
      const lo = Math.min(a0, b0), hi = Math.max(a1, b1), span = Math.max(sa, sb, Math.abs(hi) * 0.05, 1e-9);
      good = hi - lo <= span * 1.6; score = 0.5;
    } else {
      const ov = Math.min(a1, b1) - Math.max(a0, b0), small = Math.min(sa, sb), big = Math.max(sa, sb);
      const overlap = ov / small, ratio = big / small;
      good = u ? (overlap >= 0.3 && ratio <= 20) : (overlap >= 0.6 && ratio <= 4);
      score = overlap - ratio / 50;
    }
    if (good && score > bestScore) { best = ax; bestScore = score; }
  }
  return best !== null ? best : maxAx + 1;
}
function nextColor(g) {
  const used = new Set(g.fields.map(f => f.color));
  for (let i = 0; i < NC; i++) if (!used.has(i)) return i;
  return g.fields.length % NC;
}

/* ---------- graph operations ---------- */
function activeGraph() { return st.graphs.find(g => g.id === st.active) || st.graphs[0] || null; }
function setActive(g) {
  if (!g || st.active === g.id) return;
  st.active = g.id;
  for (const o of st.graphs) if (o._el) o._el.root.classList.toggle('active', o.id === st.active);
}
function insertGraph(g, index) {
  if (index === undefined || index < 0 || index > st.graphs.length) index = st.graphs.length;
  st.graphs.splice(index, 0, g);
  st.active = g.id;
  return g;
}
/** Add a field without committing an undo step. */
function pushField(g, expr, extra) {
  const f = mkField(Object.assign({ expr, color: nextColor(g) }, extra || {}));
  g.fields.push(f);
  evalAll();
  f.axis = smartAxis(g, f);
  normalizeAxes(g);
  return f;
}
function addFieldTo(g, expr, opts = {}) {
  let created = false;
  if (!g) { g = insertGraph(mkGraph({ title: opts.title || titleFor(expr) })); created = true; }
  const f = pushField(g, expr);
  if (created) renderGraphs(); else { renderFields(g); }
  g._dirty = true; changed(); requestDraw(true);
  if (!opts.quiet) flashRow(g, f);
  return f;
}
function addToNewGraph(expr) {
  const idx = st.graphs.findIndex(g => g.id === st.active);
  const g = insertGraph(mkGraph({ title: titleFor(expr) }), idx < 0 ? undefined : idx + 1);
  pushField(g, expr);
  renderGraphs(); changed(); requestDraw(true);
  setTimeout(() => g._el && g._el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  return g;
}
function titleFor(expr) {
  const sp = EX.splitName(expr);
  const s = sp.name || sp.body.trim();
  return s.length > 28 ? s.slice(0, 27) + '…' : s;
}
function removeField(g, f) {
  g.fields = g.fields.filter(x => x !== f);
  normalizeAxes(g);
  evalAll(); renderFields(g); g._dirty = true; changed(); requestDraw(true);
}
function removeGraph(g) {
  const i = st.graphs.indexOf(g);
  st.graphs.splice(i, 1);
  if (st.active === g.id) st.active = st.graphs.length ? st.graphs[Math.min(i, st.graphs.length - 1)].id : null;
  evalAll(); renderGraphs(); changed();
  toast(`Removed “${g.title}”.`, { label: 'Undo', fn: undo });
}
/* ---------- pinning: pinned panels stack at the top of the screen, first pinned on top ---------- */
/** Pinned panels in stacking order. Each item is a graph, or 'tl' for the timeline. */
function pinnedItems() {
  const items = st.graphs.filter(g => g.pin).map(g => ({ g, pin: g.pin }));
  if (st.set.tlPin) items.push({ g: 'tl', pin: st.set.tlPin });
  return items.sort((a, b) => a.pin - b.pin);
}
function nextPin() { return pinnedItems().reduce((m, x) => Math.max(m, x.pin), 0) + 1; }
function setPin(item, v) { if (item === 'tl') { st.set.tlPin = v; saveSettings(); } else item.pin = v; }
function togglePin(g) {
  if (g.pin) { g.pin = 0; g.compact = false; }
  else {
    g.pin = nextPin();
    if (g.type !== '3d' && g.fields.length) g.compact = true;
    if (g.type === '3d') g._setOpen = false;
  }
  renderGraphs(); changed();
  if (!g.pin && g._el) setTimeout(() => g._el && g._el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
}
function toggleTimelinePin() {
  st.set.tlPin = st.set.tlPin ? 0 : nextPin();
  saveSettings(); renderGraphs();
}
/** Graphs in the order they appear on the page: pinned first, then the rest. */
function visualGraphs() { return pinnedItems().filter(x => x.g !== 'tl').map(x => x.g).concat(st.graphs.filter(g => !g.pin)); }
function moveGraph(g, d) {
  if (g.pin) {
    // reorder inside the pinned stack, the timeline included
    const items = pinnedItems(), i = items.findIndex(x => x.g === g), j = i + d;
    if (j < 0 || j >= items.length) return;
    const a = items[i], b = items[j];
    setPin(a.g, b.pin); setPin(b.g, a.pin);
    renderGraphs(); changed();
    return;
  }
  const i = st.graphs.indexOf(g);
  let j = i + d;
  while (j >= 0 && j < st.graphs.length && st.graphs[j].pin) j += d;
  if (j < 0 || j >= st.graphs.length) return;
  st.graphs[i] = st.graphs[j]; st.graphs[j] = g;
  renderGraphs(); changed();
  g._el.root.scrollIntoView({ block: 'nearest' });
}
function duplicateGraph(g) {
  const o = plainGraph(g);
  o.title = g.title + ' copy';
  o.fields = o.fields.map(f => { const sp = EX.splitName(f.expr); return Object.assign({}, f, { expr: sp.name ? sp.body.trim() : f.expr }); });
  insertGraph(mkGraph(o), st.graphs.indexOf(g) + 1);
  evalAll(); renderGraphs(); changed();
}
function setType(g, type) {
  if (g.type === type) return;
  g.type = type;
  g._el.specOpts.hidden = type !== 'spectrum';
  for (const b of g._el.seg.children) b.setAttribute('aria-pressed', String(b.dataset.type === type));
  renderFields(g); g._dirty = true; changed(); requestDraw(true);
}
function flashRow(g, f) {
  requestAnimationFrame(() => {
    if (!f._row) return;
    f._row.row.classList.add('hl');
    setTimeout(() => f._row && f._row.row.classList.remove('hl'), 900);
  });
}

/* ---------- templates ---------- */
const TEMPLATES = [
  { title: 'Altitude', fields: [['CTUN.DAlt'], ['CTUN.Alt', 'POS.RelHomeAlt', 'BARO.Alt'], ['RFND.Dist']] },
  { title: 'Climb rate', fields: [['CTUN.DCRt'], ['CTUN.CRt', 'BARO.CRt']] },
  { title: 'Roll', fields: [['ATT.DesRoll'], ['ATT.Roll']] },
  { title: 'Pitch', fields: [['ATT.DesPitch'], ['ATT.Pitch']] },
  { title: 'Yaw', fields: [['ATT.DesYaw'], ['ATT.Yaw']] },
  { title: 'Attitude error', fields: [['ATT.Roll - ATT.DesRoll'], ['ATT.Pitch - ATT.DesPitch'], ['wrap180(ATT.Yaw - ATT.DesYaw)']] },
  { title: 'Battery', fields: [['BAT.Volt'], ['BAT.Curr']] },
  { title: 'Power and energy', fields: [['BAT.Volt * BAT.Curr'], ['integral(BAT.Volt * BAT.Curr) / 3600']] },
  { title: 'Throttle', fields: [['CTUN.ThO'], ['CTUN.ThH']] },
  { title: 'Motor outputs', fields: [['RCOU.C1'], ['RCOU.C2'], ['RCOU.C3'], ['RCOU.C4'], ['RCOU.C5', null], ['RCOU.C6', null], ['RCOU.C7', null], ['RCOU.C8', null]] },
  { title: 'Vibration', fields: [['VIBE.VibeX'], ['VIBE.VibeY'], ['VIBE.VibeZ'], ['VIBE.Clip', null]] },
  { title: 'Accelerometers', fields: [['IMU.AccX'], ['IMU.AccY'], ['IMU.AccZ']] },
  { title: 'Gyros', fields: [['IMU.GyrX'], ['IMU.GyrY'], ['IMU.GyrZ']] },
  { title: 'Accelerometer spectrum', type: 'spectrum', fields: [['IMU.AccX'], ['IMU.AccY'], ['IMU.AccZ']] },
  { title: 'Gyro spectrum', type: 'spectrum', fields: [['IMU.GyrX'], ['IMU.GyrY'], ['IMU.GyrZ']] },
  { title: 'GPS quality', fields: [['GPS.NSats'], ['GPS.HDop']] },
  { title: 'Ground speed', fields: [['GPS.Spd'], ['smooth(GPS.Spd, 3)', null]] },
  { title: 'Distance from home', fields: [['homedist(GPS.Lat, GPS.Lng)', 'homedist(POS.Lat, POS.Lng)']] },
  { title: 'EKF innovations', fields: [['XKF4.SV'], ['XKF4.SP'], ['XKF4.SH'], ['XKF4.SM', null]] },
  { title: 'Flight mode', fields: [['mode'], ['armed']] },
  { title: 'Logging gaps', fields: [['dt(IMU.AccZ) * 1000', 'dt(ATT.Roll) * 1000']] }
];
function tplResolve(tpl) {
  const out = [];
  for (const alts of tpl.fields) {
    const pick = alts.find(a => a && EX.check(a, st.vars) === null);
    if (pick) out.push(pick);
  }
  return out;
}
function tplAvailable() { return st.ix ? TEMPLATES.filter(t => tplResolve(t).length) : []; }
function makeTemplateGraph(tpl) {
  const g = mkGraph({ title: tpl.title, type: tpl.type });
  st.graphs.push(g);
  for (const e of tplResolve(tpl)) pushField(g, e);
  st.graphs.pop();
  return g;
}
function addTemplate(tpl) {
  const idx = st.graphs.findIndex(g => g.id === st.active);
  const g = makeTemplateGraph(tpl);
  insertGraph(g, idx < 0 ? undefined : idx + 1);
  evalAll(); renderGraphs(); changed();
  setTimeout(() => g._el && g._el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
}
function suggestedGraphs() {
  const names = ['Altitude', 'Roll', 'Pitch', 'Battery', 'Vibration', 'GPS quality'];
  const saved = st.graphs; st.graphs = [];
  for (const n of names) {
    const t = TEMPLATES.find(x => x.title === n);
    if (t && tplResolve(t).length) st.graphs.push(makeTemplateGraph(t));
  }
  const out = st.graphs; st.graphs = saved;
  return out.map(plainGraph);
}
const DEMO_LAYOUT = [
  { title: 'Altitude', fields: [{ expr: 'CTUN.DAlt', color: 1 }, { expr: 'CTUN.Alt', color: 0 }, { expr: 'RFND.Dist', color: 2 }] },
  { title: 'Roll tracking and tuning', fields: [{ expr: 'ATT.DesRoll', color: 1 }, { expr: 'ATT.Roll', color: 0 }, { expr: 'PARM.ATC_RAT_RLL_P', color: 6, axis: 2 }] },
  { title: 'Battery', fields: [{ expr: 'BAT.Volt', color: 0 }, { expr: 'BAT.Curr', color: 1, axis: 2 }, { expr: 'Power = BAT.Volt * BAT.Curr', color: 4, visible: false, axis: 3 }, { expr: 'Energy = integral(Power) / 3600', color: 2, axis: 4 }] },
  { title: 'Vibration spectrum', type: 'spectrum', height: 220, fields: [{ expr: 'IMU[0].AccZ', color: 0 }, { expr: 'notch(IMU[0].AccZ, 48, 12)', color: 1 }] }
];
