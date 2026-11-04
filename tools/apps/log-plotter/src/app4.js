/* ================= view, interaction, panels, export, start-up ================= */
function setView(t0, t1) {
  const ix = st.ix; if (!ix) return;
  const full = Math.max(ix.tMax - ix.tMin, 1e3), minSpan = Math.min(full, 20e3);
  const span = clamp(t1 - t0, minSpan, full);
  let a = t0 + ((t1 - t0) - span) / 2;
  a = clamp(a, ix.tMin, ix.tMax - span);
  if (a === st.view.t0 && a + span === st.view.t1) return;
  st.view = { t0: a, t1: a + span };
  st.viewAt = performance.now();
  requestDraw(true); scheduleStats();
  if (V3.g && V3.cfg && V3.cfg.range === 'view') { clearTimeout(V3._vt); V3._vt = setTimeout(() => V3.apply(), 220); }
}
function pushHist(v) { const x = v || st.view; const last = st.hist[st.hist.length - 1]; if (!last || last.t0 !== x.t0 || last.t1 !== x.t1) st.hist.push({ t0: x.t0, t1: x.t1 }); if (st.hist.length > 60) st.hist.shift(); }
function zoomBack() { const v = st.hist.pop(); if (v) setView(v.t0, v.t1); requestOverlay(); }
function zoomAll() { if (!st.ix) return; pushHist(); setView(st.ix.tMin, st.ix.tMax); }
function zoomSel() { if (!st.sel) return; pushHist(); const pad = (st.sel.t1 - st.sel.t0) * 0.04; setView(st.sel.t0 - pad, st.sel.t1 + pad); }
function zoomBy(k, center) {
  const v = st.view, c = center !== undefined ? center : (v.t0 + v.t1) / 2;
  setView(c - (c - v.t0) * k, c + (v.t1 - c) * k);
}
function panBy(frac) { const v = st.view, d = (v.t1 - v.t0) * frac; setView(v.t0 + d, v.t1 + d); }
function goTo(t) {
  if (!st.ix) return;
  pushHist();
  let span = st.view.t1 - st.view.t0;
  if (span > 120e6) span = 40e6;
  setView(t - span / 2, t + span / 2);
  st.pin = t; requestDraw(true);
}
function setSel(s) {
  st.sel = s && s.t1 > s.t0 ? s : null;
  for (const g of st.graphs) { for (const f of g.fields) f._stat = null; if (g.type === 'spectrum') g._dirty = true; }
  scheduleStats(); requestDraw();
}
function applyDragMode() {
  for (const b of $('dragSeg').children) b.setAttribute('aria-pressed', String(b.dataset.m === st.set.drag));
  for (const g of st.graphs) if (g._el && g.type === 'time') g._el.over.style.cursor = st.set.drag === 'pan' ? 'grab' : 'crosshair';
}

