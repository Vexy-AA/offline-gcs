'use strict';
/* global L, S, $, $$, api, esc, fmtSize, fmtDate, plural, viewJob, selectTab, infoFor, loadData */
// "Add area" tab: add a new area to the existing map tiles, terrain and elevation pieces
// (add-mbtiles, add-terrain, add-elevation), see it on a map first, and undo it later.

const A = { map: null, base: null, layers: null, cov: null, points: [], queue: [], fitted: false, tsInfo: {}, lastImg: '', lastDem: '' };
const COLORS_ADD = { tiles: '#4A6B7C', terrain: '#2E7D4F', pieces: '#1D2B33', new: '#8E2C6F' };
const addForm = $('#add-form');
const TS = 'tileset:';  // imagery option value for a tile set already in data/mbtiles

function srcFiles(use) {
  if (!S.data) return [];
  return S.data.src.filter((f) => {
    const info = infoFor(f);
    return info && (info.use || []).includes(use);
  });
}

// what the chosen imagery is: a file in data/src, or another served tile set
function imageryInfo(value) {
  if (!value || !S.data) return null;
  if (value.startsWith(TS)) {
    const m = S.data.mbtiles.find((x) => x.name === value.slice(TS.length));
    return m ? A.tsInfo[`${m.name}|${m.size}|${m.mtime}`] || null : null;
  }
  const f = S.data.src.find((x) => x.name === value);
  return f ? infoFor(f) : null;
}

async function fetchTilesetInfo(sets) {
  for (const m of sets) {
    const key = `${m.name}|${m.size}|${m.mtime}`;
    if (A.tsInfo[key]) continue;
    try { A.tsInfo[key] = await api(`/api/src/info?tileset=${encodeURIComponent(m.name)}`); } catch (e) {
      A.tsInfo[key] = { kind: 'mbtiles', use: [], summary: e.message };
    }
    renderAddForm();
  }
}

// bounds as add-mbtiles will read them: flipping the row order mirrors the latitudes
function imageryBounds(value) {
  const info = imageryInfo(value);
  if (!info || !info.bounds || info.bounds.length !== 4) return null;
  const b = info.bounds;
  const want = $('#add-rows').value;
  if (info.rows && want !== 'auto' && want !== info.rows) return [b[0], -b[3], b[2], -b[1]];
  return b;
}
const srcBounds = (name) => {
  const f = S.data && S.data.src.find((x) => x.name === name);
  const info = f && infoFor(f);
  return info && info.bounds && info.bounds.length === 4 ? info.bounds : null;
};

function optionFor(value, label, info) {
  return `<option value="${esc(value)}">${esc(label)}${info && info.zooms ? `  (zoom ${info.zooms[0]}–${info.zooms[1]})` : ''}</option>`;
}

