/* ================= drawing ================= */
let raf = 0;
function requestDraw(all) { if (all) for (const g of st.graphs) g._dirty = true; if (!raf) raf = requestAnimationFrame(frame); }
function requestOverlay() { if (!raf) raf = requestAnimationFrame(frame); }
const lb = EX.lowerBound, ub = EX.upperBound;
const plotW = g => g._w - M.L - M.R;
const plotH = g => g._h - PT - PB;
const xOfT = (g, t) => M.L + (t - st.view.t0) / (st.view.t1 - st.view.t0) * plotW(g);
const tOfX = (g, x) => st.view.t0 + (x - M.L) / plotW(g) * (st.view.t1 - st.view.t0);

function frame() {
  raf = 0;
  st.dpr = window.devicePixelRatio || 1;
  computeMargins();
  for (const g of st.graphs) {
    if (!g._el || g.type === '3d') continue;
    sizeGraph(g);
    if (g._dirty) { g._dirty = false; try { if (g.type === 'spectrum') drawSpec(g); else drawTime(g); } catch (e) { console.error(e); } }
    drawOver(g);
  }
  drawOverview();
  updateReadouts();
  updateValues();
  if (V3.g) V3.req();
}
function computeMargins() {
  const axw = window.innerWidth < 560 ? 44 : 54;
  let nl = 1, nr = 0;
  for (const g of st.graphs) {
    g._plan = axisPlan(g);
    nl = Math.max(nl, Math.ceil(g._plan.length / 2));
    nr = Math.max(nr, Math.floor(g._plan.length / 2));
  }
  const L = 6 + nl * axw, R = nr ? 6 + nr * axw : 14;
  if (L !== M.L || R !== M.R || axw !== M.axw) { M.L = L; M.R = R; M.axw = axw; for (const g of st.graphs) g._dirty = true; }
}
function sizeGraph(g) {
  const w = Math.max(220, Math.floor(g._el.plot.clientWidth)), hh = g.height;
  if (w !== g._w || hh !== g._h || st.dpr !== g._dpr) {
    g._w = w; g._h = hh; g._dpr = st.dpr;
    for (const cv of [g._el.base, g._el.over]) { cv.width = Math.round(w * st.dpr); cv.height = Math.round(hh * st.dpr); cv.style.height = hh + 'px'; }
    g._el.plot.style.height = hh + 'px';
    g._dirty = true;
  }
}
function text(ctx, s, x, y, color, align = 'left', base = 'middle', font) {
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base; ctx.font = font || `11px ${st.fonts.ui}`; ctx.fillText(s, x, y);
}

/* ---------- min/max pyramid for fast drawing of long fields ---------- */
const LOD = new WeakMap();
function lod(v) {
  let L = LOD.get(v);
  if (L) return L;
  const n = v.length, nb = Math.ceil(n / 64), mn = new Float64Array(nb), mx = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let lo = Infinity, hi = -Infinity;
    const e = Math.min(n, (b + 1) * 64);
    for (let i = b * 64; i < e; i++) { const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
    mn[b] = lo; mx[b] = hi;
  }
  const nb2 = Math.ceil(nb / 64), mn2 = new Float64Array(nb2), mx2 = new Float64Array(nb2);
  for (let b = 0; b < nb2; b++) {
    let lo = Infinity, hi = -Infinity;
    const e = Math.min(nb, (b + 1) * 64);
    for (let i = b * 64; i < e; i++) { if (mn[i] < lo) lo = mn[i]; if (mx[i] > hi) hi = mx[i]; }
    mn2[b] = lo; mx2[b] = hi;
  }
  L = { mn, mx, mn2, mx2 };
  LOD.set(v, L);
  return L;
}
/** [min, max] of v[i0, i1), ignoring NaN and infinities. */
function rangeMM(v, i0, i1) {
  let lo = Infinity, hi = -Infinity;
  if (i1 - i0 < 512) {
    for (let i = i0; i < i1; i++) { const x = v[i]; if (x < lo && x !== -Infinity) lo = x; if (x > hi && x !== Infinity) hi = x; }
    return [lo, hi];
  }
  const L = lod(v);
  let i = i0;
  for (; i < i1 && (i & 63); i++) { const x = v[i]; if (x < lo && x !== -Infinity) lo = x; if (x > hi && x !== Infinity) hi = x; }
  while (i + 64 <= i1) {
    const b = i >> 6;
    if ((b & 63) === 0 && i + 4096 <= i1) { const b2 = b >> 6; if (L.mn2[b2] < lo && L.mn2[b2] !== -Infinity) lo = L.mn2[b2]; if (L.mx2[b2] > hi && L.mx2[b2] !== Infinity) hi = L.mx2[b2]; i += 4096; }
    else { if (L.mn[b] < lo && L.mn[b] !== -Infinity) lo = L.mn[b]; if (L.mx[b] > hi && L.mx[b] !== Infinity) hi = L.mx[b]; i += 64; }
  }
  for (; i < i1; i++) { const x = v[i]; if (x < lo && x !== -Infinity) lo = x; if (x > hi && x !== Infinity) hi = x; }
  return [lo, hi];
}
function viewMinMax(s) {
  if (s.konst) return [s.v[0], s.v[0]];
  const T = s.t, n = T.length;
  let i0 = lb(T, st.view.t0), i1 = ub(T, st.view.t1);
  if (s.step && i0 > 0) i0--;
  if (i1 <= i0) { i0 = Math.max(0, i0 - 1); i1 = Math.min(n, i1 + 1); }
  return rangeMM(s.v, i0, i1);
}