/* ---------- pointer handling on graphs ---------- */
let drag = null;
function xy(e, el) { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function hitAxis(g, x) {
  if (x >= M.L && x <= g._w - M.R) return null;
  for (const a of g._plan || []) {
    const ax = a.side === 'L' ? M.L - a.slot * M.axw : g._w - M.R + a.slot * M.axw;
    if (a.side === 'L' ? (x <= ax && x > ax - M.axw) : (x >= ax && x < ax + M.axw)) return a;
  }
  return null;
}
function attachPlot(g) {
  const cv = g._el.over;
  cv.addEventListener('pointerdown', e => {
    if (!st.ix || e.button === 2) return;
    setActive(g);
    const { x, y } = xy(e, cv);
    const a = hitAxis(g, x);
    hideTip(g);
    if (a) { cv.setPointerCapture(e.pointerId); drag = { g, kind: 'axis', a, x0: x, y0: y, lo: a.lo, hi: a.hi, moved: false, cx: e.clientX, cy: e.clientY }; return; }
    if (x < M.L || x > g._w - M.R) return;
    if (e.pointerType === 'touch' && st.set.drag === 'pan') { /* let the page scroll; pan with two fingers is not supported */ }
    cv.setPointerCapture(e.pointerId);
    if (g.type === 'spectrum') { drag = { g, kind: 'fzoom', x0: x, x1: x, y0: y, moved: false }; return; }
    let mode = st.set.drag;
    if (e.shiftKey) mode = 'select'; else if (e.altKey || e.ctrlKey || e.metaKey || e.button === 1) mode = 'pan';
    drag = { g, kind: mode, x0: x, y0: y, t0: tOfX(g, x), view0: { t0: st.view.t0, t1: st.view.t1 }, moved: false };
    if (mode === 'pan') cv.style.cursor = 'grabbing';
  });
  cv.addEventListener('pointermove', e => {
    const { x, y } = xy(e, cv);
    if (drag && drag.g === g) {
      if (Math.abs(x - drag.x0) > 3 || Math.abs(y - drag.y0) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.kind === 'axis') {
        const span = drag.hi - drag.lo, dy = (y - drag.y0) / plotH(g) * span;
        g.axes[drag.a.ax] = { min: drag.lo + dy, max: drag.hi + dy }; g._dirty = true; requestDraw(); updateResetY(g);
      } else if (drag.kind === 'pan') {
        const dt = (x - drag.x0) / plotW(g) * (drag.view0.t1 - drag.view0.t0);
        setView(drag.view0.t0 - dt, drag.view0.t1 - dt);
      } else if (drag.kind === 'zoom' || drag.kind === 'select') {
        const t = clamp(tOfX(g, clamp(x, M.L, g._w - M.R)), st.ix.tMin, st.ix.tMax);
        st.band = { kind: drag.kind, t0: Math.min(drag.t0, t), t1: Math.max(drag.t0, t) };
        st.cursor = t; requestOverlay();
      } else if (drag.kind === 'fzoom') { drag.x1 = clamp(x, M.L, g._w - M.R); g._fband = [drag.x0, drag.x1]; requestOverlay(); }
      return;
    }
    const a = st.ix ? hitAxis(g, x) : null;
    cv.style.cursor = a ? 'ns-resize' : (g.type === 'time' && st.set.drag === 'pan' ? 'grab' : 'crosshair');
    st.hoverG = g;
    const inPlot = x >= M.L && x <= g._w - M.R;
    if (g.type === 'time') st.cursor = inPlot && st.ix ? tOfX(g, x) : null;
    else g._fh = inPlot && g._fx ? g._fx.f(x) : null;
    if (inPlot && st.ix) showTip(g, x, y); else hideTip(g);
    requestOverlay();
  });
  const end = (e, cancel) => {
    const d = drag;
    if (!d || d.g !== g) return;
    drag = null;
    if (d.kind === 'pan') cv.style.cursor = 'grab';
    if (d.kind === 'axis') { if (d.moved) changed(); else if (!cancel) axisMenu(g, d.a, d.cx, d.cy); return; }
    if (d.kind === 'fzoom') {
      g._fband = null;
      if (!cancel && d.moved && Math.abs(d.x1 - d.x0) > 4 && g._fx) { g.spec.f0 = g._fx.f(Math.min(d.x0, d.x1)); g.spec.f1 = g._fx.f(Math.max(d.x0, d.x1)); updateResetY(g); changed(); }
      g._dirty = true; requestDraw(); return;
    }
    if (cancel) { st.band = null; requestOverlay(); return; }
    if (!d.moved) {
      const t = d.t0;
      st.pin = (st.pin !== null && Math.abs(xOfT(g, st.pin) - d.x0) < 6) ? null : t;
      requestDraw(); return;
    }
    if (d.kind === 'zoom' && st.band && st.band.t1 > st.band.t0) { pushHist(d.view0); setView(st.band.t0, st.band.t1); }
    else if (d.kind === 'select' && st.band) setSel({ t0: st.band.t0, t1: st.band.t1 });
    else if (d.kind === 'pan') pushHist(d.view0);
    st.band = null; requestDraw();
  };
  cv.addEventListener('pointerup', e => end(e, false));
  cv.addEventListener('pointercancel', e => end(e, true));
  cv.addEventListener('pointerleave', () => {
    if (drag) return;
    if (g.type === 'time') st.cursor = null; else g._fh = null;
    st.hoverG = null; hideTip(g); requestOverlay();
  });
  cv.addEventListener('dblclick', e => {
    if (!st.ix) return;
    const { x } = xy(e, cv);
    const a = hitAxis(g, x);
    if (a) { delete g.axes[a.ax]; g._dirty = true; updateResetY(g); changed(); requestDraw(); return; }
    if (g.type === 'spectrum') { g.spec.f0 = g.spec.f1 = null; g._dirty = true; updateResetY(g); changed(); requestDraw(); return; }
    zoomAll();
  });
  cv.addEventListener('wheel', e => {
    if (!st.ix) return;
    const { x, y } = xy(e, cv);
    const a = hitAxis(g, x);
    const k = Math.pow(1.0018, e.deltaY * (e.deltaMode === 1 ? 30 : 1));
    if (a) {
      e.preventDefault();
      const y0 = PT, y1 = g._h - PB, v = a.lo + (y1 - y) / (y1 - y0) * (a.hi - a.lo);
      g.axes[a.ax] = { min: v - (v - a.lo) * k, max: v + (a.hi - v) * k };
      g._dirty = true; requestDraw(); updateResetY(g); clearTimeout(g._wt); g._wt = setTimeout(changed, 400);
      return;
    }
    const zoomKey = e.ctrlKey || e.metaKey || st.set.wheel;
    if (g.type === 'spectrum') {
      if (!zoomKey || !g._fx) { wheelHint(); return; }
      e.preventDefault();
      const fx = g._fx, f = fx.f(clamp(x, M.L, g._w - M.R));
      let lo = fx.lo, hi = fx.hi;
      if (fx.log) { const L = Math.log10(f); lo = Math.pow(10, L - (L - Math.log10(lo)) * k); hi = Math.pow(10, L + (Math.log10(hi) - L) * k); }
      else { lo = f - (f - lo) * k; hi = f + (hi - f) * k; }
      g.spec.f0 = Math.max(0, lo); g.spec.f1 = hi; g._dirty = true; updateResetY(g); requestDraw(); clearTimeout(g._wt); g._wt = setTimeout(changed, 400);
      return;
    }
    const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (zoomKey && !horiz) { e.preventDefault(); zoomBy(k, tOfX(g, clamp(x, M.L, g._w - M.R))); hideTip(g); }
    else if (horiz || e.shiftKey) { e.preventDefault(); panBy((horiz ? e.deltaX : e.deltaY) / plotW(g)); }
    else wheelHint();
  }, { passive: false });
}
function pointAnchor(x, y) { return { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }), contains: () => false }; }
function axisMenu(g, a, x, y) {
  const unit = (a.fields.find(f => f._r.unit) || { _r: { unit: '' } })._r.unit;
  openMenu(pointAnchor(x, y), [
    { head: `Axis Y${a.ax}${unit ? ' · ' + unit : ''}` },
    { label: 'Fit to the data', disabled: !g.axes[a.ax], action: () => { delete g.axes[a.ax]; g._dirty = true; updateResetY(g); changed(); requestDraw(); } },
    { label: 'Set the range…', action: () => axisRangeModal(g, a) },
    { label: 'Start at zero', action: () => { const hi = Math.max(a.hi, 0), lo = Math.min(a.lo, 0); g.axes[a.ax] = { min: a.lo >= 0 ? 0 : lo, max: a.hi <= 0 ? 0 : hi }; g._dirty = true; updateResetY(g); changed(); requestDraw(); } },
    { sep: true },
    { head: 'Scroll on an axis to zoom it, drag to move it' }
  ]);
}
function axisRangeModal(g, a) {
  const wrap = h('div');
  wrap.style.display = 'flex'; wrap.style.gap = '12px'; wrap.style.flexWrap = 'wrap';
  const mk = (label, id, v) => { const l = h('label', 'lbl', label); const i = h('input', 'inp num'); i.id = id; i.inputMode = 'decimal'; i.value = String(+v.toPrecision(6)); i.style.width = '9em'; l.append(i); wrap.append(l); return i; };
  const lo = mk('Bottom', 'axMin', a.lo), hi = mk('Top', 'axMax', a.hi);
  const err = h('p', 'f-err'); err.style.flexBasis = '100%'; wrap.append(err);
  const apply = () => {
    const a0 = parseFloat(lo.value), a1 = parseFloat(hi.value);
    if (!(isFinite(a0) && isFinite(a1)) || a1 <= a0) { err.textContent = 'Enter two numbers with the top above the bottom.'; return false; }
    g.axes[a.ax] = { min: a0, max: a1 }; g._dirty = true; updateResetY(g); changed(); requestDraw(); return true;
  };
  for (const i of [lo, hi]) i.addEventListener('keydown', e => { if (e.key === 'Enter' && apply()) closeModal(); });
  openModal(`Range of axis Y${a.ax}`, wrap, [{ label: 'Cancel', action: () => {} }, { label: 'Apply', primary: true, action: apply }]);
}
function wheelHint() {
  if (st.wheelHinted) return;
  st.wheelHinted = true;
  toast('Hold Ctrl (⌘ on a Mac) and scroll to zoom. Under View you can make plain scrolling zoom.', { label: 'Turn on', fn: () => { st.set.wheel = true; saveSettings(); } });
}
function attachResize(g) {
  const rz = g._el.rz;
  let s = null;
  rz.addEventListener('pointerdown', e => { rz.setPointerCapture(e.pointerId); s = { y: e.clientY, h: g.height }; });
  rz.addEventListener('pointermove', e => { if (!s) return; g.height = clamp(Math.round(s.h + e.clientY - s.y), 120, 1400); rz.classList.add('dragging'); requestDraw(); });
  const up = () => { rz.classList.remove('dragging'); if (s) { s = null; changed(); } };
  rz.addEventListener('pointerup', up); rz.addEventListener('pointercancel', up);
  rz.addEventListener('dblclick', () => { g.height = g.type === '3d' ? 420 : 230; requestDraw(); changed(); });
  rz.tabIndex = 0; rz.setAttribute('role', 'separator'); rz.setAttribute('aria-orientation', 'horizontal');
  rz.setAttribute('aria-label', 'Panel height. Drag, or use the up and down arrow keys.');
  rz.title = 'Drag to change the height · double-click for the default';
  rz.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault(); e.stopPropagation();
    g.height = clamp(g.height + (e.key === 'ArrowDown' ? 20 : -20) * (e.shiftKey ? 4 : 1), 120, 1400); requestDraw(); clearTimeout(rz._t); rz._t = setTimeout(changed, 400);
  });
}