function fillImagery(sel, target) {
  const keep = sel.value;
  const files = srcFiles('add-mbtiles');
  const group = (label, items) => (items.length ? `<optgroup label="${esc(label)}">${items.join('')}</optgroup>` : '');
  const folders = files.filter((f) => infoFor(f).kind === 'tiles').map((f) => optionFor(f.name, `${f.name}/`, infoFor(f)));
  const mbt = files.filter((f) => infoFor(f).kind === 'mbtiles').map((f) => optionFor(f.name, f.name, infoFor(f)));
  const tifs = files.filter((f) => infoFor(f).kind === 'imagery').map((f) => optionFor(f.name, f.name, null));
  const served = S.data.mbtiles.filter((m) => !m.error && m.name !== target).map((m) => {
    const info = A.tsInfo[`${m.name}|${m.size}|${m.mtime}`];
    if (info && !(info.use || []).includes('add-mbtiles')) return '';
    return optionFor(TS + m.name, `${m.name}.mbtiles`, info || { zooms: [m.minzoom, m.maxzoom] });
  }).filter(Boolean);
  const reading = S.data.src.filter((f) => !infoFor(f) && (f.dir || /\.(mbtiles|sqlitedb|sqlite3?|db)$/i.test(f.name)))
    .map((f) => `<option value="" disabled>${esc(f.name)}${f.dir ? '/' : ''}: still reading it…</option>`);
  sel.innerHTML = '<option value="">— no imagery —</option>'
    + group('Still being read', reading)
    + group('Tile folders (data/src)', folders)
    + group('MBTiles files (data/src)', mbt)
    + group('Imagery GeoTIFFs (data/src)', tifs)
    + group('Tile sets already served (data/mbtiles)', served);
  // files that look like tiles but can't be used, and why
  const problems = S.data.src.map((f) => {
    const info = infoFor(f);
    if (!info) {
      return (f.dir || /\.(mbtiles|sqlitedb|sqlite3?|db)$/i.test(f.name))
        ? `<li><span class="nm">${esc(f.name)}</span> <span class="why">still reading it${f.size ? ` (${fmtSize(f.size)})` : ''}…</span></li>` : '';
    }
    if ((info.use || []).includes('add-mbtiles') || !info.tileish) return '';
    const base = f.name.split('/').pop();
    const why = info.summary.startsWith(base) ? info.summary.slice(base.length).replace(/^[\s:/]+/, '') : info.summary;
    const short = info.damaged ? 'is damaged (SQLite: database disk image is malformed): probably an incomplete copy.' : why;
    return `<li><span class="nm">${esc(f.name)}${f.dir ? '/' : ''}</span> <span class="why">${esc(short)}</span>
      <button type="button" data-check="${esc(f.name)}">Check it</button>${info.damaged
        ? ` <button type="button" data-repair="${esc(f.name)}">Make a repaired copy</button>` : ''}</li>`;
  }).filter(Boolean);
  const box = $('#add-img-problems');
  box.innerHTML = problems.length ? `<li><b>Not in the list:</b></li>${problems.join('')}` : '';
  box.hidden = !problems.length;
  const values = $$('option:not([disabled])', sel).map((o) => o.value);
  if (keep && values.includes(keep)) sel.value = keep;
  else if (!keep && !sel.dataset.touched && values.length === 2) sel.value = values[1];
  else sel.value = '';
}

function fillSelect(sel, files, none) {
  const keep = sel.value;
  sel.innerHTML = `<option value="">${esc(none)}</option>` + files.map((f) => {
    const info = infoFor(f);
    const what = { tiles: info.summary, dem: 'elevation model', imagery: 'image', mbtiles: 'MBTiles' }[info.kind] || info.kind;
    return `<option value="${esc(f.name)}">${esc(f.name)}${f.dir ? '/' : ''}  (${esc(what)})</option>`;
  }).join('');
  if (files.some((f) => f.name === keep)) sel.value = keep;
  else if (files.length === 1 && !keep && !sel.dataset.touched) sel.value = files[0].name;
}

function renderRows() {
  // row order only matters for tile folders and .mbtiles
  const info = imageryInfo($('#add-imagery').value);
  const box = $('#add-rows-box');
  box.hidden = !(info && info.rows);
  if (box.hidden) return;
  const word = { xyz: 'XYZ, rows from the north', tms: 'TMS, rows from the south' }[info.rows];
  $('#add-rows-auto').textContent = `Detect (${info.rows.toUpperCase()})`;
  const want = $('#add-rows').value;
  $('#add-rows-note').textContent = want === 'auto'
    ? `Read as ${word}. Check the outline on the map: if the new area shows up mirrored to the other hemisphere, pick the other order.`
    : want === info.rows ? `Same as detected (${word}).`
      : `Overrides the detected order (${info.rows.toUpperCase()}): the area moves to the other hemisphere on the map.`;
}

