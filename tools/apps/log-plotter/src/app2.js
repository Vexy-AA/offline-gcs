/* ================= graph cards, field rows, formula editing ================= */
function renderGraphs() {
  const list = $('graphList'), stack = $('pinStack'), tl = $('tl');
  for (const g of st.graphs) g._el = null;
  list.replaceChildren(); stack.replaceChildren();
  const build = g => g.type === '3d' ? buildGraph3d(g) : buildGraph(g);
  const pins = pinnedItems();
  for (const it of pins) stack.append(it.g === 'tl' ? tl : build(it.g));
  if (!st.set.tlPin) list.parentNode.insertBefore(tl, list);
  stack.hidden = !pins.length;
  updateTimelinePin();
  if (!st.graphs.length) list.append(emptyCard());
  for (const g of st.graphs) if (!g.pin) list.append(build(g));
  if (st.graphs.length && !st.graphs.some(g => g.id === st.active)) st.active = st.graphs[0].id;
  for (const g of st.graphs) g._el.root.classList.toggle('active', g.id === st.active);
  sync3d();
  requestDraw(true);
}
function emptyCard() {
  const c = h('section', 'empty-card');
  c.append(h('h2', null, 'No graphs yet'));
  c.append(h('p', 'note', 'Add an empty graph and type a formula, click a field in the list, or start from one of these:'));
  const grid = h('div', 'tplgrid');
  for (const t of tplAvailable()) { const b = h('button', 'btn small', t.title); b.type = 'button'; b.onclick = () => addTemplate(t); grid.append(b); }
  if (!grid.children.length) grid.append(h('span', 'note', 'Open a log to see templates that fit it.'));
  c.append(grid);
  return c;
}
function iconBtn(svg, label, fn) {
  const b = h('button', 'icon-btn'); b.type = 'button'; b.innerHTML = svg; b.title = label; b.setAttribute('aria-label', label);
  b.onclick = e => { e.stopPropagation(); fn(e); };
  return b;
}
function buildGraph(g) {
  const root = h('section', 'graph');
  root.dataset.id = g.id;
  const head = h('div', 'g-head');
  const title = h('input', 'g-title');
  title.id = `g${g.id}-title`; title.value = g.title; title.spellcheck = false; title.setAttribute('aria-label', 'Graph title');
  const fitTitle = () => { title.style.width = Math.min(48, Math.max(8, title.value.length + 2)) + 'ch'; };
  fitTitle();
  title.addEventListener('input', fitTitle);
  title.addEventListener('change', () => { g.title = title.value.trim() || 'Graph'; changed(); });
  title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') title.blur(); });
  const seg = h('span', 'seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Graph type');
  for (const [k, lab, tip] of [['time', 'Time', 'Plot against time'], ['spectrum', 'Spectrum', 'Frequency spectrum of the selected time range, or of what is visible']]) {
    const b = h('button', null, lab); b.type = 'button'; b.dataset.type = k; b.title = tip;
    b.setAttribute('aria-pressed', String(g.type === k));
    b.onclick = () => setType(g, k);
    seg.append(b);
  }
  const specOpts = h('span', 'g-specopts'); specOpts.hidden = g.type !== 'spectrum';
  const mkCheck = (key, label) => {
    const l = h('label'); const c = h('input'); c.type = 'checkbox'; c.id = `g${g.id}-${key}`; c.checked = !!g.spec[key];
    c.onchange = () => { g.spec[key] = c.checked; g._dirty = true; changed(); requestDraw(); };
    l.append(c, document.createTextNode(label)); return l;
  };
  const fReset = h('button', 'btn small ghost', 'All frequencies'); fReset.type = 'button'; fReset.hidden = g.spec.f0 === null;
  fReset.onclick = () => { g.spec.f0 = g.spec.f1 = null; fReset.hidden = true; g._dirty = true; changed(); requestDraw(); };
  const specInfo = h('span', 'g-specinfo');
  specOpts.append(mkCheck('db', 'dB'), mkCheck('logf', 'Log frequency'), fReset, specInfo);
  const acts = h('span', 'g-acts');
  const resetY = h('button', 'btn small ghost', 'Fit Y axes'); resetY.type = 'button'; resetY.title = 'Fit every Y axis to the data again';
  resetY.onclick = () => { g.axes = {}; g._dirty = true; updateResetY(g); changed(); requestDraw(true); };
  const listBtn = iconBtn(ICON.list, g.compact ? 'Show the field list' : 'Hide the field list and show a one-line legend', () => { g.compact = !g.compact; renderFields(g); changed(); requestDraw(true); });
  listBtn.classList.toggle('on', !g.compact); listBtn.setAttribute('aria-pressed', String(!g.compact));
  acts.append(resetY, listBtn, pinBtn(g),
    iconBtn(ICON.up, g.pin ? 'Move up in the pinned panels' : 'Move graph up', () => moveGraph(g, -1)),
    iconBtn(ICON.down, g.pin ? 'Move down in the pinned panels' : 'Move graph down', () => moveGraph(g, 1)),
    iconBtn(ICON.copy, 'Duplicate graph', () => duplicateGraph(g)),
    iconBtn(ICON.close, 'Remove graph', () => removeGraph(g)));
  head.append(title, seg, specOpts, acts);

  const plot = h('div', 'g-plot');
  const base = h('canvas', 'c-base'), over = h('canvas', 'c-over');
  over.setAttribute('aria-label', 'Graph. Drag to zoom or select, double-click for the whole log.');
  const tip = h('div', 'g-tip'); tip.hidden = true;
  plot.append(base, over, tip);
  const rz = h('div', 'g-resize'); rz.title = 'Drag to change the height';
  const fields = h('div', 'g-fields');
  const add = h('div', 'g-add');
  const addInp = h('input', 'inp formula');
  addInp.id = `g${g.id}-add`; addInp.placeholder = 'Add a field or formula: BARO.Alt, lowpass(ATT.Roll, 2), …';
  addInp.autocomplete = 'off'; addInp.spellcheck = false; addInp.setAttribute('aria-label', 'Add a field or formula');
  const addBtn = h('button', 'btn small', 'Add'); addBtn.type = 'button';
  add.append(addInp, addBtn);
  const addErr = h('div', 'f-err g-adderr');
  const legend = h('div', 'g-legend'); legend.hidden = true;
  root.append(head, plot, rz, legend, fields, add, addErr);

  g._el = { root, title, seg, specOpts, specInfo, fReset, resetY, plot, base, over, tip, fields, addInp, addErr, rz, legend, add, listBtn };
  root.classList.toggle('pinned', !!g.pin);
  g._ctx = base.getContext('2d'); g._octx = over.getContext('2d');
  g._w = 0; g._dirty = true;

  const doAdd = () => {
    const v = addInp.value.trim();
    if (!v) { addInp.focus(); return; }
    const err = EX.check(v, st.vars);
    if (err && st.ix) { addErr.textContent = err.message; addInp.focus(); return; }
    addErr.textContent = '';
    addInp.value = '';
    addFieldTo(g, v);
    addInp.focus();
  };
  addBtn.onclick = doAdd;
  attachFormula(addInp, { errEl: addErr, onEnter: doAdd, onEscape: () => { addInp.value = ''; addErr.textContent = ''; } });

  root.addEventListener('pointerdown', () => setActive(g), true);
  root.addEventListener('focusin', () => setActive(g));
  root.addEventListener('dragover', e => { if (dragKind(e)) { e.preventDefault(); root.classList.add('drop'); } });
  root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) root.classList.remove('drop'); });
  root.addEventListener('drop', e => {
    root.classList.remove('drop');
    const k = dragKind(e); if (!k) return;
    e.preventDefault(); e.stopPropagation();
    if (k === 'move') moveFieldTo(e.dataTransfer.getData('application/x-dfplot-field'), g);
    else { const v = e.dataTransfer.getData('text/plain').trim(); if (v) { setActive(g); addFieldTo(g, v); } }
  });
  attachPlot(g);
  attachResize(g);
  renderFields(g);
  updateResetY(g);
  return root;
}
function dragKind(e) {
  const t = e.dataTransfer && e.dataTransfer.types ? [...e.dataTransfer.types] : [];
  if (t.includes('application/x-dfplot-field')) return 'move';
  if (t.includes('text/plain') && !t.includes('Files')) return 'text';
  return null;
}
function moveFieldTo(key, g2) {
  const [gid, fid] = String(key).split(':').map(Number);
  const g1 = st.graphs.find(x => x.id === gid); if (!g1) return;
  const f = g1.fields.find(x => x.id === fid); if (!f) return;
  if (g1 === g2) return;
  g1.fields = g1.fields.filter(x => x !== f); normalizeAxes(g1);
  f.color = nextColor(g2);
  g2.fields.push(f);
  f.axis = smartAxis(g2, f); normalizeAxes(g2);
  renderFields(g1); renderFields(g2);
  g1._dirty = g2._dirty = true; changed(); requestDraw(true);
  setActive(g2); flashRow(g2, f);
}
function updateResetY(g) {
  if (!g._el) return;
  g._el.resetY.hidden = !Object.keys(g.axes).length;
  g._el.fReset.hidden = g.spec.f0 === null;
}