/* ---------- tooltip ---------- */
function hideTip(g) { if (g._el) g._el.tip.hidden = true; }
function showTip(g, x, y) {
  const tip = g._el.tip, ix = st.ix;
  let head = '', sub = '';
  const rows = [], notes = [];
  if (g.type === 'spectrum') {
    if (g._fh === null || g._fh === undefined) { tip.hidden = true; return; }
    head = fmtFreq(g._fh); sub = g.spec.db ? 'dB' : 'amplitude';
    for (const a of g._plan) for (const f of a.fields) { const v = specAt(f, g._fh); rows.push([f, v === v ? (g.spec.db ? (20 * Math.log10(Math.max(v, 1e-12))).toFixed(1) + ' dB' : fmtNum(v, 4)) : '–']); }
  } else {
    const t = st.cursor; if (t === null) { tip.hidden = true; return; }
    head = fmtT(t, 2);
    const m = modeAt(t); sub = [m !== null ? DF.modeName(ix, m) : '', armedAt(t) ? 'ARMED' : ''].filter(Boolean).join(' · ');
    for (const a of g._plan) for (const f of a.fields) { const v = valueAt(f._r.series, t); rows.push([f, v === v ? fmtVal(f, v) : '–']); }
    const tol = 5 * (st.view.t1 - st.view.t0) / plotW(g);
    for (const e of ix.errs) if (Math.abs(e.t - t) <= tol && notes.length < 3) notes.push(`<div class="m" style="color:var(--crit)">${fmtT(e.t, 2)} ERR ${esc(DF.ERR_SUBSYS[e.sub] || 'subsystem ' + e.sub)}, code ${e.code}</div>`);
    if (st.textT) { let i = lb(st.textT, t - tol); for (; i < st.textT.length && st.textT[i] <= t + tol && notes.length < 5; i++) notes.push(`<div class="m">${fmtT(ix.texts[i].t, 2)} ${esc(ix.texts[i].text)}</div>`); }
  }
  tip.innerHTML = `<div class="t">${esc(head)}<span>${esc(sub)}</span></div>` + rows.map(([f, v]) => `<div class="r"><span><i style="background:${fieldColor(f)}"></i>${esc(fieldLabel(f))}</span><span>${esc(v)}</span></div>`).join('') + notes.join('');
  tip.hidden = false;
  const bw = g._w, tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = (x + 16 + tw > bw ? Math.max(0, x - tw - 16) : x + 16) + 'px';
  tip.style.top = clamp(y - th / 2, 0, Math.max(0, g._h - th)) + 'px';
}

/* ---------- overview strip ---------- */
(() => {
  const cv = $('overview');
  let od = null;
  const tipEl = h('div', 'g-tip'); tipEl.hidden = true; cv.parentElement.append(tipEl);
  cv.addEventListener('pointerdown', e => {
    if (!st.ix || !st.ovX) return;
    const { x } = xy(e, cv);
    cv.setPointerCapture(e.pointerId);
    const va = st.ovX(st.view.t0), vb = st.ovX(st.view.t1);
    pushHist();
    let kind = 'move';
    if (Math.abs(x - va) <= 6 && vb - va > 14) kind = 'l';
    else if (Math.abs(x - vb) <= 6 && vb - va > 14) kind = 'r';
    else if (x < va || x > vb) { const t = st.ovT(x), w = st.view.t1 - st.view.t0; setView(t - w / 2, t + w / 2); }
    od = { kind, x, v0: { t0: st.view.t0, t1: st.view.t1 } };
    cv.style.cursor = kind === 'move' ? 'grabbing' : 'ew-resize';
  });
  cv.addEventListener('pointermove', e => {
    const { x, y } = xy(e, cv);
    if (od) {
      const dt = st.ovT(x) - st.ovT(od.x);
      if (od.kind === 'move') setView(od.v0.t0 + dt, od.v0.t1 + dt);
      else if (od.kind === 'l') setView(Math.min(od.v0.t0 + dt, od.v0.t1 - 20e3), od.v0.t1);
      else setView(od.v0.t0, Math.max(od.v0.t1 + dt, od.v0.t0 + 20e3));
      return;
    }
    if (!st.ix || !st.ovX) return;
    const va = st.ovX(st.view.t0), vb = st.ovX(st.view.t1);
    cv.style.cursor = (Math.abs(x - va) <= 6 || Math.abs(x - vb) <= 6) ? 'ew-resize' : 'grab';
    if (x < M.L || x > cv.clientWidth - M.R) { tipEl.hidden = true; return; }
    const t = st.ovT(x), ix = st.ix, tol = 4 * (ix.tMax - ix.tMin) / (cv.clientWidth - M.L - M.R);
    const m = modeAt(t);
    const lines = [`<div class="t">${fmtT(t)}<span>${esc([m !== null ? DF.modeName(ix, m) : '', armedAt(t) ? 'ARMED' : ''].filter(Boolean).join(' · '))}</span></div>`];
    for (const er of ix.errs) if (Math.abs(er.t - t) <= tol && lines.length < 4) lines.push(`<div class="m" style="color:var(--crit)">ERR ${esc(DF.ERR_SUBSYS[er.sub] || er.sub)}, code ${er.code}</div>`);
    if (st.textT) { let i = lb(st.textT, t - tol); for (; i < st.textT.length && st.textT[i] <= t + tol && lines.length < 6; i++) lines.push(`<div class="m">${esc(ix.texts[i].text)}</div>`); }
    tipEl.innerHTML = lines.join('');
    tipEl.hidden = false;
    const tw = tipEl.offsetWidth;
    tipEl.style.left = (x + 14 + tw > cv.clientWidth ? Math.max(0, x - tw - 14) : x + 14) + 'px';
    tipEl.style.top = Math.max(0, y - 8) + 'px';
  });
  const up = () => { od = null; cv.style.cursor = 'grab'; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { tipEl.hidden = true; });
  cv.addEventListener('dblclick', zoomAll);
  cv.addEventListener('wheel', e => {
    if (!st.ix || !st.ovT) return;
    e.preventDefault();
    const { x } = xy(e, cv);
    const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horiz) { panBy(e.deltaX / 400); return; }
    zoomBy(Math.pow(1.0018, e.deltaY * (e.deltaMode === 1 ? 30 : 1)), clamp(st.ovT(x), st.view.t0, st.view.t1));
  }, { passive: false });
})();

/* ---------- keyboard ---------- */
document.addEventListener('keydown', e => {
  const tg = e.target, tag = (tg.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || tg.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && !e.altKey && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') {
    if (!$('menu').hidden) { closeMenu(); return; }
    if (!$('modal').hidden) { closeModal(); return; }
    if (!$('help').hidden) { closeHelp(); return; }
    if (typing) return;
    if (st.sel || st.pin !== null) { setSel(null); st.pin = null; requestDraw(); }
    return;
  }
  if (typing || mod || e.altKey) return;
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); panBy(e.shiftKey ? -0.05 : -0.2); break;
    case 'ArrowRight': e.preventDefault(); panBy(e.shiftKey ? 0.05 : 0.2); break;
    case 'ArrowUp': case '+': case '=': e.preventDefault(); pushHist(); zoomBy(0.5, st.cursor !== null ? st.cursor : st.pin !== null ? st.pin : undefined); break;
    case 'ArrowDown': case '-': e.preventDefault(); pushHist(); zoomBy(2, st.cursor !== null ? st.cursor : undefined); break;
    case '0': case 'Home': e.preventDefault(); zoomAll(); break;
    case 'Backspace': e.preventDefault(); zoomBack(); break;
    case '?': e.preventDefault(); openHelp(); break;
    case 'z': case 'Z': st.set.drag = 'zoom'; applyDragMode(); saveSettings(); break;
    case 's': case 'S': st.set.drag = 'select'; applyDragMode(); saveSettings(); break;
    case 'p': case 'P': st.set.drag = 'pan'; applyDragMode(); saveSettings(); break;
    case 'n': case 'N': e.preventDefault(); newEmptyGraph(); break;
    case ' ': e.preventDefault(); playToggle(); break;
    case '/': e.preventDefault(); $('sideSearch').focus(); break;
  }
});
function newEmptyGraph() {
  const idx = st.graphs.findIndex(g => g.id === st.active);
  const g = insertGraph(mkGraph({ title: 'Graph ' + (st.graphs.length + 1) }), idx < 0 ? undefined : idx + 1);
  renderGraphs(); changed();
  setTimeout(() => { if (g._el) { g._el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); g._el.addInp.focus(); } }, 30);
}