function renderAddForm() {
  if (!S.data) return;
  const img = $('#add-imagery'), dem = $('#add-dem'), ts = $('#add-tileset');
  // what was chosen the last time the form was drawn (the select already holds the new choice)
  const prevImg = A.lastImg, prevDem = A.lastDem;

  const sets = S.data.mbtiles.filter((m) => !m.error);
  const keepTs = ts.value;
  ts.innerHTML = sets.length ? sets.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}.mbtiles</option>`).join('')
    : '<option value="">no .mbtiles yet</option>';
  ts.value = sets.some((m) => m.name === keepTs) ? keepTs : (sets.find((m) => m.name === 'custom') ? 'custom' : (sets[0] || {}).name || '');
  fetchTilesetInfo(sets.filter((m) => m.name !== ts.value));

  fillImagery(img, ts.value);
  fillSelect(dem, srcFiles('add-terrain'), '— no elevation model —');
  $('#add-nofiles').hidden = S.data.src.length > 0 || sets.length > 1;
  if (img.value !== prevImg) $('#add-rows').value = 'auto';
  renderRows();

  // which targets are possible
  const hasTerrain = !!(S.data.terrain && !S.data.terrain.error);
  const can = {
    mbtiles: !!img.value && sets.length > 0,
    terrain: !!dem.value && hasTerrain,
    elevation: !!dem.value,
  };
  const why = {
    mbtiles: !sets.length ? 'There is no .mbtiles yet: build one on the Build data tab first.' : !img.value ? 'Choose the new imagery above.' : null,
    terrain: !hasTerrain ? 'There is no terrain yet: build it on the Build data tab first.' : !dem.value ? 'Choose the new elevation model above.' : null,
    elevation: !dem.value ? 'Choose the new elevation model above.' : null,
  };
  const desc = {
    mbtiles: 'New tiles are added; where both have a tile the two are combined, by the rule in step 3.',
    terrain: 'Only tiles that touch the new area are made again. Old heights come from the elevation pieces (or the old tiles).',
    elevation: S.data.elevation && S.data.elevation.files
      ? 'New pieces only where there are none, so pieces never overlap. Then the server re-reads the folder.'
      : 'There are no pieces yet: the new file is simply cut into pieces.',
  };
  for (const k of ['mbtiles', 'terrain', 'elevation']) {
    const cb = $(`#do-${k}`);
    cb.disabled = !can[k];
    if (!can[k]) cb.checked = false;
    // tick a target when its file is first chosen
    if (can[k] && ((k === 'mbtiles' && img.value !== prevImg) || (k !== 'mbtiles' && dem.value !== prevDem))) cb.checked = true;
    $(`#tg-${k}`).classList.toggle('off', !can[k]);
    $(`#tg-${k}-desc`).textContent = why[k] || desc[k];
  }
  A.lastImg = img.value;
  A.lastDem = dem.value;
  updateAddPreview();
  drawAddMap();
}

function collectAdd(dry) {
  const fd = new FormData(addForm);
  const prefer = fd.get('prefer') || 'existing';
  const jobs = [];
  // map tiles first; terrain before elevation, so the terrain still sees the old pieces as they were
  if ($('#do-mbtiles').checked) {
    const img = fd.get('imagery');
    const fromSet = img.startsWith(TS);
    const info = imageryInfo(img);
    jobs.push({ kind: 'add-mbtiles', params: {
      sources: fromSet ? [] : [img], source_tileset: fromSet ? img.slice(TS.length) : undefined,
      target: fd.get('tileset'), prefer, scheme: info && info.rows ? fd.get('rows') || 'auto' : 'auto',
      lower_zooms: !!fd.get('lower_zooms'), black_empty: !!fd.get('black_empty'), dry_run: dry } });
  }
  if ($('#do-terrain').checked) {
    jobs.push({ kind: 'add-terrain', params: { sources: [fd.get('dem')], prefer, dry_run: dry } });
  }
  if ($('#do-elevation').checked) {
    jobs.push({ kind: 'add-elevation', params: { sources: [fd.get('dem')], prefer,
      fill_holes: !!fd.get('fill_holes'), restart: !!fd.get('restart'), dry_run: dry } });
  }
  return jobs;
}