/* ---------- nice axis ranges ---------- */
function niceCeil(x) { const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }
function nextNice(s) { const p = Math.pow(10, Math.floor(Math.log10(s) + 1e-9)), m = Math.round(s / p * 10) / 10; return (m < 2 ? 2 : m < 2.5 ? 2.5 : m < 5 ? 5 : 10) * p; }
/** Range with exactly N steps of a nice size, so axes that share a graph share grid lines too. */
function nice(lo, hi, N) {
  if (hi - lo <= 1e-12 * Math.max(1, Math.abs(hi))) { const d = Math.abs(lo) > 1e-9 ? Math.abs(lo) * 0.05 : 0.5; lo -= d; hi += d; }
  const pad = (hi - lo) * 0.04;
  const lo2 = lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi2 = hi <= 0 ? Math.min(0, hi + pad) : hi + pad;
  let step = niceCeil((hi2 - lo2) / N), a = Math.floor(lo2 / step) * step;
  for (let k = 0; k < 8 && a + step * N < hi2 - step * 1e-9; k++) { step = nextNice(step); a = Math.floor(lo2 / step) * step; }
  const spare = Math.floor((a + N * step - hi2) / step + 1e-9);
  let shift = Math.floor(spare / 2);
  if (lo >= 0 && a - shift * step < 0) shift = Math.max(0, Math.floor(a / step + 1e-9));
  a -= shift * step;
  return { lo: a, hi: a + N * step, step };
}
/** Fit every axis of a graph. All axes use the same number of grid steps, chosen to waste the least space. Returns that number. */
function axisRanges(g, plan, plotHeight, mm) {
  const data = plan.map(a => {
    const man = g.axes[a.ax];
    if (man && isFinite(man.min) && isFinite(man.max) && man.max > man.min) return { man };
    let lo = Infinity, hi = -Infinity;
    for (const f of a.fields) { const r = mm(f); if (r[0] < lo) lo = r[0]; if (r[1] > hi) hi = r[1]; }
    return hi >= lo ? { lo, hi } : { empty: true };
  });
  const nMax = clamp(Math.floor(plotHeight / 30), 2, 9), nMin = clamp(Math.floor(plotHeight / 64), 2, nMax), ideal = plotHeight / 44;
  let best = null;
  for (let N = nMin; N <= nMax; N++) {
    let waste = 0;
    const fits = data.map(d => {
      if (d.man) { const stp = (d.man.max - d.man.min) / N; if (niceCeil(stp) / stp > 1.0001) waste += 0.3; return null; }
      if (d.empty) return null;
      const r = nice(d.lo, d.hi, N);
      waste += 1 - (d.hi - d.lo) / (r.hi - r.lo || 1);
      return r;
    });
    const score = waste + Math.abs(N - ideal) * 0.04;
    if (!best || score < best.score - 1e-9) best = { N, fits, score };
  }
  const N = best.N;
  plan.forEach((a, i) => {
    const d = data[i];
    if (d.man) { a.lo = d.man.min; a.hi = d.man.max; a.step = (a.hi - a.lo) / N; a.manual = true; a.empty = false; return; }
    const r = d.empty ? nice(0, 1, N) : best.fits[i];
    a.lo = r.lo; a.hi = r.hi; a.step = r.step; a.manual = false; a.empty = !!d.empty;
  });
  return N;
}
const TIME_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map(s => s * 1e6);