function statsHeader(g) {
  if (g.type === 'spectrum') return 'Strongest peak';
  return st.sel ? 'Min · Mean · Max selected' : 'Min · Mean · Max in view';
}
function pinBtn(g) {
  const b = iconBtn(ICON.pin, g.pin ? 'Unpin: put it back in its place' : 'Pin to the top of the screen', () => togglePin(g));
  b.classList.toggle('on', !!g.pin); b.setAttribute('aria-pressed', String(!!g.pin));
  return b;
}
function updateTimelinePin() {
  const b = $('tlPin'); if (!b) return;
  const on = !!st.set.tlPin;
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Unpin the timeline so it scrolls away' : 'Pin the timeline to the top of the screen';
  $('tl').classList.toggle('pinned', on);
}
/** One line per graph: colour, name and value at the cursor. Used when the field list is hidden. */
function renderLegend(g) {
  const el = g._el.legend;
  el.replaceChildren();
  for (const f of g.fields) {
    f._row = null;
    const it = h('button', 'lg-item' + (f.visible ? '' : ' off')); it.type = 'button';
    it.title = (f._r && f._r.error ? f._r.error.message + '\n' : '') + 'Click to show the field list';
    const sw = h('i'); sw.style.background = `var(--c${(f.color % NC) + 1})`;
    const nm = h('span', 'lg-name', fieldLabel(f) + (f._r && f._r.unit ? ` (${f._r.unit})` : ''));
    const val = h('b', 'lg-val', '–');
    it.append(sw, nm, val);
    if (f._r && f._r.error) it.classList.add('err');
    it.onclick = () => { g.compact = false; renderFields(g); changed(); requestDraw(true); };
    it.addEventListener('mouseenter', () => { if (ok(f) && f.visible) { g._hl = f.id; g._dirty = true; requestDraw(); } });
    it.addEventListener('mouseleave', () => { if (g._hl === f.id) { g._hl = null; g._dirty = true; requestDraw(); } });
    f._leg = val;
    el.append(it);
  }
  if (!g.fields.length) el.append(h('span', 'note', 'No fields yet. Show the field list to add one.'));
}
function renderFields(g) {
  if (!g._el || g.type === '3d') return;
  const compact = !!g.compact;
  g._el.fields.hidden = compact; g._el.add.hidden = compact; g._el.addErr.hidden = compact; g._el.legend.hidden = !compact;
  const lb = g._el.listBtn;
  if (lb) { lb.classList.toggle('on', !compact); lb.setAttribute('aria-pressed', String(!compact)); lb.title = compact ? 'Show the field list' : 'Hide the field list and show a one-line legend'; lb.setAttribute('aria-label', lb.title); }
  for (const f of g.fields) f._leg = null;
  if (compact) { renderLegend(g); updateResetY(g); return; }
  const box = g._el.fields;
  box.replaceChildren();
  const head = h('div', 'frow fhead');
  head.innerHTML = `<span></span><span></span><span>Field <span class="sr-n">${g.fields.length ? '' : '· none yet'}</span></span><span class="h-axis">Axis</span><span class="r">${g.type === 'spectrum' ? 'At pointer' : 'At cursor'}</span><span class="r f-stats" data-stats-head>${statsHeader(g)}</span><span></span><span></span>`;
  box.append(head);
  for (const f of g.fields) box.append(buildRow(g, f));
  for (const f of g.fields) f._stat = null;
  scheduleStats();
  updateResetY(g);
}
function axisOptions(g) {
  const s = new Set(g.fields.map(f => f.axis));
  return [...s].sort((a, b) => a - b);
}
function buildRow(g, f) {
  const row = h('div', 'frow' + (f.visible ? '' : ' off'));
  row.dataset.fid = f.id;
  const vis = h('input', 'f-vis'); vis.type = 'checkbox'; vis.checked = f.visible; vis.id = `f${f.id}-vis`; vis.setAttribute('aria-label', 'Show this field');
  vis.onchange = () => { f.visible = vis.checked; row.classList.toggle('off', !f.visible); g._dirty = true; changed(); requestDraw(true); };
  const sw = h('button', 'f-sw'); sw.type = 'button'; sw.style.setProperty('--c', `var(--c${(f.color % NC) + 1})`);
  sw.title = 'Colour. Drag to move the field to another graph.'; sw.setAttribute('aria-label', 'Field colour');
  sw.draggable = true;
  sw.onclick = e => { e.stopPropagation(); colorMenu(sw, g, f); };
  sw.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-dfplot-field', `${g.id}:${f.id}`); e.dataTransfer.setData('text/plain', f.expr); e.dataTransfer.effectAllowed = 'move'; });
  const ex = h('div', 'f-expr'); ex.tabIndex = 0; ex.title = 'Click to edit the formula';
  ex.setAttribute('role', 'button'); ex.setAttribute('aria-label', 'Edit formula ' + f.expr);
  ex.innerHTML = codeHTML(f);
  ex.onclick = () => editField(g, f);
  ex.onkeydown = e => { if (e.target === ex && (e.key === 'Enter' || e.key === 'F2')) { e.preventDefault(); editField(g, f); } };
  const axCell = h('div', 'f-axis-cell');
  const sel = h('select', 'sel f-axis'); sel.id = `f${f.id}-axis`; sel.setAttribute('aria-label', 'Y axis');
  for (const a of axisOptions(g)) { const o = h('option', null, 'Y' + a); o.value = a; sel.append(o); }
  const on = h('option', null, 'New Y'); on.value = 'new'; sel.append(on);
  sel.value = String(f.axis);
  sel.title = 'Fields on the same axis share one scale';
  sel.onchange = () => {
    if (sel.value === 'new') f.axis = Math.max(...g.fields.map(x => x.axis)) + 1;
    else f.axis = Number(sel.value);
    normalizeAxes(g); renderFields(g); g._dirty = true; changed(); requestDraw(true);
  };
  axCell.append(sel);
  const val = h('span', 'f-val'); val.textContent = '–';
  const stats = h('span', 'f-stats'); stats.textContent = '';
  const fx = iconBtn(ICON.fx, 'Transform: filters, rates and more', e => fxMenu(e.currentTarget, g, f));
  const del = iconBtn(ICON.close, 'Remove field', () => removeField(g, f));
  row.append(vis, sw, ex, axCell, val, stats, fx, del);
  row.addEventListener('mouseenter', () => { if (ok(f) && f.visible) { g._hl = f.id; g._dirty = true; requestDraw(); } });
  row.addEventListener('mouseleave', () => { if (g._hl === f.id) { g._hl = null; g._dirty = true; requestDraw(); } });
  f._row = { row, val, stats, ex };
  return row;
}
function codeHTML(f) {
  const r = f._r || {};
  let html = hl(f.expr, r.error);
  if (r.series && r.unit) html += `<span class="u">${esc(r.unit)}</span>`;
  if (r.series && r.series.konst) html += `<span class="u">= ${esc(fmtNum(r.series.v[0]))}</span>`;
  return `<div class="f-code">${html || '<span class="tk-op">(empty)</span>'}</div><div class="f-err">${r.error ? esc(r.error.message) : ''}</div>`;
}
/** Syntax colouring of a formula, with the error range underlined. */
function hl(text, err) {
  const n = text.length;
  if (!n) return '';
  const cls = new Array(n).fill('');
  try {
    const toks = EX.lex(text), sp = EX.splitName(text);
    toks.forEach((t, i) => {
      let c = '';
      if (t.t === 'ref') c = 'tk-ref';
      else if (t.t === 'num') c = 'tk-num';
      else if (t.t === 'str') c = 'tk-str';
      else if (t.t === 'op') c = 'tk-op';
      else if (t.t === 'id') c = (toks[i + 1] && toks[i + 1].t === 'op' && toks[i + 1].v === '(') ? 'tk-fn' : 'tk-ref';
      if (sp.name && i === 0 && t.t === 'id') c = 'tk-name';
      for (let k = t.pos; k < t.end && k < n; k++) cls[k] = c;
    });
  } catch (_) { /* unlexable: plain */ }
  const errA = err ? clamp(err.pos, 0, n) : -1, errB = err ? clamp(Math.max(err.end, err.pos + 1), 0, n) : -1;
  let out = '', i = 0;
  while (i < n) {
    let j = i + 1;
    const inErr = i >= errA && i < errB;
    while (j < n && cls[j] === cls[i] && ((j >= errA && j < errB) === inErr)) j++;
    const c = (cls[i] + (inErr ? ' tk-err' : '')).trim();
    const s = esc(text.slice(i, j));
    out += c ? `<span class="${c}">${s}</span>` : s;
    i = j;
  }
  return out;
}
function refreshRow(g, f) {
  if (!f._row) return;
  f._row.ex.innerHTML = codeHTML(f);
  f._row.ex.setAttribute('aria-label', 'Edit formula ' + f.expr);
}