function addCommand({ kind, params: p }) {
  const a = ['./gcs-tools', kind, p.source_tileset ? `data/mbtiles/${p.source_tileset}.mbtiles` : `data/src/${p.sources[0]}`];
  if (kind === 'add-mbtiles') {
    a.push(`data/mbtiles/${p.target || 'custom'}.mbtiles`);
    if (p.scheme && p.scheme !== 'auto') a.push('--scheme', p.scheme);
    if (!p.lower_zooms) a.push('--no-lower-zooms');
    if (p.black_empty) a.push('--black-empty');
  } else if (kind === 'add-terrain') {
    a.push('data/terrain');
  } else {
    a.push('--out', 'data/elevation');
    if (!p.fill_holes) a.push('--no-fill-holes');
  }
  if (p.prefer === 'new') a.push('--prefer', 'new');
  return a.join(' ');
}

function updateAddPreview() {
  const jobs = collectAdd(false);
  $('#add-cmd').textContent = jobs.length ? jobs.map(addCommand).join('\n') : 'Choose the new files and what to add them to.';
  $('#add-run').disabled = $('#add-check').disabled = !jobs.length;
}

addForm.addEventListener('change', (ev) => {
  if (ev.target.tagName === 'SELECT') ev.target.dataset.touched = '1';
  if (ev.target.matches('#add-imagery, #add-dem, #add-tileset')) renderAddForm();
  else if (ev.target.matches('#add-rows')) { renderRows(); updateAddPreview(); drawAddMap(); }
  else updateAddPreview();
});

async function submitAdd(dry) {
  const err = $('#add-error');
  err.hidden = true;
  const jobs = collectAdd(dry);
  if (!jobs.length) return;
  if (!dry) {
    const what = jobs.map((j) => ({ 'add-mbtiles': 'map tiles', 'add-terrain': 'terrain', 'add-elevation': 'elevation pieces' }[j.kind]));
    const rule = jobs[0].params.prefer === 'new' ? 'the new files win where both have data' : 'existing data is kept where both have data';
    if (!confirm(`Add the new area to the ${what.join(', ')}?\n\n${rule[0].toUpperCase()}${rule.slice(1)}. Each change gets a restore point.`)) return;
  }
  const buttons = [$('#add-run'), $('#add-check')];
  buttons.forEach((b) => { b.disabled = true; });
  const ids = [];
  try {
    for (const j of jobs) {
      const res = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j) });
      ids.push(res.id);
    }
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    updateAddPreview();
  }
  if (ids.length) {
    A.queue = ids.slice(1);
    viewJob(ids[0]);
    $('#add-job-slot').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
addForm.addEventListener('submit', (ev) => { ev.preventDefault(); submitAdd(false); });
$('#add-check').addEventListener('click', () => submitAdd(true));

// ---------- map ----------
function rectLL(b) { return [[b[1], b[0]], [b[3], b[2]]]; }

function ensureMap() {
  if (A.map || !window.L) return;
  A.map = L.map('add-map', { attributionControl: false, minZoom: 1, maxZoom: 19, worldCopyJump: true, zoomSnap: 0.5 });
  A.map.setView([20, 0], 2);
  A.layers = L.layerGroup().addTo(A.map);
}

async function loadCoverage() {
  try { A.cov = await api('/api/coverage'); } catch { A.cov = null; }
  drawAddMap();
}

function overlapShare(box, others) {
  // share of `box` inside the union of `others`, sampled on a 60 x 60 grid
  if (!box || !others.length) return 0;
  let hit = 0;
  const n = 60;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lon = box[0] + (box[2] - box[0]) * (i + 0.5) / n;
      const lat = box[1] + (box[3] - box[1]) * (j + 0.5) / n;
      if (others.some((o) => lon >= o[0] && lon <= o[2] && lat >= o[1] && lat <= o[3])) hit++;
    }
  }
  return hit / (n * n);
}