function drawFrameBase(g) {
  const ctx = g._ctx, c = st.colors;
  ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = c.surface; ctx.fillRect(0, 0, g._w, g._h);
  return ctx;
}
function drawAxes(ctx, g, plan, N, y0, y1) {
  const c = st.colors, axw = M.axw;
  for (const a of plan) {
    const isL = a.side === 'L';
    const ax = isL ? M.L - a.slot * axw : g._w - M.R + a.slot * axw;
    const cols = a.fields.map(fieldColor);
    const seg = (y1 - y0) / cols.length;
    ctx.lineWidth = 2;
    cols.forEach((col, k) => { ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(ax + (isL ? -1 : 1), y0 + k * seg); ctx.lineTo(ax + (isL ? -1 : 1), y0 + (k + 1) * seg); ctx.stroke(); });
    ctx.lineWidth = 1; ctx.strokeStyle = c.line;
    const font = `10.5px ${st.fonts.mono}`;
    for (let i = 0; i <= N; i++) {
      const y = y1 - i * (y1 - y0) / N, v = a.lo + i * a.step;
      ctx.beginPath(); ctx.moveTo(ax + (isL ? -2 : 2), Math.round(y) + 0.5); ctx.lineTo(ax + (isL ? -6 : 6), Math.round(y) + 0.5); ctx.stroke();
      let lab = fmtTick(v, a.step);
      ctx.font = font;
      while (lab.length > 3 && ctx.measureText(lab).width > axw - 10) lab = (+lab).toPrecision(Math.max(1, lab.replace(/[^0-9]/g, '').length - 1));
      text(ctx, lab, ax + (isL ? -8 : 8), clamp(y, y0 + 5, y1 - 4), c.muted, isL ? 'right' : 'left', 'middle', font);
    }
    const unit = (a.fields.find(f => f._r.unit) || { _r: { unit: '' } })._r.unit;
    let head = 'Y' + a.ax + (unit ? ' ' + unit : '');
    const hf = `600 11px ${st.fonts.cond}`;
    ctx.font = hf;
    while (head.length > 3 && ctx.measureText(head + (a.manual ? '  ' : '')).width > axw - 4) head = head.slice(0, -2) + '…';
    const hx = ax + (isL ? -3 : 3);
    text(ctx, head, hx, 10, c['ink-2'], isL ? 'right' : 'left', 'middle', hf);
    if (a.manual) {
      const w = ctx.measureText(head).width;
      ctx.fillStyle = c.sel; ctx.beginPath(); ctx.arc(isL ? hx - w - 5 : hx + w + 5, 10, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}
function drawTime(g) {
  const ctx = drawFrameBase(g), c = st.colors, ix = st.ix;
  const W = g._w, H = g._h, x0 = M.L, x1 = W - M.R, y0 = PT, y1 = H - PB;
  if (!ix) { text(ctx, 'Open a log to plot it', (x0 + x1) / 2, (y0 + y1) / 2, c.muted, 'center'); return; }
  const { t0, t1 } = st.view, plan = g._plan;
  const N = axisRanges(g, plan, y1 - y0, f => viewMinMax(f._r.series));
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 1, x1 - x0, y1 - y0 + 2); ctx.clip();
  if (st.set.armed) {
    ctx.fillStyle = c.armed;
    for (const a of ix.armed) { if (a.t1 < t0 || a.t0 > t1) continue; const xa = Math.max(x0, xOfT(g, a.t0)), xb = Math.min(x1, xOfT(g, a.t1)); ctx.fillRect(xa, y0, xb - xa, y1 - y0); }
  }
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i <= N; i++) { const y = Math.round(y1 - i * (y1 - y0) / N) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  const tStep = TIME_STEPS.find(s => (t1 - t0) / s <= Math.max(2, (x1 - x0) / 95)) || 7200e6;
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) { const x = Math.round(xOfT(g, t)) + 0.5; ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  ctx.stroke();
  if (st.set.modes) {
    ctx.strokeStyle = c.muted; ctx.globalAlpha = 0.45; ctx.setLineDash([2, 4]); ctx.beginPath();
    for (let i = 1; i < ix.modeSpans.length; i++) { const t = ix.modeSpans[i].t0; if (t < t0 || t > t1) continue; const x = Math.round(xOfT(g, t)) + 0.5; ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  if (st.set.errs && ix.errs.length) {
    ctx.strokeStyle = c.crit; ctx.globalAlpha = 0.55; ctx.beginPath();
    for (const e of ix.errs) { if (e.t < t0 || e.t > t1) continue; const x = Math.round(xOfT(g, e.t)) + 0.5; ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  for (const a of plan) {
    const k = (y1 - y0) / (a.hi - a.lo);
    const yOf = v => clamp(y1 - (v - a.lo) * k, -1e5, 1e5);
    for (const f of a.fields) drawSeries(ctx, g, f, yOf, x0, x1);
  }
  ctx.restore();
  ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
  const digits = tStep < 0.01e6 ? 3 : tStep < 0.1e6 ? 2 : tStep < 1e6 ? 1 : 0;
  const mono = `10.5px ${st.fonts.mono}`;
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
    const x = xOfT(g, t); if (x < x0 + 18 || x > x1 - 18) continue;
    text(ctx, fmtT(t, digits), x, y1 + 11, c.muted, 'center', 'middle', mono);
  }
  drawAxes(ctx, g, plan, N, y0, y1);
  emptyNote(ctx, g, plan, x0, x1, y0, y1);
}
function emptyNote(ctx, g, plan, x0, x1, y0, y1) {
  const c = st.colors;
  let msg = '';
  if (!g.fields.length) msg = 'Type a formula below, or click a field in the list on the left';
  else if (!plan.length) msg = g.fields.some(f => f._r && f._r.error) ? 'Fix the formula below to see it here' : (g.type === 'spectrum' && g.fields.some(f => ok(f) && f.visible)) ? 'A spectrum needs a field that changes over time' : 'Every field in this graph is hidden';
  else if (plan.every(a => a.empty)) msg = g.type === 'spectrum' ? 'Not enough samples in this range for a spectrum. Select or show a longer range.' : 'No samples in this part of the log';
  if (msg) text(ctx, msg, (x0 + x1) / 2, (y0 + y1) / 2, c.muted, 'center', 'middle', `13px ${st.fonts.ui}`);
}
function drawSeries(ctx, g, f, yOf, x0, x1) {
  const s = f._r.series, T = s.t, V = s.v, n = T.length;
  if (!n) return;
  const hlId = g._hl, hl = hlId === f.id, dim = hlId !== null && hlId !== undefined && !hl;
  ctx.strokeStyle = fieldColor(f); ctx.fillStyle = fieldColor(f);
  ctx.lineWidth = hl ? 2.6 : 1.6; ctx.globalAlpha = dim ? 0.3 : 1; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (s.konst) {
    const y = yOf(V[0]);
    ctx.setLineDash([7, 5]); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1; return;
  }
  const { t0, t1 } = st.view, span = t1 - t0, pw = x1 - x0;
  const X = t => x0 + (t - t0) / span * pw;
  const iA = lb(T, t0), iB = ub(T, t1);
  const i0 = Math.max(0, iA - 1), i1 = Math.min(n, iB + 1);
  const gap = EX.gapUs(s);
  ctx.beginPath();
  if (s.step) {
    let on = false, yp = 0;
    for (let i = i0; i < i1; i++) {
      const v = V[i]; if (v !== v) { on = false; continue; }
      const x = X(T[i]), y = yOf(v);
      if (!on) { ctx.moveTo(Math.max(x, x0 - 4), y); on = true; } else { ctx.lineTo(x, yp); ctx.lineTo(x, y); }
      yp = y;
    }
    if (on) ctx.lineTo(Math.min(x1 + 2, X(st.ix.tMax)), yp);
    ctx.stroke();
  } else if (i1 - i0 <= pw * 2.5) {
    let on = false, tp = -Infinity;
    for (let i = i0; i < i1; i++) {
      const v = V[i]; if (v !== v || v === Infinity || v === -Infinity) { on = false; continue; }
      const x = X(T[i]), y = yOf(v);
      if (!on || T[i] - tp > gap) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      on = true; tp = T[i];
    }
    ctx.stroke();
    if (iB - iA < pw / 9) {
      for (let i = i0; i < i1; i++) { const v = V[i]; if (v !== v) continue; ctx.beginPath(); ctx.arc(X(T[i]), yOf(v), hl ? 3 : 2.2, 0, Math.PI * 2); ctx.fill(); }
    }
  } else {
    let ia = iA, on = false, last = -1;
    if (iA > 0 && V[iA - 1] === V[iA - 1] && T[iA] - T[iA - 1] <= gap) { ctx.moveTo(X(T[iA - 1]), yOf(V[iA - 1])); on = true; last = iA - 1; }
    const cols = Math.ceil(pw);
    for (let cI = 0; cI < cols; cI++) {
      const ib = lb(T, t0 + (cI + 1) / pw * span, ia, n);
      if (ib > ia) {
        const r = rangeMM(V, ia, ib);
        if (r[0] <= r[1]) {
          const x = x0 + cI + 0.5, vf = V[ia], vl = V[ib - 1];
          const yf = yOf(vf === vf ? vf : r[0]), yl = yOf(vl === vl ? vl : r[1]);
          if (!on || (last >= 0 && T[ia] - T[last] > gap)) ctx.moveTo(x, yf); else ctx.lineTo(x, yf);
          ctx.lineTo(x, yOf(r[1])); ctx.lineTo(x, yOf(r[0])); ctx.lineTo(x, yl);
          on = true; last = ib - 1;
        } else on = false;
      }
      ia = ib;
    }
    if (on && ia < n && V[ia] === V[ia] && T[ia] - T[last] <= gap) ctx.lineTo(X(T[ia]), yOf(V[ia]));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ---------- spectrum graphs ---------- */
function specRange() { return st.sel && st.sel.t1 > st.sel.t0 ? st.sel : st.view; }
function ensureSpec(g) {
  const r = specRange(), key = Math.round(r.t0) + '|' + Math.round(r.t1);
  let pending = false;
  for (const f of g.fields) {
    if (!f.visible || !ok(f) || f._r.series.konst) { f._spec = null; continue; }
    const k = f._r.key + '|' + key;
    if (f._spec && f._spec.k === k) continue;
    if (f._spec && performance.now() - st.viewAt < 160) { pending = true; continue; }
    f._spec = { k, d: EX.spectrum(f._r.series, r.t0, r.t1) };
  }
  if (pending) { clearTimeout(g._specT); g._specT = setTimeout(() => { g._dirty = true; requestDraw(); }, 200); }
}
function specX(g) {
  let fmax = 0, fmin = Infinity;
  for (const f of g.fields) { const d = f._spec && f._spec.d; if (d && f.visible) { fmax = Math.max(fmax, d.fs / 2); fmin = Math.min(fmin, d.res); } }
  if (!fmax) { fmax = 1; fmin = 0.01; }
  let lo = g.spec.logf ? fmin : 0, hi = fmax;
  if (g.spec.f0 !== null && g.spec.f1 > g.spec.f0) { lo = Math.max(g.spec.logf ? fmin : 0, g.spec.f0); hi = Math.min(fmax, g.spec.f1); if (hi <= lo) { lo = g.spec.logf ? fmin : 0; hi = fmax; } }
  const log = g.spec.logf, x0 = M.L, pw = plotW(g);
  const L0 = Math.log10(lo), L1 = Math.log10(hi);
  return {
    lo, hi, log,
    x: fq => log ? x0 + (Math.log10(Math.max(fq, lo)) - L0) / (L1 - L0) * pw : x0 + (fq - lo) / (hi - lo) * pw,
    f: x => log ? Math.pow(10, L0 + (x - x0) / pw * (L1 - L0)) : lo + (x - x0) / pw * (hi - lo)
  };
}
const ampT = (g, a) => g.spec.db ? 20 * Math.log10(Math.max(a, 1e-12)) : a;
function drawSpec(g) {
  const ctx = drawFrameBase(g), c = st.colors;
  const W = g._w, H = g._h, x0 = M.L, x1 = W - M.R, y0 = PT, y1 = H - PB;
  if (!st.ix) { text(ctx, 'Open a log to plot it', (x0 + x1) / 2, (y0 + y1) / 2, c.muted, 'center'); return; }
  ensureSpec(g);
  const plan = g._plan;
  const fx = g._fx = specX(g);
  for (const a of plan) a.fields = a.fields.filter(f => f._spec && f._spec.d);
  const N = axisRanges(g, plan, y1 - y0, f => {
    const d = f._spec.d; let mx = -Infinity, mn = Infinity;
    for (let k = 1; k < d.f.length; k++) { if (d.f[k] < fx.lo || d.f[k] > fx.hi) continue; const v = ampT(g, d.a[k]); if (v > mx) mx = v; if (v < mn) mn = v; }
    if (!g.spec.db) return [0, mx];
    return [Math.max(mn, mx - 80), mx];
  });
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 1, x1 - x0, y1 - y0 + 2); ctx.clip();
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i <= N; i++) { const y = Math.round(y1 - i * (y1 - y0) / N) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  const ticks = freqTicks(fx, x1 - x0);
  for (const t of ticks) { const x = Math.round(fx.x(t.f)) + 0.5; ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  ctx.stroke();
  const labels = [];
  for (const a of plan) {
    const k = (y1 - y0) / (a.hi - a.lo), yOf = v => clamp(y1 - (v - a.lo) * k, -1e5, 1e5);
    for (const f of a.fields) {
      const d = f._spec.d, hlOn = g._hl === f.id, dim = g._hl !== null && g._hl !== undefined && !hlOn;
      ctx.strokeStyle = fieldColor(f); ctx.lineWidth = hlOn ? 2.4 : 1.5; ctx.globalAlpha = dim ? 0.3 : 1; ctx.lineJoin = 'round';
      ctx.beginPath();
      let on = false;
      for (let i = fx.log ? 1 : 0; i < d.f.length; i++) {
        if (d.f[i] < fx.lo * 0.999 && i + 1 < d.f.length && d.f[i + 1] < fx.lo) continue;
        if (d.f[i] > fx.hi * 1.001 && on) { ctx.lineTo(fx.x(d.f[i]), yOf(ampT(g, d.a[i]))); break; }
        const x = fx.x(d.f[i]), y = yOf(ampT(g, d.a[i]));
        if (!on) { ctx.moveTo(x, y); on = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
      const p = d.peaks.find(pk => pk.f >= fx.lo && pk.f <= fx.hi);
      if (p) labels.push({ x: fx.x(p.f), y: yOf(ampT(g, p.a)), txt: fmtFreq(p.f), col: fieldColor(f) });
    }
  }
  ctx.restore();
  ctx.font = `600 10.5px ${st.fonts.mono}`;
  const boxes = [];
  const placed = [];
  for (const L of labels.sort((a, b) => a.y - b.y)) {
    const dup = placed.some(p => p.txt === L.txt && Math.abs(p.x - L.x) < 30);
    ctx.fillStyle = L.col;
    if (dup) { ctx.beginPath(); ctx.moveTo(L.x - 4, L.y - 8); ctx.lineTo(L.x + 4, L.y - 8); ctx.lineTo(L.x, L.y - 3); ctx.fill(); continue; }
    placed.push(L); ctx.beginPath(); ctx.moveTo(L.x - 4, L.y - 8); ctx.lineTo(L.x + 4, L.y - 8); ctx.lineTo(L.x, L.y - 3); ctx.fill();
    const w = ctx.measureText(L.txt).width + 8;
    let bx = clamp(L.x - w / 2, x0 + 2, x1 - w - 2), by = Math.max(y0 + 1, L.y - 24);
    for (let k = 0; k < 6 && boxes.some(b => bx < b.x + b.w && bx + w > b.x && by < b.y + 15 && by + 15 > b.y); k++) by = Math.min(y1 - 16, by + 16);
    boxes.push({ x: bx, y: by, w });
    ctx.fillStyle = c.surface; ctx.globalAlpha = 0.88; ctx.fillRect(bx, by, w, 15); ctx.globalAlpha = 1;
    text(ctx, L.txt, bx + 4, by + 8, c.ink, 'left', 'middle', `600 10.5px ${st.fonts.mono}`);
  }
  ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
  const mono = `10.5px ${st.fonts.mono}`;
  for (const t of ticks) { const x = fx.x(t.f); if (x < x0 + 12 || x > x1 - 30) continue; text(ctx, t.label, x, y1 + 11, c.muted, 'center', 'middle', mono); }
  text(ctx, 'Hz', x1 - 2, y1 + 11, c.muted, 'right', 'middle', mono);
  drawAxes(ctx, g, plan, N, y0, y1);
  emptyNote(ctx, g, plan.filter(a => a.fields.length), x0, x1, y0, y1);
  const r = specRange(), one = g.fields.find(f => f._spec && f._spec.d);
  g._el.specInfo.textContent = (st.sel ? 'Selected ' : 'Visible ') + fmtT(r.t0) + '–' + fmtT(r.t1) + (one ? ` · ${fmtFreq(one._spec.d.res)} bins · ${one._spec.d.count} averages` : '');
}
function fmtFreq(f) { return (f >= 100 ? f.toFixed(0) : f >= 10 ? f.toFixed(1) : f >= 1 ? f.toFixed(2) : f.toPrecision(2)) + ' Hz'; }
function freqTicks(fx, pw) {
  const out = [];
  if (fx.log) {
    const a = Math.floor(Math.log10(fx.lo)), b = Math.ceil(Math.log10(fx.hi));
    const dec = pw / Math.max(1, (Math.log10(fx.hi) - Math.log10(fx.lo)));
    const mults = dec > 260 ? [1, 2, 5] : [1];
    for (let e = a; e <= b; e++) for (const m of mults) { const f = m * Math.pow(10, e); if (f >= fx.lo && f <= fx.hi) out.push({ f, label: trimZ(f.toPrecision(3)) }); }
    return out;
  }
  const step = niceCeil((fx.hi - fx.lo) / Math.max(2, pw / 80));
  for (let f = Math.ceil(fx.lo / step) * step; f <= fx.hi + 1e-9; f += step) out.push({ f, label: trimZ(f.toFixed(6)) });
  return out;
}

/* ---------- overlay: cursor, selection, drag bands ---------- */
function valueAt(s, t) {
  if (!s) return NaN;
  if (s.konst) return s.v[0];
  const T = s.t, n = T.length;
  if (!n) return NaN;
  const i = lb(T, t);
  if (s.step) { if (i < n && T[i] === t) return s.v[i]; return i > 0 ? s.v[i - 1] : NaN; }
  let k;
  if (i <= 0) k = 0; else if (i >= n) k = n - 1; else k = (t - T[i - 1] <= T[i] - t) ? i - 1 : i;
  const tol = Math.max(3 * EX.medianDt(s), 6 * (st.view.t1 - st.view.t0) / 1000);
  return Math.abs(T[k] - t) <= tol ? s.v[k] : NaN;
}
function fmtVal(f, v) {
  if (f._r.series.isMode && st.ix) return DF.modeName(st.ix, v);
  return fmtNum(v) + (f._r.unit ? ' ' + f._r.unit : '');
}
function specAt(f, fq) {
  const d = f._spec && f._spec.d; if (!d) return NaN;
  const k = clamp(Math.round(fq / (d.fs / d.seg)), 0, d.a.length - 1);
  return d.a[k];
}
function drawOver(g) {
  const ctx = g._octx, c = st.colors, W = g._w, H = g._h, x0 = M.L, x1 = W - M.R, y0 = PT, y1 = H - PB;
  ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!st.ix) return;
  if (g.type === 'spectrum') {
    if (g._fband) { const a = Math.min(g._fband[0], g._fband[1]), b = Math.max(g._fband[0], g._fband[1]); ctx.fillStyle = c.zoomfill; ctx.fillRect(a, y0, b - a, y1 - y0); }
    if (st.hoverG === g && g._fh !== null && g._fh !== undefined && g._fx) {
      const x = g._fx.x(g._fh);
      ctx.strokeStyle = c.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); ctx.stroke(); ctx.setLineDash([]);
      for (const a of g._plan) {
        const k = (y1 - y0) / (a.hi - a.lo);
        for (const f of a.fields) { const v = specAt(f, g._fh); if (v === v) dot(ctx, x, clamp(y1 - (ampT(g, v) - a.lo) * k, y0, y1), fieldColor(f)); }
      }
    }
    return;
  }
  ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, H); ctx.clip();
  const band = (a, b, fill, edge) => {
    const xa = xOfT(g, a), xb = xOfT(g, b);
    ctx.fillStyle = fill; ctx.fillRect(xa, y0, xb - xa, y1 - y0);
    if (edge) { ctx.fillStyle = edge; ctx.fillRect(Math.round(xa) - 1, y0, 2, y1 - y0); ctx.fillRect(Math.round(xb) - 1, y0, 2, y1 - y0); }
  };
  if (st.sel) band(st.sel.t0, st.sel.t1, c.selfill, c.sel);
  if (st.band) band(st.band.t0, st.band.t1, st.band.kind === 'select' ? c.selfill : c.zoomfill, st.band.kind === 'select' ? c.sel : c.accent);
  if (st.pin !== null) {
    const x = Math.round(xOfT(g, st.pin)) + 0.5;
    ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    if (g === st.graphs.find(o => o.type === 'time')) {
      const lab = fmtT(st.pin, 2); ctx.font = `600 10.5px ${st.fonts.mono}`;
      const w = ctx.measureText(lab).width + 8;
      ctx.fillStyle = c.ink; ctx.fillRect(clamp(x - w / 2, x0, x1 - w), 3, w, 15);
      text(ctx, lab, clamp(x - w / 2, x0, x1 - w) + 4, 11, c.surface, 'left', 'middle', `600 10.5px ${st.fonts.mono}`);
    }
  }
  const tc = st.cursor !== null ? st.cursor : null;
  if (tc !== null) {
    const x = Math.round(xOfT(g, tc)) + 0.5;
    ctx.strokeStyle = c.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); ctx.setLineDash([]);
  }
  const tDots = tc !== null ? tc : st.pin;
  if (tDots !== null) {
    const x = xOfT(g, tDots);
    for (const a of g._plan) {
      const k = (y1 - y0) / (a.hi - a.lo);
      for (const f of a.fields) { const v = valueAt(f._r.series, tDots); if (v === v && isFinite(v)) dot(ctx, x, clamp(y1 - (v - a.lo) * k, y0 - 2, y1 + 2), fieldColor(f)); }
    }
  }
  ctx.restore();
}
function dot(ctx, x, y, col) {
  ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2);
  ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = st.colors.surface; ctx.stroke();
}

/* ---------- overview strip ---------- */
const OV_H = 50;
function ovGeom() {
  const cv = $('overview'), W = Math.max(220, Math.floor(cv.parentElement.clientWidth));
  return { cv, W, x0: M.L, x1: W - M.R };
}
function drawOverview() {
  const { cv, W, x0, x1 } = ovGeom(), c = st.colors, dpr = st.dpr;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(OV_H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(OV_H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = c.surface; ctx.fillRect(0, 0, W, OV_H);
  const ix = st.ix;
  text(ctx, 'Modes', x0 - 8, 13, c.faint, 'right', 'middle', `600 10.5px ${st.fonts.cond}`);
  text(ctx, 'Events', x0 - 8, 32, c.faint, 'right', 'middle', `600 10.5px ${st.fonts.cond}`);
  if (!ix) return;
  const span = Math.max(1, ix.tMax - ix.tMin);
  const X = t => x0 + (t - ix.tMin) / span * (x1 - x0);
  st.ovX = X; st.ovT = x => ix.tMin + (x - x0) / (x1 - x0) * span;
  // armed band
  ctx.fillStyle = c.armed;
  for (const a of ix.armed) ctx.fillRect(X(a.t0), 2, Math.max(1, X(a.t1) - X(a.t0)), OV_H - 4);
  // modes
  const modeColor = new Map(); let mc = 0;
  for (const sp of ix.modeSpans) if (!modeColor.has(sp.mode)) modeColor.set(sp.mode, mc < 8 ? c['m' + (++mc)] : c.faint);
  for (const sp of ix.modeSpans) {
    const xa = X(sp.t0), xb = X(sp.t1), w = xb - xa;
    if (w <= 0) continue;
    ctx.fillStyle = modeColor.get(sp.mode); ctx.globalAlpha = 0.28; ctx.fillRect(xa, 5, w, 16); ctx.globalAlpha = 1;
    ctx.fillRect(xa, 19, w, 2);
    const nm = DF.modeName(ix, sp.mode);
    ctx.font = `600 10.5px ${st.fonts.cond}`;
    if (ctx.measureText(nm).width + 8 < w) text(ctx, nm, xa + 4, 13, c.ink, 'left', 'middle', `600 10.5px ${st.fonts.cond}`);
    ctx.fillStyle = c.surface; ctx.fillRect(Math.round(xa), 5, 1, 16);
  }
  // events
  ctx.fillStyle = c.faint;
  for (const m of ix.texts) ctx.fillRect(Math.round(X(m.t)), 27, 1, 10);
  ctx.fillStyle = c.crit;
  for (const e of ix.errs) ctx.fillRect(Math.round(X(e.t)) - 0.5, 25, 2, 14);
  ctx.fillStyle = c['armed-line'];
  for (const a of ix.armed) {
    for (const [t, up] of [[a.t0, true], [a.t1, false]]) {
      const x = X(t); ctx.beginPath();
      if (up) { ctx.moveTo(x - 4, 38); ctx.lineTo(x + 4, 38); ctx.lineTo(x, 30); } else { ctx.moveTo(x - 4, 30); ctx.lineTo(x + 4, 30); ctx.lineTo(x, 38); }
      ctx.fill();
    }
  }
  for (const a of ix.armed) ctx.fillRect(X(a.t0), OV_H - 6, Math.max(1, X(a.t1) - X(a.t0)), 2);
  // selection, pin
  if (st.sel) { ctx.fillStyle = c.sel; ctx.fillRect(X(st.sel.t0), 1, Math.max(2, X(st.sel.t1) - X(st.sel.t0)), 3); }
  // view window
  const va = X(st.view.t0), vb = X(st.view.t1);
  ctx.fillStyle = c.surface; ctx.globalAlpha = 0.62;
  ctx.fillRect(x0, 0, Math.max(0, va - x0), OV_H); ctx.fillRect(vb, 0, Math.max(0, x1 - vb), OV_H); ctx.globalAlpha = 1;
  ctx.strokeStyle = c.ink; ctx.lineWidth = 1.5; ctx.strokeRect(va + 0.75, 1.25, Math.max(3, vb - va - 1.5), OV_H - 2.5);
  if (st.pin !== null) { ctx.fillStyle = c.ink; ctx.fillRect(Math.round(X(st.pin)), 0, 1, OV_H); }
  if (st.cursor !== null) { ctx.fillStyle = c.muted; ctx.fillRect(Math.round(X(st.cursor)), 0, 1, OV_H); }
}

/* ---------- readouts, live values, statistics ---------- */
function modeAt(t) {
  const ix = st.ix; if (!ix) return null;
  let m = null; for (const sp of ix.modeSpans) { if (sp.t0 <= t) m = sp.mode; else break; }
  return m;
}
const armedAt = t => st.ix && st.ix.armed.some(a => t >= a.t0 && t <= a.t1);
function updateReadouts() {
  const ix = st.ix;
  const t = st.cursor !== null ? st.cursor : st.pin;
  $('readT').textContent = t !== null ? fmtT(t, 2) : '–';
  const m = t !== null ? modeAt(t) : null;
  $('readMode').textContent = t !== null && ix ? [m !== null ? DF.modeName(ix, m) : '', armedAt(t) ? 'armed' : 'disarmed'].filter(Boolean).join(' · ') : '';
  $('readView').textContent = ix ? `${fmtT(st.view.t0)}–${fmtT(st.view.t1)} · ${fmtDur(st.view.t1 - st.view.t0)}` : '–';
  const si = $('selInfo');
  si.hidden = !st.sel;
  if (st.sel) $('selText').textContent = `${fmtT(st.sel.t0, 2)}–${fmtT(st.sel.t1, 2)} · ${fmtDur(st.sel.t1 - st.sel.t0)}`;
  $('zBack').disabled = !st.hist.length;
}
function updateValues() {
  const t = st.cursor !== null ? st.cursor : st.pin;
  for (const g of st.graphs) for (const f of g.fields) {
    if (!f._row && !f._leg) continue;
    let txt = '–', live = false;
    if (ok(f)) {
      if (g.type === 'spectrum') {
        if (st.hoverG === g && g._fh !== null && g._fh !== undefined) { const v = specAt(f, g._fh); if (v === v) { txt = fmtNum(v, 4); live = true; } }
      } else if (t !== null) {
        const v = valueAt(f._r.series, t);
        if (v === v) { txt = fmtVal(f, v); live = st.cursor !== null; }
      }
    }
    if (f._leg) { if (f._leg.textContent !== txt) f._leg.textContent = txt; continue; }
    if (f._row.val.textContent !== txt) f._row.val.textContent = txt;
    f._row.val.classList.toggle('live', live);
  }
}
let statT = 0;
function scheduleStats() { clearTimeout(statT); statT = setTimeout(updateStats, 120); }
function updateStats() {
  const r = st.sel || st.view, key = Math.round(r.t0) + '|' + Math.round(r.t1) + '|' + (st.sel ? 's' : 'v');
  for (const g of st.graphs) {
    if (!g._el) continue;
    const head = g._el.fields.querySelector('[data-stats-head]');
    if (head) head.textContent = statsHeader(g);
    for (const f of g.fields) {
      if (!f._row) continue;
      const el = f._row.stats;
      if (!ok(f)) { el.textContent = ''; el.title = ''; continue; }
      if (g.type === 'spectrum') {
        const d = f._spec && f._spec.d, p = d && d.peaks[0];
        el.textContent = p ? `${fmtFreq(p.f)} · ${fmtNum(p.a, 3)}` : '';
        el.title = d ? d.peaks.map(q => `${fmtFreq(q.f)}: ${fmtNum(q.a, 4)}`).join('\n') : '';
        continue;
      }
      const k = f._r.key + '|' + key;
      if (f._stat === k) continue;
      f._stat = k;
      const s = f._r.series;
      if (s.konst) { el.innerHTML = `<i>constant</i> ${esc(fmtShort(s.v[0]))}`; el.title = ''; continue; }
      const T = s.t;
      let i0 = lb(T, r.t0), i1 = ub(T, r.t1);
      if (s.step && i0 > 0 && T[i0] !== r.t0) i0--;
      let lo = Infinity, hi = -Infinity, sum = 0, cnt = 0;
      const V = s.v;
      for (let i = i0; i < i1; i++) { const x = V[i]; if (x === x && x !== Infinity && x !== -Infinity) { sum += x; cnt++; if (x < lo) lo = x; if (x > hi) hi = x; } }
      if (!cnt) { el.innerHTML = '<i>no samples</i>'; el.title = ''; continue; }
      el.innerHTML = `${esc(fmtShort(lo))} <i>·</i> ${esc(fmtShort(sum / cnt))} <i>·</i> ${esc(fmtShort(hi))}`;
      el.title = `${cnt.toLocaleString()} samples${s.step ? ' (step values)' : ''}\nMin ${fmtNum(lo)}\nMean ${fmtNum(sum / cnt)}\nMax ${fmtNum(hi)}${f._r.unit ? '\nUnit ' + f._r.unit : ''}`;
    }
  }
}