/* ---------- editing a field's formula ---------- */
function editField(g, f, selRange) {
  if (!f._row) return;
  const box = f._row.ex;
  if (box.querySelector('input')) return;
  const inp = h('input', 'inp f-edit formula');
  inp.id = `f${f.id}-edit`; inp.value = f.expr; inp.spellcheck = false; inp.autocomplete = 'off'; inp.setAttribute('aria-label', 'Formula');
  const err = h('div', 'f-err');
  box.onclick = null;
  box.replaceChildren(inp, err);
  inp.focus();
  if (selRange) inp.setSelectionRange(selRange[0], selRange[1]);
  else inp.setSelectionRange(inp.value.length, inp.value.length);
  let done = false;
  const finish = commit => {
    if (done) return; done = true;
    acClose(); sigClose();
    const v = inp.value.trim();
    box.onclick = () => editField(g, f);
    if (commit && v !== f.expr) {
      if (!v) { removeField(g, f); return; }
      f.expr = v;
      evalAll();
      refreshRow(g, f);
      refreshAllRows();
      g._dirty = true;
      changed(); requestDraw(true);
      scheduleStats();
    } else refreshRow(g, f);
  };
  attachFormula(inp, { errEl: err, onEnter: () => finish(true), onEscape: () => finish(false), onBlur: () => finish(true), selfName: EX.splitName(f.expr).name });
  liveCheck(inp, err);
}
function refreshAllRows() {
  for (const g of st.graphs) for (const f of g.fields) if (f._row && !f._row.ex.querySelector('input')) refreshRow(g, f);
}