/* ---------- side panel ---------- */
let sideTab = 'fields';
const HIDE_TYPES = new Set(['FMT', 'FMTU', 'UNIT', 'MULT', 'PARM', 'MSG', 'FILE']);
function addFromList(expr, e) {
  if (e && e.shiftKey) addToNewGraph(expr);
  else { const g = activeGraph(); if (g) { addFieldTo(g, expr); if (g._el) g._el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } else addToNewGraph(expr); }
}
function dragFrom(el, expr) {
  el.draggable = true;
  el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', expr); e.dataTransfer.effectAllowed = 'copy'; });
}
function renderSide() {
  const list = $('sideList'), q = $('sideSearch').value.trim().toLowerCase();
  list.replaceChildren();
  $('sideSearch').placeholder = sideTab === 'fields' ? 'Search fields, e.g. baro alt' : sideTab === 'events' ? 'Search messages and errors' : 'Search parameters';
  $('sideHint').textContent = sideTab === 'events' ? 'Click to jump there.' : 'Click to add to the selected graph. Shift-click for a new graph. Drag onto any graph.';
  if (!st.ix) { list.append(h('div', 'side-empty', 'Open a log to browse it.')); return; }
  if (sideTab === 'fields') renderFieldList(list, q);
  else if (sideTab === 'events') renderEventList(list, q);
  else renderParamList(list, q);
}
function renderFieldList(list, q) {
  const terms = q.split(/\s+/).filter(Boolean);
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const ty of st.ix.types) {
    if (HIDE_TYPES.has(ty.name)) continue;
    const cols = ty.cols.filter(c => !terms.length || terms.every(t => (ty.name + '.' + c.col + ' ' + c.unit).toLowerCase().includes(t)));
    if (!cols.length) continue;
    shown++;
    const det = h('details', 'grp');
    if (terms.length) det.open = true;
    const sum = h('summary');
    sum.append(document.createTextNode(ty.name));
    sum.append(h('small', null, [ty.multi ? '×' + ty.insts.length : '', ty.count >= 20 && ty.hz >= 0.5 ? fmtHz(ty.hz) : '', compact(ty.count) + (ty.count >= 20 && ty.hz >= 0.5 ? '' : ty.count === 1 ? ' sample' : ' samples')].filter(Boolean).join(' · ')));
    det.append(sum);
    for (const c of cols) {
      const first = ty.multi ? `${ty.name}[${ty.insts[0]}].${c.col}` : `${ty.name}.${c.col}`;
      const row = h('div', 'fld');
      row.title = `Add ${first}`;
      row.append(document.createTextNode(c.col));
      if (c.unit) row.append(h('span', 'u', c.unit));
      if (ty.multi) {
        const ins = h('span', 'insts');
        for (const i of ty.insts) {
          const id = `${ty.name}[${i}].${c.col}`;
          const b = h('button', null, String(i)); b.type = 'button'; b.title = `Add ${id}`;
          b.onclick = e => { e.stopPropagation(); addFromList(id, e); };
          dragFrom(b, id);
          ins.append(b);
        }
        row.append(ins);
      }
      row.onclick = e => addFromList(first, e);
      dragFrom(row, first);
      det.append(row);
    }
    frag.append(det);
  }
  if (!shown) frag.append(h('div', 'side-empty', 'No field matches. Try part of a message or column name.'));
  list.append(frag);
}
function compact(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
function eventItems() {
  const ix = st.ix, out = [];
  for (const m of ix.texts) out.push({ t: m.t, cls: '', text: m.text });
  for (const e of ix.errs) out.push({ t: e.t, cls: 'err', text: `ERR ${DF.ERR_SUBSYS[e.sub] || 'subsystem ' + e.sub}: ${e.code === 0 ? 'cleared' : 'code ' + e.code}` });
  for (const m of ix.modes) out.push({ t: m.t, cls: 'mode', text: '→ ' + DF.modeName(ix, m.mode) });
  for (const a of ix.armed) { out.push({ t: a.t0, cls: 'arm', text: 'Armed' }); if (a.t1 < ix.tMax) out.push({ t: a.t1, cls: 'arm', text: 'Disarmed' }); }
  out.sort((a, b) => a.t - b.t);
  return out;
}
function renderEventList(list, q) {
  const items = eventItems().filter(it => !q || it.text.toLowerCase().includes(q));
  const frag = document.createDocumentFragment();
  for (const it of items.slice(0, 3000)) {
    const r = h('div', 'ev ' + it.cls); r.tabIndex = 0;
    r.append(h('span', 't', fmtT(it.t)), h('span', 'x', it.text));
    r.onclick = () => goTo(it.t);
    r.onkeydown = e => { if (e.key === 'Enter') goTo(it.t); };
    frag.append(r);
  }
  if (!items.length) frag.append(h('div', 'side-empty', q ? 'Nothing matches.' : 'This log has no messages.'));
  if (items.length > 3000) frag.append(h('div', 'side-empty', `Showing the first 3000 of ${items.length}. Search to narrow the list.`));
  list.append(frag);
}
function renderParamList(list, q) {
  const names = [...st.ix.params.keys()].filter(n => !q || n.toLowerCase().includes(q)).sort();
  const frag = document.createDocumentFragment();
  const chg = names.filter(n => st.ix.params.get(n).v.length > 1);
  const show = (n) => {
    const p = st.ix.params.get(n);
    const r = h('div', 'prm');
    r.append(h('span', 'n', n));
    if (p.v.length > 1) r.append(h('span', 'chg', `changed ×${p.v.length - 1}`));
    r.append(h('span', 'v', fmtNum(p.v[p.v.length - 1])));
    r.title = p.v.map((v, i) => `${fmtT(p.t[i])}  ${fmtNum(v)}`).join('\n') + '\nClick to plot PARM.' + n;
    r.onclick = e => addFromList('PARM.' + n, e);
    dragFrom(r, 'PARM.' + n);
    frag.append(r);
  };
  if (chg.length && !q) { frag.append(h('div', 'mhead side-empty', `Changed during the log (${chg.length})`)); chg.forEach(show); frag.append(h('div', 'mhead side-empty', 'All parameters')); }
  names.forEach(show);
  if (!names.length) frag.append(h('div', 'side-empty', q ? 'No parameter matches.' : 'This log has no parameters.'));
  list.append(frag);
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => {
  sideTab = b.dataset.tab;
  for (const o of document.querySelectorAll('.tabs button')) o.setAttribute('aria-selected', String(o === b));
  $('sideSearch').value = '';
  renderSide();
});
{ let t = 0; $('sideSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderSide, 120); }); }

/* ---------- help drawer ---------- */
function buildHelp() {
  const body = $('helpBody'), nav = $('helpNav');
  body.replaceChildren(); nav.replaceChildren();
  const intro = h('section', 'hcat'); intro.id = 'h-start';
  intro.innerHTML = `<h3>Writing a formula</h3><p>Click a field's formula to edit it, or type in the box under a graph. Suggestions appear as you type: <span class="kbd">↑</span> <span class="kbd">↓</span> to choose, <span class="kbd">Tab</span> or <span class="kbd">Enter</span> to accept. Inside a function the line under the box shows which argument you are on. <span class="kbd">Enter</span> applies the formula and <span class="kbd">Esc</span> cancels. The <b>ƒx</b> button next to a field wraps it in a filter, a rate or an integral in one click. Every <b>Add</b> button below puts the example into the selected graph.</p>`;
  body.append(intro);
  const navBtn = (id, label) => { const b = h('button', null, label); b.type = 'button'; b.onclick = () => { const el = document.getElementById(id); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }; nav.append(b); };
  navBtn('h-start', 'Start');
  for (const c of EX.CATS) {
    const sec = h('section', 'hcat'); sec.id = 'h-' + c.id; sec.dataset.cat = c.id;
    sec.append(h('h3', null, c.title));
    if (c.intro) sec.append(h('p', null, c.intro));
    for (const it of c.items) {
      const item = h('div', 'hitem');
      item.dataset.search = (it.sig + ' ' + (it.names || []).join(' ') + ' ' + it.desc + ' ' + c.title).toLowerCase();
      const sg = h('div', 'sig2', it.sig);
      if (it.names && it.names.length > 1) sg.append(h('span', 'alias', 'also ' + it.names.slice(1).join(', ')));
      item.append(sg, h('p', null, it.desc));
      for (const ex of it.ex || []) {
        const row = h('div', 'hex');
        const code = h('code'); code.innerHTML = hl(ex);
        const add = h('button', 'btn small', 'Add'); add.type = 'button'; add.title = 'Add to the selected graph';
        add.onclick = () => {
          const g = activeGraph();
          if (!st.ix) { toast('Open a log first.'); return; }
          addFieldTo(g, ex);
          toast(`Added ${ex} to “${(activeGraph() || {}).title || 'a new graph'}”.`);
        };
        const cp = h('button', 'btn small ghost', 'Copy'); cp.type = 'button';
        cp.onclick = () => copyText(ex, 'Copied');
        row.append(code, add, cp);
        item.append(row);
      }
      sec.append(item);
    }
    body.append(sec);
    navBtn('h-' + c.id, c.title.replace(/ and .*| \(.*/, '').replace('How fields with different timestamps combine', 'Timing'));
  }
  const keys = h('section', 'hcat'); keys.id = 'h-keys';
  keys.innerHTML = `<h3>Graphs, mouse and keyboard</h3>
  <p>All time graphs share one time axis. Each field can have its own Y axis: pick it in the Axis column, and fields on the same axis share a scale. New fields join an axis that already shows the same unit over a similar range. Hover a field row to pick its line out in the graph.</p>
  <div class="hkeys">
    <span>Drag on a graph</span><span>Zoom into that time range (or select, or pan, as set by <b>Drag to</b>)</span>
    <span><span class="kbd">Shift</span> + drag</span><span>Select a time range. Statistics and spectra use the selection.</span>
    <span><span class="kbd">Alt</span> + drag</span><span>Pan along the log</span>
    <span>Click</span><span>Pin a cursor line so values stay readable. Click it again to remove it.</span>
    <span><span class="kbd">Ctrl</span> + scroll</span><span>Zoom around the pointer. Pinch on a trackpad does the same.</span>
    <span>Scroll on a Y axis</span><span>Zoom that axis. Drag the axis to move it, double-click it to fit it again.</span>
    <span>Double-click a graph</span><span>Show the whole log (on a spectrum: all frequencies)</span>
    <span>Whole-log strip</span><span>Drag the frame to move, drag its edges to resize, scroll to zoom</span>
    <span>Drag a colour square</span><span>Move that field to another graph</span>
    <span><span class="kbd">←</span> <span class="kbd">→</span></span><span>Move along the log (<span class="kbd">Shift</span> for small steps)</span>
    <span><span class="kbd">↑</span> <span class="kbd">↓</span> <span class="kbd">+</span> <span class="kbd">−</span></span><span>Zoom in and out</span>
    <span><span class="kbd">0</span></span><span>Whole log</span>
    <span><span class="kbd">Backspace</span></span><span>Previous zoom</span>
    <span><span class="kbd">Z</span> <span class="kbd">S</span> <span class="kbd">P</span></span><span>Drag to zoom, select or pan</span>
    <span>Pin button</span><span>Pins a graph, the 3D view or the timeline to the top of the screen, so it stays in sight while you scroll. Pinned panels stack in the order you pinned them; the arrows on a pinned panel change that order. A pinned graph shows a one-line legend; the list button shows its fields again.</span>
    <span>Bar under a graph</span><span>Drag it to change the height, or focus it and use the up and down arrow keys. Double-click for the default height.</span>
    <span><span class="kbd">N</span></span><span>New graph</span>
    <span><span class="kbd">Space</span></span><span>Play or pause along the visible time range</span>
    <span><span class="kbd">/</span></span><span>Search the field list</span>
    <span><span class="kbd">Esc</span></span><span>Clear the selection and the pinned cursor</span>
    <span><span class="kbd">Ctrl</span> + <span class="kbd">Z</span></span><span>Undo a change to the graphs. <span class="kbd">Ctrl</span> + <span class="kbd">Shift</span> + <span class="kbd">Z</span> redoes it.</span>
  </div>
  <p>Spectrum graphs show the frequency content of each field over the selection, or over the visible range when nothing is selected. The strongest peak is marked and listed next to each field. Use them on IMU data to find motor noise before setting up a notch filter.</p>`;
  body.append(keys);
  navBtn('h-keys', 'Mouse & keys');
  const v3 = h('section', 'hcat'); v3.id = 'h-3d';
  v3.innerHTML = `<h3>3D view</h3>
  <p>Add it with <b>Add 3D view</b> under the graphs. It shows the flight paths on a map, with the vehicle at the cursor time: hover a graph, click to pin a time, or press <span class="kbd">Space</span> to play along the visible time range at the speed set next to Play. Click a path in 3D to jump the cursor there.</p>
  <div class="hkeys">
    <span>Paths</span><span>Every message with latitude and longitude can be drawn: POS, GPS and its instances, AHR2 and more. Pick which one carries the vehicle. Colour by source or by flight mode, and show the whole log or only the time range shown in the graphs.</span>
    <span>Attitude</span><span>ATT, AHR2 and any message with Roll, Pitch and Yaw, or the quaternions of each EKF core (XKQ[0], XKQ[1], …). Without one, the heading follows the path.</span>
    <span>Model</span><span>A built-in plane or quadcopter, or your own .glb, .gltf (with everything embedded), .obj or .stl file. Your file is kept in this browser. Use Turn if its nose does not point forward, and Size for its real length in metres.</span>
    <span>Map</span><span>Satellite imagery, OpenStreetMap, OpenTopoMap, CARTO, or any XYZ server: a link with {z}, {x} and {y}, plus {-y} for TMS rows, {s} for a/b/c servers and {q} for a Bing quadkey.</span>
    <span>Terrain</span><span>A quantized-mesh terrain server: give the link to its layer.json. Gzipped tiles and vertex normals are supported, in EPSG:4326 with TMS or XYZ rows. Tick “above sea level” if the heights in the tiles are not ellipsoidal.</span>
    <span>Path offsets</span><span>Each path has its own height offset in metres, for example to line GPS altitude up with POS. The ≡ button sets it to match the vehicle path just after takeoff.</span>
    <span>Water</span><span>A see-through layer whose surface is at sea level plus the height you set, reaching down by the depth you choose (10 m to start). Pick its colour, how see-through it is from above and from inside, and whether the surface shows moving white waves. When the camera is inside it, the view takes on the water colour.</span>
    <span>Stretch</span><span>With terrain on, Stretch heights multiplies terrain height differences around the takeoff height, so hills look taller. Tick Paths and vehicle, or Water, to stretch them the same way.</span>
    <span>Failed tiles</span><span>Tiles that fail to load are tried again after 2, 4 and 8 seconds, then every 15 seconds. Retry now in the message at the bottom of the view tries at once.</span>
    <span>Heights</span><span>ArduPilot logs altitude above mean sea level. With “add geoid height” on, the EGM96 geoid (built in) converts it to the ellipsoid that map tiles and most terrain use. The ground can be the geoid, the WGS84 ellipsoid or a sphere. Shift paths with the Z offset, or press <b>Put takeoff on the ground</b>.</span>
    <span>Camera</span><span>Follow behind turns with the vehicle; follow north up keeps north up; free stays where you leave it. Drag to turn, all the way below the vehicle to look up at it. Scroll or pinch to zoom. To move: right-drag, middle-drag or Shift-drag, or click the view and use W A S D (or the arrow keys) to fly, Q and E to go down and up, Shift to go faster. Moving switches to the free camera. Double-click or Reset view goes back to the vehicle.</span>
  </div>
  <p>Map and terrain servers must allow cross-origin requests (CORS). They need a connection, so offline the 3D view shows the paths and vehicle over a plain ground.</p>`;
  body.append(v3);
  navBtn('h-3d', '3D view');
}
function filterHelp() {
  const q = $('helpSearch').value.trim().toLowerCase(), terms = q.split(/\s+/).filter(Boolean);
  for (const sec of $('helpBody').querySelectorAll('.hcat')) {
    if (!sec.dataset.cat) { sec.hidden = !!terms.length; continue; }
    let any = false;
    for (const it of sec.querySelectorAll('.hitem')) { const show = terms.every(t => it.dataset.search.includes(t)); it.hidden = !show; any = any || show; }
    sec.hidden = !any;
  }
}
function openHelp() { $('help').hidden = false; $('scrim').hidden = false; setTimeout(() => $('helpSearch').focus(), 20); }
function closeHelp() { $('help').hidden = true; $('scrim').hidden = true; }
$('helpBtn').onclick = openHelp;
$('helpClose').onclick = closeHelp;
$('scrim').onclick = () => { closeHelp(); closeModal(); };
$('helpSearch').addEventListener('input', filterHelp);

/* ---------- menus, modal, toast ---------- */
let menuAnchor = null;
function openMenu(anchor, items) {
  const m = $('menu');
  m.replaceChildren();
  for (const it of items) {
    if (it.sep) { m.append(h('div', 'msep')); continue; }
    if (it.head) { m.append(h('div', 'mhead', it.head)); continue; }
    if (it.el) { m.append(it.el); continue; }
    const b = h('button', 'mi' + (it.danger ? ' danger' : ''));
    b.type = 'button'; b.setAttribute('role', 'menuitem');
    if (it.check !== undefined) b.append(h('span', 'ck', it.check ? '✓' : ''));
    b.append(document.createTextNode(it.label));
    if (it.hint) b.append(h('small', null, it.hint));
    b.disabled = !!it.disabled;
    b.onclick = () => { closeMenu(); if (it.action) it.action(); };
    if (it.del) {
      const row = h('div', 'mrow');
      const d = h('button', 'icon-btn'); d.type = 'button'; d.innerHTML = ICON.close; d.title = 'Delete'; d.setAttribute('aria-label', 'Delete ' + it.label);
      d.onclick = () => { closeMenu(); it.del(); };
      row.append(b, d); m.append(row);
    } else m.append(b);
  }
  m.hidden = false;
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = clamp(r.left, 8, window.innerWidth - mw - 8) + 'px';
  m.style.top = (r.bottom + mh + 8 > window.innerHeight && r.top > mh + 8 ? r.top - mh - 4 : r.bottom + 4) + 'px';
  menuAnchor = anchor;
  if (anchor instanceof Node) { const first = m.querySelector('button:not(:disabled)'); if (first) first.focus({ preventScroll: true }); }
}
function closeMenu() { if ($('menu').hidden) return; $('menu').hidden = true; if (menuAnchor instanceof Node && document.body.contains(menuAnchor)) menuAnchor.focus({ preventScroll: true }); menuAnchor = null; }
document.addEventListener('pointerdown', e => {
  const m = $('menu');
  if (!m.hidden && !m.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu();
}, true);
$('menu').addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const bs = [...$('menu').querySelectorAll('button.mi:not(:disabled)')], i = bs.indexOf(document.activeElement);
  const n = bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]; if (n) n.focus();
});
function openModal(title, bodyEl, actions) {
  const m = $('modal'); m.replaceChildren();
  const hd = h('h2', null, title); hd.id = 'modalTitle';
  const acts = h('div', 'acts');
  for (const a of actions) { const b = h('button', 'btn' + (a.primary ? ' primary' : ''), a.label); b.type = 'button'; b.onclick = () => { if (a.action() !== false) closeModal(); }; acts.append(b); }
  m.append(hd, bodyEl, acts);
  m.hidden = false; $('scrim').hidden = false;
  const f = m.querySelector('input, textarea'); if (f) setTimeout(() => f.focus(), 20);
}
function closeModal() { $('modal').hidden = true; if ($('help').hidden) $('scrim').hidden = true; }
let toastT = 0;
function toast(msg, action) {
  const t = $('toast'); t.replaceChildren(h('span', null, msg));
  if (action) { const b = h('button', null, action.label); b.type = 'button'; b.onclick = () => { t.hidden = true; action.fn(); }; t.append(b); }
  t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, action ? 7000 : 3500);
}
function copyText(text, msg) {
  const fallback = () => {
    const ta = h('textarea', 'inp'); ta.value = text; ta.id = 'copyBox'; ta.readOnly = true;
    openModal('Copy this text', ta, [{ label: 'Done', primary: true, action: () => {} }]);
    setTimeout(() => { ta.focus(); ta.select(); }, 30);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(msg || 'Copied'), fallback);
    else fallback();
  } catch (_) { fallback(); }
}