function drawAddMap() {
  const tabShown = !$('#tab-add').hidden;
  if (!tabShown) return;
  ensureMap();
  if (!A.map) return;
  A.map.invalidateSize();
  A.layers.clearLayers();
  const cov = A.cov;
  const all = [];
  const summary = [];
  const target = $('#add-tileset').value;
  const set = cov && cov.tilesets.find((t) => t.name === target);

  // base imagery: the tile set the new imagery goes into
  if (cov && S.info) {
    // the file's size and time are in the key, so the map re-reads the tiles after a merge
    const want = set ? `${set.name}|${set.size}|${set.mtime}` : null;
    if (!A.base || A.base.options.setKey !== want) {
      if (A.base) { A.base.remove(); A.base = null; }
      if (set) {
        const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
        A.base = L.tileLayer(`http://${host}:${S.info.ports.mbtiles}/services/${encodeURIComponent(set.name)}/tiles/{z}/{x}/{y}.png?v=${Math.round(set.mtime)}`,
          { maxNativeZoom: Number(set.maxzoom) || 18, maxZoom: 19, setKey: want }).addTo(A.map);
        A.base.bringToBack();
      }
    }
  }
  if (cov) {
    for (const p of cov.pieces) {
      L.rectangle(rectLL(p.bounds), { color: COLORS_ADD.pieces, weight: 0.8, opacity: 0.55, fill: false, interactive: false }).addTo(A.layers);
      all.push(...rectLL(p.bounds));
    }
    if (cov.terrain && cov.terrain.bounds) {
      L.rectangle(rectLL(cov.terrain.bounds), { color: COLORS_ADD.terrain, weight: 2, dashArray: '3 4', fill: false, interactive: false }).addTo(A.layers);
      all.push(...rectLL(cov.terrain.bounds));
    }
    if (set && set.bounds && set.bounds.length === 4) {
      L.rectangle(rectLL(set.bounds), { color: COLORS_ADD.tiles, weight: 2, dashArray: '8 5', fill: false, interactive: false }).addTo(A.layers);
      all.push(...rectLL(set.bounds));
    }
  }
  const img = $('#add-imagery').value, dem = $('#add-dem').value;
  const ib = img && imageryBounds(img), db = dem && srcBounds(dem);
  const imgName = img.startsWith(TS) ? `${img.slice(TS.length)}.mbtiles` : img;
  if (ib) {
    L.rectangle(rectLL(ib), { color: COLORS_ADD.new, weight: 2.5, fillColor: COLORS_ADD.new, fillOpacity: 0.16, interactive: false }).addTo(A.layers);
    all.push(...rectLL(ib));
    const share = set && set.bounds ? overlapShare(ib, [set.bounds]) : 0;
    summary.push(`<li><b>New imagery</b> ${esc(imgName)}: ${share > 0.995 ? 'lies entirely inside' : share > 0.005 ? `${Math.round(share * 100)}% of it lies inside` : 'lies outside'} the area of ${esc(target)}.mbtiles.</li>`);
  } else if (img) {
    const info = imageryInfo(img);
    summary.push(`<li><b>New imagery</b> ${esc(imgName)}: ${info && !(info.use || []).length ? esc(info.summary) : 'reading its area…'}</li>`);
  }
  if (db) {
    L.rectangle(rectLL(db), { color: COLORS_ADD.new, weight: 2.5, dashArray: '6 4', fillColor: COLORS_ADD.new, fillOpacity: 0.08, interactive: false }).addTo(A.layers);
    all.push(...rectLL(db));
    const t = cov && cov.terrain && cov.terrain.bounds ? overlapShare(db, [cov.terrain.bounds]) : 0;
    const p = cov ? overlapShare(db, cov.pieces.map((x) => x.bounds)) : 0;
    const pct = (v) => (v > 0.995 ? 'all' : v > 0.005 ? `${Math.round(v * 100)}%` : 'none');
    summary.push(`<li><b>New elevation model</b> ${esc(dem)}: ${pct(t)} of it inside the terrain area, ${pct(p)} already covered by elevation pieces.</li>`);
  } else if (dem) {
    summary.push(`<li><b>New elevation model</b> ${esc(dem)}: reading its area…</li>`);
  }
  if (!img && !dem) summary.push('<li>Choose the new files to see where they go.</li>');
  $('#add-summary').innerHTML = summary.join('');
  const key = JSON.stringify([img, dem, all.length, $('#add-rows').value]);
  if (all.length && A.fitKey !== key) {
    A.fitKey = key;
    A.map.fitBounds(L.latLngBounds(all), { padding: [24, 24], maxZoom: 13 });
  }
}