/* ---------- autocomplete & signature help ---------- */
const AC = { inp: null, items: [], idx: 0, a: 0, b: 0 };
function acCandidates(q) {
  const ql = q.toLowerCase(), out = [];
  const consider = (label, kind, detail, insert, weight) => {
    const l = label.toLowerCase();
    let s = -1;
    if (l.startsWith(ql)) s = 0;
    else { const dot = l.indexOf('.'); if (dot >= 0 && l.slice(dot + 1).startsWith(ql)) s = 1; else if (l.includes(ql)) s = 2; else if (subseq(ql, l)) s = 3; }
    if (s < 0) return;
    out.push({ label, kind, detail, insert: insert || label, s: s * 10 + weight, len: label.length });
  };
  const hasDot = q.includes('.');
  if (st.ix) for (const f of st.ix.fieldIds) consider(f.id, 'field', [f.unit, f.hz ? fmtHz(f.hz) : ''].filter(Boolean).join(' · '), null, hasDot ? 0 : 2);
  if (!hasDot) {
    for (const fn of EX.fnList()) for (const nm of fn.names) consider(nm, 'func', fn.sig, nm + '(', nm === fn.name ? 1 : 3);
    for (const k of ['pi', 'e', 'g', 'nan', 'armed', 'mode']) consider(k, 'value', { pi: '3.14159…', e: '2.71828…', g: '9.80665 m/s²', nan: 'no value', armed: '1 while armed', mode: 'flight mode number' }[k], null, 2);
    for (const k of st.vars.keys()) consider(k, 'name', 'named field', null, 0);
    if (st.ix && q.length >= 2 && /^[A-Z_]/.test(q)) {
      const tbl = DF.MODE_NAMES[st.ix.vehicle];
      if (tbl) for (const m of Object.values(tbl)) consider(m, 'mode', 'flight mode', null, 4);
    }
  }
  if (st.ix && (ql.startsWith('parm.') || (q.length >= 3 && /^[A-Z_]{3,}/.test(q)))) {
    const pq = ql.startsWith('parm.') ? ql.slice(5) : ql;
    for (const [name, p] of st.ix.params) {
      const l = name.toLowerCase();
      if (!pq || l.includes(pq)) out.push({ label: 'PARM.' + name, kind: 'param', detail: fmtNum(p.v[p.v.length - 1]), insert: 'PARM.' + name, s: (l.startsWith(pq) ? 5 : 25), len: name.length });
    }
  }
  out.sort((a, b) => a.s - b.s || a.len - b.len || (a.label < b.label ? -1 : 1));
  return out.slice(0, 60);
}
function subseq(q, s) { let i = 0; for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++; return i === q.length && q.length >= 2; }
function tokenAt(inp) {
  const s = inp.value, c = inp.selectionStart || 0;
  let a = c;
  while (a > 0 && /[A-Za-z0-9_.[\]]/.test(s[a - 1])) a--;
  if (/^[0-9.]/.test(s.slice(a, c))) return { a: c, b: c, text: '' };
  return { a, b: c, text: s.slice(a, c) };
}
function acUpdate(inp) {
  const tok = tokenAt(inp);
  if (!tok.text || inp.selectionStart !== inp.selectionEnd) { acClose(); return; }
  const items = acCandidates(tok.text);
  if (!items.length || (items.length === 1 && items[0].insert === tok.text)) { acClose(); return; }
  AC.inp = inp; AC.items = items; AC.idx = 0; AC.a = tok.a; AC.b = tok.b; AC.q = tok.text;
  acRender();
}
function acRender() {
  const el = $('ac');
  el.replaceChildren();
  const q = AC.q.toLowerCase();
  AC.items.forEach((it, i) => {
    const row = h('div', 'it'); row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === AC.idx));
    row.id = 'ac-' + i;
    const k = h('span', 'k', it.kind);
    const l = h('span', 'l');
    const at = it.label.toLowerCase().indexOf(q);
    if (at >= 0) l.innerHTML = esc(it.label.slice(0, at)) + '<mark>' + esc(it.label.slice(at, at + q.length)) + '</mark>' + esc(it.label.slice(at + q.length));
    else l.textContent = it.label;
    const d = h('span', 'd', it.detail || '');
    row.append(k, l, d);
    row.addEventListener('mousedown', e => { e.preventDefault(); AC.idx = i; acAccept(); });
    el.append(row);
  });
  el.hidden = false;
  const r = AC.inp.getBoundingClientRect();
  const w = Math.min(Math.max(r.width, 380), window.innerWidth - 16);
  el.style.width = w + 'px';
  el.style.left = clamp(r.left, 8, window.innerWidth - w - 8) + 'px';
  const below = window.innerHeight - r.bottom;
  if (below < 220 && r.top > below) { el.style.top = ''; el.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
  else { el.style.bottom = ''; el.style.top = (r.bottom + 4) + 'px'; }
  AC.inp.setAttribute('aria-activedescendant', 'ac-' + AC.idx);
  const cur = el.children[AC.idx]; if (cur) cur.scrollIntoView({ block: 'nearest' });
  sigClose();
}
function acClose() { $('ac').hidden = true; if (AC.inp) AC.inp.removeAttribute('aria-activedescendant'); AC.inp = null; }
function acAccept() {
  const it = AC.items[AC.idx], inp = AC.inp;
  if (!it || !inp) return;
  const s = inp.value;
  let ins = it.insert, caret;
  if (ins.endsWith('(')) {
    if (s[AC.b] === '(') { ins = ins.slice(0, -1); caret = AC.a + ins.length + 1; }
    else { ins += ')'; caret = AC.a + ins.length - 1; }
  } else caret = AC.a + ins.length;
  inp.value = s.slice(0, AC.a) + ins + s.slice(AC.b);
  inp.setSelectionRange(caret, caret);
  acClose();
  inp.dispatchEvent(new Event('input'));
  sigUpdate(inp);
}
function enclosingCall(s, caret) {
  let depth = 0, arg = 0;
  for (let i = caret - 1; i >= 0; i--) {
    const c = s[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) { const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(s.slice(0, i)); return m ? { name: m[1], arg } : null; }
      depth--;
    } else if (c === ',' && depth === 0) arg++;
  }
  return null;
}
function sigUpdate(inp, errMsg) {
  const el = $('sig');
  if (!$('ac').hidden) { el.hidden = true; return; }
  const call = enclosingCall(inp.value, inp.selectionStart || 0);
  const fn = call && EX.FN[call.name.toLowerCase()];
  el.classList.toggle('err', !!errMsg && !fn);
  if (fn) {
    const sig = fn.sig.split('   ')[0];
    const m = /^([^(]+)\((.*)\)$/.exec(sig);
    let html = esc(sig);
    if (m) {
      const args = m[2].split(',').map(x => x.trim());
      html = esc(m[1]) + '(' + args.map((a, i) => i === Math.min(call.arg, args.length - 1) ? `<b>${esc(a)}</b>` : esc(a)).join(', ') + ')';
    }
    el.innerHTML = `<code>${html}</code><span class="d">${esc(fn.desc.split('. ')[0].replace(/\.$/, ''))}.</span>`;
  } else if (errMsg) {
    el.innerHTML = `<span class="d">${esc(errMsg)}</span>`;
  } else { el.hidden = true; return; }
  el.hidden = false;
  const r = inp.getBoundingClientRect();
  el.style.left = clamp(r.left, 8, Math.max(8, window.innerWidth - 528)) + 'px';
  const below = window.innerHeight - r.bottom;
  if (below < 90) { el.style.top = ''; el.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
  else { el.style.bottom = ''; el.style.top = (r.bottom + 4) + 'px'; }
}
function sigClose() { $('sig').hidden = true; }
function liveCheck(inp, errEl) {
  const v = inp.value.trim();
  const err = v && st.ix ? EX.check(v, st.vars) : null;
  if (errEl) errEl.textContent = err ? err.message : '';
  return err;
}
function attachFormula(inp, o) {
  let t = 0;
  inp.addEventListener('input', () => {
    acUpdate(inp);
    sigUpdate(inp);
    clearTimeout(t);
    t = setTimeout(() => { if (document.activeElement === inp) liveCheck(inp, o.errEl); }, 260);
  });
  inp.addEventListener('keydown', e => {
    const open = !$('ac').hidden && AC.inp === inp;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      AC.idx = (AC.idx + (e.key === 'ArrowDown' ? 1 : -1) + AC.items.length) % AC.items.length;
      acRender(); return;
    }
    if (open && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); acAccept(); return; }
    if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); acClose(); sigUpdate(inp); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (o.onEnter) o.onEnter(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (o.onEscape) o.onEscape(); return; }
  });
  inp.addEventListener('keyup', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') { acClose(); sigUpdate(inp); } });
  inp.addEventListener('click', () => sigUpdate(inp));
  inp.addEventListener('focus', () => sigUpdate(inp));
  inp.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement === inp) return;
      if (AC.inp === inp) acClose();
      sigClose();
      if (o.onBlur) o.onBlur();
    }, 120);
  });
}