/* ---------- header menus ---------- */
$('layoutBtn').onclick = () => {
  const saved = store.get(LS_SAVED) || {};
  const names = Object.keys(saved).sort();
  const items = [
    { label: 'Suggested graphs for this log', disabled: !st.ix, action: () => { st.graphs = suggestedGraphs().map(mkGraph); st.active = st.graphs[0] ? st.graphs[0].id : null; evalAll(); renderGraphs(); changed(); toast('Replaced the graphs with suggestions for this log.', { label: 'Undo', fn: undo }); } },
    { label: 'Demo layout', action: () => { st.graphs = DEMO_LAYOUT.map(mkGraph); st.active = st.graphs[0].id; evalAll(); renderGraphs(); changed(); toast('Loaded the demo layout.', { label: 'Undo', fn: undo }); } },
    { sep: true },
    { label: 'Save this layout…', action: saveLayoutModal }
  ];
  if (names.length) {
    items.push({ head: 'Saved layouts' });
    for (const n of names) items.push({ label: n, hint: `${saved[n].length} graph${saved[n].length === 1 ? '' : 's'}`, action: () => { st.graphs = saved[n].map(mkGraph); st.active = st.graphs[0] ? st.graphs[0].id : null; evalAll(); renderGraphs(); changed(); toast(`Loaded “${n}”.`, { label: 'Undo', fn: undo }); }, del: () => { delete saved[n]; store.set(LS_SAVED, saved); toast(`Deleted “${n}”.`); } });
  }
  items.push({ sep: true },
    { label: 'Copy layout as text', action: () => copyText(JSON.stringify({ dfplotLayout: 1, graphs: JSON.parse(serialize()) }, null, 1), 'Layout copied. Paste it into Load layout from text on any computer.') },
    { label: 'Load layout from text…', action: pasteLayoutModal },
    { sep: true },
    { label: 'Remove all graphs', danger: true, disabled: !st.graphs.length, action: () => { st.graphs = []; st.active = null; evalAll(); renderGraphs(); changed(); toast('Removed all graphs.', { label: 'Undo', fn: undo }); } });
  openMenu($('layoutBtn'), items);
};
function saveLayoutModal() {
  const wrap = h('div');
  const inp = h('input', 'inp'); inp.id = 'layoutName'; inp.placeholder = 'Name, e.g. Tuning review'; inp.style.width = '100%';
  inp.value = st.ix && !st.demo ? baseName() : '';
  wrap.append(inp, h('p', 'note', 'Layouts are kept in this browser. Use Copy layout as text to move one to another computer.'));
  const save = () => {
    const n = inp.value.trim(); if (!n) { inp.focus(); return false; }
    const saved = store.get(LS_SAVED) || {}; saved[n] = JSON.parse(serialize()); store.set(LS_SAVED, saved);
    toast(`Saved layout “${n}”.`); return true;
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { if (save()) closeModal(); } });
  openModal('Save this layout', wrap, [{ label: 'Cancel', action: () => {} }, { label: 'Save', primary: true, action: save }]);
}
function pasteLayoutModal() {
  const wrap = h('div');
  const ta = h('textarea', 'inp'); ta.id = 'layoutText'; ta.placeholder = 'Paste layout text here';
  const err = h('p', 'f-err');
  wrap.append(ta, err);
  openModal('Load layout from text', wrap, [{ label: 'Cancel', action: () => {} }, { label: 'Load', primary: true, action: () => {
    try {
      const o = JSON.parse(ta.value);
      const graphs = Array.isArray(o) ? o : o.graphs;
      if (!Array.isArray(graphs)) throw new Error('no graphs');
      st.graphs = graphs.map(mkGraph); st.active = st.graphs[0] ? st.graphs[0].id : null;
      evalAll(); renderGraphs(); changed(); toast('Loaded the layout.', { label: 'Undo', fn: undo });
      return true;
    } catch (e) { err.textContent = 'This is not layout text. Copy it again with Copy layout as text.'; return false; }
  } }]);
}
$('viewBtn').onclick = () => {
  const tog = (key, label) => ({ label, check: !!st.set[key], action: () => { st.set[key] = !st.set[key]; saveSettings(); requestDraw(true); } });
  openMenu($('viewBtn'), [
    tog('armed', 'Shade armed time'),
    tog('modes', 'Lines at mode changes'),
    tog('errs', 'Lines at errors (ERR)'),
    { sep: true },
    tog('wheel', 'Scroll wheel zooms graphs')
  ]);
};
$('tplBtn').onclick = () => {
  const av = tplAvailable();
  const items0 = st.ix && v3Sources().pos.length ? [{ label: '3D flight view', hint: 'map, path, vehicle', action: add3dView }, { sep: true }] : [];
  const items = av.length ? av.map(t => { const n = tplResolve(t).length; return { label: t.title, hint: t.type === 'spectrum' ? 'spectrum' : n + (n === 1 ? ' field' : ' fields'), action: () => addTemplate(t) }; }) : [{ label: 'Open a log to see templates', disabled: true }];
  if (av.length && av.length < TEMPLATES.length) items.push({ sep: true }, { head: 'Not in this log: ' + TEMPLATES.filter(t => !av.includes(t)).map(t => t.title).join(', ') });
  openMenu($('tplBtn'), items0.concat(items));
};
$('addGraph').onclick = newEmptyGraph;
{
  const z = $('addZone');
  z.addEventListener('dragover', e => { if (dragKind(e)) { e.preventDefault(); z.classList.add('drop'); } });
  z.addEventListener('dragleave', () => z.classList.remove('drop'));
  z.addEventListener('drop', e => {
    z.classList.remove('drop');
    const k = dragKind(e); if (!k) return;
    e.preventDefault(); e.stopPropagation();
    if (k === 'move') {
      const [gid, fid] = e.dataTransfer.getData('application/x-dfplot-field').split(':').map(Number);
      const g = st.graphs.find(x => x.id === gid), f = g && g.fields.find(x => x.id === fid);
      if (!f) return;
      g.fields = g.fields.filter(x => x !== f); normalizeAxes(g);
      const ng = insertGraph(mkGraph({ title: titleFor(f.expr) })); f.axis = 1; ng.fields.push(f);
      evalAll(); renderGraphs(); changed();
    } else { const v = e.dataTransfer.getData('text/plain').trim(); if (v) addToNewGraph(v); }
  });
}
for (const b of $('dragSeg').children) b.onclick = () => { st.set.drag = b.dataset.m; applyDragMode(); saveSettings(); };
$('zBack').onclick = zoomBack;
$('tlPin').onclick = toggleTimelinePin;
$('zAll').onclick = zoomAll;
$('selZoom').onclick = zoomSel;
$('selClear').onclick = () => setSel(null);
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;