// ---------- restore points ----------
function pointCounts(m) {
  const d = m.details || {};
  if (m.kind === 'mbtiles' && d.stats) {
    const st = d.stats;
    return `${plural(st.added || 0, 'tile', 'tiles')} added, ${(st.combined || 0) + (st.replaced || 0)} changed`;
  }
  if (m.kind === 'terrain') return `${plural(d.added || 0, 'tile', 'tiles')} added, ${d.replaced || 0} remade`;
  if (m.kind === 'elevation') return `${plural(m.added, 'piece', 'pieces')} added, ${m.replaced} changed, ${m.removed} removed`;
  return `${m.added} added, ${m.replaced} replaced, ${m.removed} removed`;
}

async function loadPoints() {
  try { A.points = await api('/api/backups'); } catch { return; }
  const list = $('#restore-list');
  if (!A.points.length) {
    list.innerHTML = '<li><p class="empty">No restore points yet. Adding an area makes one.</p></li>';
    return;
  }
  list.innerHTML = A.points.slice().reverse().map((m) => {
    const half = m.state !== 'done' ? ' <span class="st-warn">(interrupted: restore it)</span>' : '';
    const prefer = m.details && m.details.prefer === 'new' ? 'new files won overlaps' : 'kept existing data in overlaps';
    return `<li>
      <div><span class="nm">${esc(m.title)}</span>${half}
        <div class="meta">${esc(fmtDate(m.created))} · ${esc(pointCounts(m))} · ${esc(prefer)} · keeps ${esc(fmtSize(m.size))}</div></div>
      <div class="acts">
        <button type="button" class="btn btn-small" data-restore="${esc(m.id)}" ${m.restorable ? '' : 'disabled title="Restore the newer change to the same data first"'}>Restore</button>
        <button type="button" class="btn btn-small btn-danger" data-forget="${esc(m.id)}">Delete</button></div></li>`;
  }).join('');
}

$('#restore-list').addEventListener('click', async (ev) => {
  const r = ev.target.closest('[data-restore]');
  const d = ev.target.closest('[data-forget]');
  if (r) {
    const m = A.points.find((x) => x.id === r.dataset.restore);
    if (!confirm(`Undo "${m.title}"?\n\nThe files it replaced are put back and the files it added are removed.`)) return;
    try {
      const job = await api(`/api/backups/${encodeURIComponent(m.id)}/restore`, { method: 'POST' });
      A.queue = [];
      viewJob(job.id);
    } catch (e) { alert(e.message); }
  }
  if (d) {
    const m = A.points.find((x) => x.id === d.dataset.forget);
    if (!confirm(`Delete the restore point "${m.title}"?\n\nThe change stays; you just can't undo it any more. Frees ${fmtSize(m.size)}.`)) return;
    try { await api(`/api/backups/${encodeURIComponent(m.id)}`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
    loadPoints();
  }
});

$('#add-img-problems').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-check]');
  if (b && window.checkFile) window.checkFile({ sources: [b.dataset.check] }, b.dataset.check);
  const r = ev.target.closest('[data-repair]');
  if (r && window.repairFile) window.repairFile(r.dataset.repair);
});

// ---------- "Add as new area" on the Files tab ----------
window.addPick = (use, name) => {
  selectTab('add');
  const sel = use === 'add-mbtiles' ? $('#add-imagery') : $('#add-dem');
  sel.dataset.touched = '1';
  if ($$('option', sel).some((o) => o.value === name)) {
    sel.value = name;
    renderAddForm();
  }
  $('#tab-add').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ---------- hooks from app.js ----------
window.onDataChanged = renderAddForm;
window.onTabShown = (name) => {
  if (name !== 'add') return;
  renderAddForm();
  loadCoverage();
  loadPoints();
};
window.onJobFinished = (j) => {
  if (/^(add-|restore)/.test(j.kind)) { loadCoverage(); loadPoints(); }
  if (A.queue.length) {
    const next = A.queue.shift();
    setTimeout(() => viewJob(next), 600);
  }
};