/* ---------- quick transforms ---------- */
const FX = [
  ['Low-pass filter', 'lowpass($, 2)', '2'],
  ['Low-pass, 2nd order', 'lowpass2($, 10)', '10'],
  ['High-pass filter', 'highpass($, 0.5)', '0.5'],
  ['Notch filter', 'notch($, 50, 12)', '50, 12'],
  ['Zero-lag smoothing', 'filtfilt($, 2)', '2'],
  ['Moving average', 'movavg($, 1)', '1'],
  ['Moving median', 'movmedian($, 0.5)', '0.5'],
  ['Moving max (peak hold)', 'movmax($, 2)', '2'],
  ['Moving RMS', 'movrms($, 1)', '1'],
  null,
  ['Rate of change (per second)', 'deriv($)', null],
  ['Integral over time', 'integral($)', null],
  ['Absolute value', 'abs($)', null],
  ['Multiply by…', '@ * 1', '1'],
  ['Add an offset…', '@ + 0', '0'],
  ['Start at zero', '@ - first($)', null],
  ['Centre on zero', 'detrend($)', null],
  ['Clip to a range', 'clip($, -10, 10)', '-10, 10'],
  ['Only while armed', 'if(armed, $, nan)', null],
  ['Unwrap angle', 'unwrap($)', null],
  ['Radians to degrees', 'deg($)', null]
];
function needsParens(body) {
  try { const a = EX.parse(body); return a.k === 'bin' || a.k === 'tern'; } catch (_) { return true; }
}
function fxApply(g, f, tpl, selText) {
  const sp = EX.splitName(f.expr);
  const body = sp.body.trim();
  const wrapped = tpl.replace(/\$/g, body).replace('@', needsParens(body) ? `(${body})` : body);
  const prefix = sp.name ? sp.name + ' = ' : '';
  const next = prefix + wrapped;
  f.expr = next;
  evalAll(); refreshAllRows(); g._dirty = true; changed(); requestDraw(true);
  if (selText) {
    const at = next.lastIndexOf(selText);
    if (at >= 0) editField(g, f, [at, at + selText.length]);
  }
}
function fxMenu(anchor, g, f) {
  const items = [{ head: 'Wrap this field in' }];
  for (const it of FX) {
    if (!it) { items.push({ sep: true }); continue; }
    items.push({ label: it[0], hint: it[1].replace(/\$|@/g, 'x'), action: () => fxApply(g, f, it[1], it[2]) });
  }
  items.push({ sep: true });
  items.push({ label: 'Name this field…', action: () => {
    const sp = EX.splitName(f.expr);
    if (sp.name) { editField(g, f, [0, sp.name.length]); return; }
    f.expr = 'Name = ' + f.expr.trim(); refreshRow(g, f); editField(g, f, [0, 4]);
  } });
  items.push({ label: 'Duplicate field', action: () => {
    const sp = EX.splitName(f.expr);
    const nf = mkField({ expr: sp.body.trim(), color: nextColor(g), axis: f.axis });
    g.fields.splice(g.fields.indexOf(f) + 1, 0, nf);
    evalAll(); renderFields(g); g._dirty = true; changed(); requestDraw(true); flashRow(g, nf);
  } });
  items.push({ label: 'Move to a new graph', action: () => {
    g.fields = g.fields.filter(x => x !== f); normalizeAxes(g);
    const ng = insertGraph(mkGraph({ title: titleFor(f.expr) }), st.graphs.indexOf(g) + 1);
    f.axis = 1; ng.fields.push(f);
    evalAll(); renderGraphs(); changed();
  } });
  items.push({ label: 'Copy formula', action: () => copyText(f.expr, 'Formula copied') });
  openMenu(anchor, items);
}
function colorMenu(anchor, g, f) {
  const box = h('div', 'swatches');
  for (let i = 0; i < NC; i++) {
    const b = h('button'); b.type = 'button'; b.style.setProperty('--c', `var(--c${i + 1})`);
    b.setAttribute('aria-pressed', String(f.color === i)); b.setAttribute('aria-label', 'Colour ' + (i + 1));
    b.onclick = () => { f.color = i; closeMenu(); renderFields(g); g._dirty = true; changed(); requestDraw(); };
    box.append(b);
  }
  openMenu(anchor, [{ el: box }]);
}