/* ---------- export ---------- */
let DL = null;
const inViewer = !!(window.claude && typeof window.claude.use === 'function');
if (inViewer) window.claude.use('downloads').then(d => { DL = d; }, () => { DL = null; });
const canSave = () => !inViewer || !!DL;
const MIME = { csv: ['text/csv', 'CSV table'], png: ['image/png', 'PNG image'] };
/** Save a file. produce() makes the data (string, Blob or a promise of one) after the save target is chosen. */
async function saveFile(name, produce) {
  const ext = name.split('.').pop().toLowerCase(), [mime, desc] = MIME[ext] || ['application/octet-stream', 'File'];
  const make = async () => { const d = await produce(); return d === null || d === undefined ? null : d; };
  if (DL) {
    const data = await make(); if (data === null) return;
    try { await DL.save({ filename: name, data }); toast('Saved ' + name); }
    catch (e) {
      const code = e && e.code;
      if (code === 'declined') return;
      if (code === 'rate_limited') { toast('A save is already waiting for your answer.'); return; }
      if (code === 'too_large') { toast('That file is too large to save here. Select a shorter range.'); return; }
      toast('Saving files is not available here.');
    }
    return;
  }
  if (inViewer) { toast('Saving files is not available here.'); return; }
  if (typeof window.showSaveFilePicker === 'function') {
    let handle = null;
    try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc, accept: { [mime]: ['.' + ext] } }] }); }
    catch (e) { if (e && e.name === 'AbortError') return; handle = null; }
    if (handle) {
      try {
        const data = await make(); if (data === null) return;
        const w = await handle.createWritable(); await w.write(data); await w.close();
        toast('Saved ' + handle.name); return;
      } catch (e) { console.warn('Save dialog failed, downloading instead', e); }
    }
  }
  const data = await make(); if (data === null) return;
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  toast('Downloading ' + name);
}
function exportFields() {
  const seen = new Set(), out = [];
  for (const g of st.graphs) if (g.type === 'time') for (const f of g.fields) if (f.visible && ok(f) && !seen.has(f._r.key)) { seen.add(f._r.key); out.push(f); }
  return out;
}
function buildCSV(range, maxRows) {
  const fields = exportFields();
  if (!fields.length) return null;
  let base = null, bestN = -1;
  for (const f of fields) {
    const s = f._r.series; if (s.konst) continue;
    const n = ub(s.t, range.t1) - lb(s.t, range.t0);
    if (n > bestN) { bestN = n; base = s; }
  }
  let T;
  if (!base || bestN <= 0) T = Float64Array.of(range.t0, range.t1);
  else {
    const a = lb(base.t, range.t0), b = ub(base.t, range.t1), n = b - a, k = Math.max(1, Math.ceil(n / maxRows));
    T = new Float64Array(Math.ceil(n / k)); for (let i = 0, j = a; j < b; i++, j += k) T[i] = base.t[j];
  }
  const cols = fields.map(f => EX.resampleTo(f._r.series, T));
  const digits = fields.map(f => f._r.series.v instanceof Float32Array ? 7 : 10);
  const qq = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const lines = ['time_s,' + fields.map(f => qq(fieldLabel(f) + (f._r.unit ? ` [${f._r.unit}]` : ''))).join(',')];
  for (let i = 0; i < T.length; i++) {
    let row = (T[i] / 1e6).toFixed(6);
    for (let j = 0; j < cols.length; j++) { const v = cols[j][i]; row += ',' + (v === v && isFinite(v) ? +v.toPrecision(digits[j]) : ''); }
    lines.push(row);
  }
  return { text: lines.join('\n') + '\n', rows: T.length, fields: fields.length, thinned: base && bestN > maxRows };
}
function exportCSV(useSel, toClipboard) {
  if (!st.ix) return;
  const r = useSel && st.sel ? st.sel : st.view;
  if (!exportFields().length) { toast('Nothing to export yet. Add fields to a time graph first.'); return; }
  const thinNote = csv => csv.thinned ? ` Thinned to ${csv.rows.toLocaleString()} rows; select a shorter range for every sample.` : '';
  if (toClipboard) { const csv = buildCSV(r, 20000); copyText(csv.text, `Copied ${csv.rows.toLocaleString()} rows × ${csv.fields} fields.` + thinNote(csv)); return; }
  let note = '';
  saveFile(`${slug(baseName())}_${fmtTFile(r.t0)}-${fmtTFile(r.t1)}.csv`, () => { const csv = buildCSV(r, 500000); note = thinNote(csv).trim(); return csv.text; })
    .then(() => { if (note) setTimeout(() => toast(note), 3600); });
}
function exportPNG() {
  for (const g of st.graphs) if (g.type === '3d' && V3.g === g) { g._w = V3.w; g._h = V3.h; }
  const gs = visualGraphs().filter(g => g._el && g._w);
  if (!gs.length) { toast('There are no graphs to save.'); return; }
  saveFile(`${slug(baseName())}_${fmtTFile(st.view.t0)}-${fmtTFile(st.view.t1)}.png`, () => graphsImage(gs));
}
function graphsImage(gs) {
  const W = gs[0]._w, dpr = st.dpr, c = st.colors;
  const legendH = g => 18 * Math.max(1, Math.ceil(g.fields.filter(f => f.visible && ok(f)).length / Math.max(1, Math.floor(W / 230))));
  let H = 34;
  for (const g of gs) H += 26 + g._h + legendH(g) + 10;
  const cv = document.createElement('canvas'); cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = c.surface; ctx.fillRect(0, 0, W, H);
  text(ctx, `${st.ix ? st.ix.name : ''}   ${fmtT(st.view.t0)} – ${fmtT(st.view.t1)}`, 10, 17, c.muted, 'left', 'middle', `12px ${st.fonts.mono}`);
  let y = 34;
  for (const g of gs) {
    text(ctx, g.title, 10, y + 13, c.ink, 'left', 'middle', `600 14px ${st.fonts.cond}`);
    y += 26;
    if (g.type === '3d') { const im = V3.g === g ? V3.imageOf() : null; if (im) ctx.drawImage(im, 0, y, g._w, g._h); y += g._h + 10; continue; }
    ctx.drawImage(g._el.base, 0, y, g._w, g._h);
    ctx.drawImage(g._el.over, 0, y, g._w, g._h);
    y += g._h + 4;
    const per = Math.max(1, Math.floor(W / 230));
    g.fields.filter(f => f.visible && ok(f)).forEach((f, i) => {
      const lx = 10 + (i % per) * 230, ly = y + 9 + Math.floor(i / per) * 18;
      ctx.fillStyle = fieldColor(f); ctx.fillRect(lx, ly - 2, 14, 3);
      let lab = fieldLabel(f) + (f._r.unit ? ` (${f._r.unit})` : '') + `  Y${f.axis}`;
      ctx.font = `11px ${st.fonts.mono}`;
      while (lab.length > 4 && ctx.measureText(lab).width > 205) lab = lab.slice(0, -2) + '…';
      text(ctx, lab, lx + 20, ly, c.ink, 'left', 'middle', `11px ${st.fonts.mono}`);
    });
    y += legendH(g) + 6;
  }
  return new Promise(res => cv.toBlob(b => { if (!b) toast('Could not make the image.'); res(b || null); }, 'image/png'));
}
$('exportBtn').onclick = () => {
  const off = !canSave();
  openMenu($('exportBtn'), [
    { label: 'Image of the graphs (.png)', disabled: off || !st.graphs.length, action: exportPNG },
    { label: 'Data in view (.csv)', hint: 'time graphs', disabled: off || !st.ix, action: () => exportCSV(false) },
    { label: 'Selected data (.csv)', disabled: off || !st.sel, action: () => exportCSV(true) },
    { sep: true },
    { label: 'Copy data in view as CSV', hint: 'up to 20k rows', disabled: !st.ix, action: () => exportCSV(!!st.sel, true) }
  ].concat(off ? [{ head: 'Saving files is not available here' }] : []));
};

/* ---------- opening logs ---------- */
function keepHz(size) {
  const v = st.set.detail;
  if (v === 'auto') return size > 400e6 ? 100 : 0;
  return Number(v) || 0;
}
async function openFile(file, isDemo) {
  if (st.scanning) return;
  st.scanning = true; st.cancel = false;
  const box = $('scanBox'); box.hidden = false;
  $('scanTitle').textContent = isDemo ? 'Building the demo log…' : `Reading ${file.name}…`;
  $('scanBar').style.width = '0%'; $('scanText').textContent = '';
  // let the page paint before the heavy work starts, so it never looks blank
  await new Promise(r => { let done = false; const go = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 250); });
  const t0 = performance.now();
  try {
    if (isDemo && typeof file === 'function') file = file();
    const maxHz = keepHz(file.size);
    const ix = await DF.scan(file, {
      maxHz, isCancelled: () => st.cancel,
      onProgress: (fr, x) => {
        $('scanBar').style.width = (fr * 100).toFixed(1) + '%';
        const el = (performance.now() - t0) / 1000, done = fr * file.size;
        $('scanText').textContent = `${fmtBytes(done)} of ${fmtBytes(file.size)}${el > 0.3 ? ' · ' + fmtBytes(done / el) + '/s' : ''} · ${Math.round(x.samples).toLocaleString()} samples`;
      }
    });
    playToggle(false);
    st.ix = ix; st.file = isDemo ? null : file; st.demo = !!isDemo;
    EX.setLog(ix);
    st.textT = Float64Array.from(ix.texts.map(m => m.t));
    st.view = { t0: ix.tMin, t1: Math.max(ix.tMax, ix.tMin + 1e6) }; st.viewAt = 0;
    st.sel = null; st.pin = null; st.cursor = null; st.hist = [];
    evalAll();
    const anyOk = st.graphs.some(g => g.fields.some(ok));
    if (!anyOk && !isDemo) {
      const sug = suggestedGraphs();
      if (sug.length) {
        st.graphs = sug.map(mkGraph); st.active = st.graphs[0].id; evalAll();
        changed();
        if (JSON.parse(st.undo[st.undo.length - 1] || '[]').length) toast('Your graphs did not match this log, so suggested graphs were set up.', { label: 'Undo', fn: undo });
      }
    }
    renderSummary(); renderSide(); renderGraphs();
    const chip = $('fileChip'); chip.replaceChildren(document.createTextNode(ix.name));
    if (isDemo) chip.append(h('b', null, 'DEMO'));
    chip.title = ix.name;
    if (!isDemo) toast(`Read ${fmtBytes(ix.size)} in ${ix.seconds.toFixed(1)} s.`);
  } catch (e) {
    if (e.message === 'cancelled') toast('Stopped reading the log.');
    else { console.error(e); toast('Could not read this file: ' + e.message); }
  } finally { st.scanning = false; box.hidden = true; }
}
function renderSummary() {
  const ix = st.ix, el = $('summary');
  el.replaceChildren();
  if (!ix) return;
  const item = (k, v) => { const s = h('span'); s.append(document.createTextNode(k + ' '), h('b', null, v)); el.append(s); };
  item('Size', fmtBytes(ix.size));
  item('Length', fmtDur(ix.tMax - ix.tMin));
  item('Messages', Math.round(ix.nMsgs).toLocaleString());
  item('Kept', `${compact(ix.samples)} samples, ${ix.maxHz ? 'up to ' + ix.maxHz + ' Hz' : 'every sample'}`);
  item('Flights', String(ix.armed.length));
  if (ix.errs.length) item('Errors', String(ix.errs.filter(e => e.code !== 0).length));
  if (ix.bad) item('Skipped bytes', ix.bad.toLocaleString());
  item('Firmware', (ix.firmware || 'not found') + (ix.frame ? ' · ' + ix.frame : ''));
}
$('fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) openFile(f, false); e.target.value = ''; });
$('openBtn').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
$('scanCancel').onclick = () => { st.cancel = true; };
$('detailSel').value = st.set.detail;
$('detailSel').addEventListener('change', () => {
  st.set.detail = $('detailSel').value; saveSettings();
  if (st.file) openFile(st.file, false);
  else if (st.demo) toast('This applies to the next log you open.');
});
{
  let depth = 0;
  const isFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (isFiles(e)) { depth++; $('dropzone').hidden = false; e.preventDefault(); } });
  window.addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (isFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) $('dropzone').hidden = true; } });
  window.addEventListener('drop', e => {
    if (!isFiles(e)) return;
    e.preventDefault(); depth = 0; $('dropzone').hidden = true;
    const f = e.dataTransfer.files[0]; if (f) openFile(f, false);
  });
}

