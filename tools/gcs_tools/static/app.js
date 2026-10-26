'use strict';

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t * 1000);
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${sec}s`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- state ----------
const S = {
  info: null, check: null, data: null, srcInfo: {},
  jobs: [], viewJob: null, logNext: 0, pollTimer: null, checking: false,
};
const HOST = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
const svcUrl = (svc, path = '') => (S.info ? `http://${HOST}:${S.info.ports[svc]}${path}` : '#');

const SERVICE_TITLES = {
  mbtiles: 'Map tiles', terrain: 'Terrain', elevation: 'Elevation API',
  logviewer: 'Log viewer', webtools: 'WebTools', containers: 'Containers',
};
const KIND_BUTTON = {
  mbtiles: 'Build map tiles', terrain: 'Build terrain', elevation: 'Cut elevation pieces', 'check-terrain': 'Check terrain',
};

function section(id) {
  return S.check ? S.check.sections.find((s) => s.id === id) : null;
}
function stateOf(id) {
  const sec = section(id);
  if (!sec) return { cls: 'none', word: S.checking ? 'Checking…' : 'Not checked' };
  const n = (st) => sec.items.filter((i) => i.status === st).length;
  if (sec.status === 'ok') return { cls: 'ok', word: 'Working' };
  if (sec.status === 'warn') return { cls: 'warn', word: plural(n('warn'), 'warning', 'warnings') };
  const first = sec.items.find((i) => i.status === 'fail');
  if (first && /not reachable/.test(first.text)) return { cls: 'fail', word: 'Not reachable' };
  return { cls: 'fail', word: plural(n('fail'), 'problem', 'problems') };
}
const COLORS = { ok: '#2E7D4F', warn: '#9A6414', fail: '#B3263E', none: '#9FB2BC' };

function openUrl(svc) {
  const d = S.data;
  switch (svc) {
    case 'mbtiles': return svcUrl('mbtiles', '/services');
    case 'terrain': return svcUrl('terrain', '/quantized/layer.json');
    case 'logviewer': return svcUrl('logviewer', '/');
    case 'webtools': return svcUrl('webtools', '/');
    case 'elevation': {
      const tb = d && d.terrain && d.terrain.bounds;
      const pt = tb ? `${((tb[1] + tb[3]) / 2).toFixed(5)},${((tb[0] + tb[2]) / 2).toFixed(5)}` : '44.6,33.5';
      return svcUrl('elevation', `/elevation/v1/ele/?points=${pt}`);
    }
    default: return '#';
  }
}

// ---------- diagram ----------
const N = {
  src: { x: 14, y: 116, w: 172, h: 80, title: 'Source files', folder: true },
  fm: { x: 262, y: 18, w: 196, h: 80, title: 'data/mbtiles', folder: true },
  ft: { x: 262, y: 116, w: 196, h: 80, title: 'data/terrain', folder: true },
  fe: { x: 262, y: 214, w: 196, h: 80, title: 'data/elevation', folder: true },
  mbtiles: { x: 532, y: 18, w: 200, h: 80, svc: true },
  terrain: { x: 532, y: 116, w: 200, h: 80, svc: true },
  elevation: { x: 532, y: 214, w: 200, h: 80, svc: true },
  logviewer: { x: 798, y: 46, w: 188, h: 80, svc: true },
  webtools: { x: 798, y: 214, w: 188, h: 80, svc: true },
};
const mid = (n, side) => [side === 'r' ? n.x + n.w : n.x, n.y + n.h / 2];

function folderLines(key) {
  const d = S.data;
  if (!d) return ['', ''];
  if (key === 'src') {
    const n = d.src.length;
    return ['data/src', n ? plural(n, 'file', 'files') : 'empty: add files'];
  }
  if (key === 'fm') {
    if (!d.mbtiles.length) return ['no .mbtiles yet', ''];
    const m = d.mbtiles.find((x) => x.name === 'custom') || d.mbtiles[0];
    const more = d.mbtiles.length > 1 ? ` +${d.mbtiles.length - 1}` : '';
    return [`${m.name}.mbtiles${more}`, `zoom ${m.minzoom ?? '?'}–${m.maxzoom ?? '?'}, ${fmtSize(m.size)}`];
  }
  if (key === 'ft') {
    const t = d.terrain;
    if (!t) return ['no layer.json yet', ''];
    if (t.error) return ['layer.json unreadable', ''];
    return [`levels 0–${t.levels - 1}`, `built ${fmtDate(t.mtime)}`];
  }
  if (key === 'fe') {
    const e = d.elevation;
    if (!e || !e.files) return ['no pieces yet', ''];
    const idx = e.indexed == null ? 'not indexed' : `${e.indexed} indexed`;
    return [plural(e.files, 'piece', 'pieces') + `, ${fmtSize(e.size)}`, idx];
  }
  return ['', ''];
}

function svcSub(key) {
  const port = S.info ? `:${S.info.ports[key]}` : '';
  const extra = {
    mbtiles: 'mbtileserver', terrain: 'nginx', elevation: 'open-elevation',
    logviewer: 'UAV Log Viewer', webtools: 'ArduPilot',
  }[key];
  return `${port}  ${extra}`;
}

function drawDiagram() {
  const svg = $('#diagram');
  const parts = [`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7F959F"/></marker></defs>`];
  // flows
  const curve = (a, b) => {
    const dx = (b[0] - a[0]) / 2;
    return `<path class="flow" marker-end="url(#arr)" d="M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0] - 2},${b[1]}"/>`;
  };
  const s = mid(N.src, 'r');
  for (const [k, label, lx, ly, anchor] of [['fm', 'mbtiles', 212, 96, 'end'], ['ft', 'terrain', 224, 147, 'middle'],
    ['fe', 'elevation', 212, 226, 'end']]) {
    parts.push(curve(s, mid(N[k], 'l')));
    parts.push(`<text class="t-flow" x="${lx}" y="${ly}" text-anchor="${anchor}">${label}</text>`);
  }
  for (const [a, b] of [['fm', 'mbtiles'], ['ft', 'terrain'], ['fe', 'elevation']]) parts.push(curve(mid(N[a], 'r'), mid(N[b], 'l')));
  parts.push(curve(mid(N.mbtiles, 'r'), [N.logviewer.x, N.logviewer.y + 30]));
  parts.push(curve(mid(N.terrain, 'r'), [N.logviewer.x, N.logviewer.y + 56]));

  // folders
  for (const key of ['src', 'fm', 'ft', 'fe']) {
    const n = N[key];
    const [a, b] = folderLines(key);
    parts.push(`<g class="node" tabindex="0" role="button" data-go="files" aria-label="${esc(n.title)}: ${esc(a)}">
      <rect class="box box-folder" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5"/>
      <text class="t-title" x="${n.x + 14}" y="${n.y + 27}">${esc(n.title)}</text>
      <text class="t-sub" x="${n.x + 14}" y="${n.y + 49}">${esc(a)}</text>
      <text class="t-sub" x="${n.x + 14}" y="${n.y + 68}">${esc(b)}</text></g>`);
  }
  // servers
  for (const key of ['mbtiles', 'terrain', 'elevation', 'logviewer', 'webtools']) {
    const n = N[key];
    const st = stateOf(key);
    const col = COLORS[st.cls];
    parts.push(`<g class="node" tabindex="0" role="button" data-svc="${key}" aria-label="${esc(SERVICE_TITLES[key])}: ${esc(st.word)}">
      <rect class="box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5"/>
      <rect x="${n.x}" y="${n.y}" width="6" height="${n.h}" rx="2" fill="${col}"/>
      <text class="t-title" x="${n.x + 18}" y="${n.y + 27}">${esc(SERVICE_TITLES[key])}</text>
      <text class="t-sub" x="${n.x + 18}" y="${n.y + 48}" xml:space="preserve">${esc(svcSub(key))}</text>
      <text class="t-state" x="${n.x + 18}" y="${n.y + 69}" fill="${col}">${esc(st.word)}</text>
      <a href="${esc(openUrl(key))}" target="_blank" rel="noopener"><text class="t-link" x="${n.x + n.w - 12}" y="${n.y + 69}" text-anchor="end">Open</text></a></g>`);
  }
  svg.innerHTML = parts.join('');

  // list for narrow screens
  $('#diagram-list').innerHTML = ['mbtiles', 'terrain', 'elevation', 'logviewer', 'webtools'].map((key) => {
    const st = stateOf(key);
    return `<li><span class="nm">${esc(SERVICE_TITLES[key])}</span>
      <a href="${esc(openUrl(key))}" target="_blank" rel="noopener">Open</a>
      <span class="sm"><span class="st-${st.cls}">${esc(st.word)}</span>, ${esc(svcSub(key))}</span></li>`;
  }).join('');
}

$('#diagram').addEventListener('click', (ev) => {
  if (ev.target.closest('a')) return;
  const g = ev.target.closest('.node');
  if (!g) return;
  if (g.dataset.svc) showService(g.dataset.svc);
  else if (g.dataset.go) selectTab(g.dataset.go);
});
$('#diagram').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const g = ev.target.closest('.node');
  if (!g) return;
  ev.preventDefault();
  if (g.dataset.svc) showService(g.dataset.svc);
  else if (g.dataset.go) selectTab(g.dataset.go);
});

function showService(key) {
  selectTab('health');
  const el = document.getElementById(`svc-${key}`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.querySelector('h3').focus(); }
}

// ---------- tabs ----------
// links like /tools#health, /tools#files, /tools#build=terrain open a tab (and a builder)
function applyHash() {
  const [tab, val] = location.hash.replace(/^#/, '').split('=');
  if (!['health', 'build', 'files'].includes(tab)) return false;
  selectTab(tab);
  const radio = val && $(`input[name="kind"][value="${CSS.escape(val)}"]`);
  if (radio) { radio.checked = true; onKindChange(); }
  return true;
}
window.addEventListener('hashchange', applyHash);
function selectTab(name) {
  for (const b of $$('.tabs button')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    $(`#tab-${b.dataset.tab}`).hidden = !on;
  }
  try { localStorage.setItem('gcs-tab', name); } catch { /* storage unavailable */ }
}
$('.tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (b) selectTab(b.dataset.tab);
});

// ---------- health ----------
// show shell commands inside check hints as code
const withCode = (text) => esc(text).replace(/(git submodule update[^.;]*|docker compose [a-z]+(?: [a-z]+)?)/g, '<code>$1</code>');
const GLYPH = { ok: '✓', warn: '!', fail: '✕', info: 'i' };
const STATUS_WORD = { ok: 'OK', warn: 'Warning', fail: 'Problem', info: 'Note' };

function renderHealth() {
  const box = $('#health');
  if (!S.check) {
    box.innerHTML = `<p class="empty">${S.checking ? 'Running checks…' : 'No results yet.'}</p>`;
    return;
  }
  const docker = S.info && S.info.docker;
  box.innerHTML = S.check.sections.map((sec) => {
    const unknown = sec.items.every((i) => i.status === 'info');
    const st = sec.id !== 'containers' ? stateOf(sec.id)
      : unknown ? { cls: 'none', word: 'Status unknown' }
        : { cls: sec.status, word: { ok: 'All running', warn: 'Check below', fail: 'Not all running' }[sec.status] };
    const acts = [];
    if (sec.id !== 'containers') acts.push(`<a href="${esc(openUrl(sec.id))}" target="_blank" rel="noopener">Open</a>`);
    if (sec.id === 'mbtiles' && S.data) {
      for (const m of S.data.mbtiles.slice(0, 4)) {
        acts.push(`<a href="${esc(svcUrl('mbtiles', `/services/${m.name}/map`))}" target="_blank" rel="noopener">Preview ${esc(m.name)}</a>`);
      }
    }
    if (docker && sec.id !== 'containers') {
      acts.push(`<button type="button" data-log="${sec.id}">Server log</button>`);
      acts.push(`<button type="button" data-restart="${sec.id}">Restart</button>`);
    }
    const items = sec.items.map((it) => `<li class="i-${it.status}">
        <span class="g" aria-hidden="true">${GLYPH[it.status]}</span>
        <span class="t"><span class="sr">${STATUS_WORD[it.status]}: </span>${esc(it.text)}</span>
        ${it.detail && it.status !== 'ok' ? `<span class="d">${withCode(it.detail)}</span>` : ''}</li>`).join('');
    return `<article class="svc s-${st.cls}" id="svc-${sec.id}">
      <div class="svc-head"><h3 tabindex="-1">${esc(SERVICE_TITLES[sec.id] || sec.title)}</h3>
        <span class="state-word">${esc(st.word)}</span>
        <div class="svc-acts">${acts.join('')}</div></div>
      <ul class="items">${items}</ul></article>`;
  }).join('');
  $('#health-time').textContent = `Checked at ${new Date().toLocaleTimeString()} in ${S.check.seconds} s.`;
}

$('#health').addEventListener('click', async (ev) => {
  const lb = ev.target.closest('[data-log]');
  const rb = ev.target.closest('[data-restart]');
  if (lb) {
    const svc = lb.dataset.log;
    $('#logdlg-title').textContent = `${SERVICE_TITLES[svc]} server log`;
    $('#logdlg-text').textContent = 'Loading…';
    $('#logdlg').showModal();
    try {
      const r = await api(`/api/services/${svc}/logs?tail=200`);
      $('#logdlg-text').textContent = r.log || '(empty)';
      $('#logdlg-text').scrollTop = 1e9;
    } catch (e) { $('#logdlg-text').textContent = e.message; }
  }
  if (rb) {
    const svc = rb.dataset.restart;
    if (!confirm(`Restart the ${SERVICE_TITLES[svc]} server? It is unavailable for a few seconds.`)) return;
    rb.disabled = true;
    rb.textContent = 'Restarting…';
    try {
      await api(`/api/services/${svc}/restart`, { method: 'POST' });
      setTimeout(runChecks, 3000);
    } catch (e) { alert(e.message); }
    finally { rb.disabled = false; rb.textContent = 'Restart'; }
  }
});
$('#logdlg-close').addEventListener('click', () => $('#logdlg').close());

function renderOverall() {
  const el = $('#overall');
  if (!S.check) { el.textContent = S.checking ? 'Checking the servers…' : 'Servers not checked yet.'; return; }
  const secs = S.check.sections;
  const bad = secs.filter((s) => s.status === 'fail').map((s) => SERVICE_TITLES[s.id] || s.title);
  const warn = secs.filter((s) => s.status === 'warn').map((s) => SERVICE_TITLES[s.id] || s.title);
  if (bad.length) el.innerHTML = `<span class="st st-fail">Needs attention:</span> ${esc(bad.join(', '))}`;
  else if (warn.length) el.innerHTML = `<span class="st st-warn">Working, with warnings:</span> ${esc(warn.join(', '))}`;
  else el.innerHTML = '<span class="st st-ok">All servers are working.</span>';
}

async function runChecks() {
  if (S.checking) return;
  S.checking = true;
  const btn = $('#run-checks');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  if (!S.check) { renderOverall(); renderHealth(); }
  try {
    S.check = await api('/api/check');
  } catch (e) {
    $('#overall').textContent = `Checks failed to run: ${e.message}`;
  } finally {
    S.checking = false;
    btn.disabled = false;
    btn.textContent = 'Run checks';
    renderOverall();
    renderHealth();
    drawDiagram();
  }
}
$('#run-checks').addEventListener('click', runChecks);

// ---------- data / files ----------
async function loadData() {
  try { S.data = await api('/api/data'); } catch (e) { console.warn(e); return; }
  drawDiagram();
  renderFiles();
  renderSourcePick();
  fetchSrcInfo();
}

async function fetchSrcInfo() {
  if (!S.data) return;
  for (const f of S.data.src) {
    const key = `${f.name}|${f.mtime}`;
    if (S.srcInfo[key]) continue;
    try {
      S.srcInfo[key] = await api(`/api/src/info?path=${encodeURIComponent(f.name)}`);
    } catch (e) {
      S.srcInfo[key] = { kind: 'unknown', summary: e.message, use: [] };
    }
    renderFiles();
    renderSourcePick();
  }
}
const infoFor = (f) => S.srcInfo[`${f.name}|${f.mtime}`];

function renderFiles() {
  const d = S.data;
  if (!d) return;
  $('#src-list').innerHTML = d.src.length ? d.src.map((f) => {
    const info = infoFor(f);
    const rows = [];
    if (info) {
      rows.push(['What', info.summary]);
      if (info.crs) rows.push(['Coordinates', info.crs]);
      if (info.width) rows.push(['Size', `${info.width} × ${info.height} px, ${info.bands} band(s), ${info.type}`]);
      if (info.pixel) rows.push(['Pixel', info.pixel]);
      if (info.bounds) rows.push(['Area', `${info.bounds[0]}, ${info.bounds[1]} to ${info.bounds[2]}, ${info.bounds[3]}`]);
    } else {
      rows.push(['What', 'reading…']);
    }
    const use = info && info.use && info.use[0];
    const act = use === 'unpack'
      ? `<button type="button" class="btn btn-small" data-unpack="${esc(f.name)}">Unpack</button>`
      : use ? `<button type="button" class="btn btn-small" data-use="${esc(use)}" data-name="${esc(f.name)}">Build from it</button>` : '';
    return `<li><div><span class="nm">${esc(f.name)}${f.dir ? '/' : ''}</span>
        <div class="meta">${f.dir ? 'folder' : fmtSize(f.size)}, ${esc(fmtDate(f.mtime))}</div></div>
      <div class="acts">
        ${act}
        <button type="button" class="btn btn-small btn-danger" data-del="${esc(f.name)}">Delete</button></div>
      <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></li>`;
  }).join('') : '<li><p class="empty">No source files yet. Add a GeoTIFF of imagery or an elevation model.</p></li>';
  $('#disk').textContent = d.disk ? `${fmtSize(d.disk.free)} free of ${fmtSize(d.disk.total)} on the data disk.` : '';

  const served = [];
  for (const m of d.mbtiles) {
    served.push(`<div class="served-item"><h3>Map tiles: ${esc(m.name)}.mbtiles</h3>
      <p>${esc(m.format || '?')}, zoom ${esc(m.minzoom ?? '?')}–${esc(m.maxzoom ?? '?')}, ${fmtSize(m.size)}, ${esc(fmtDate(m.mtime))}
      ${m.error ? `<br>Can't read it: ${esc(m.error)}` : ''}</p>
      <p><a href="${esc(svcUrl('mbtiles', `/services/${m.name}/map`))}" target="_blank" rel="noopener">Preview map</a></p></div>`);
  }
  if (!d.mbtiles.length) served.push('<div class="served-item"><h3>Map tiles</h3><p>No .mbtiles in data/mbtiles.</p></div>');
  const t = d.terrain;
  served.push(`<div class="served-item"><h3>Terrain</h3><p>${t ? (t.error ? esc(t.error)
    : `Levels 0–${t.levels - 1}, built ${esc(fmtDate(t.mtime))}${t.bounds ? `<br>Area ${t.bounds.map((v) => v.toFixed(3)).join(', ')}` : ''}`)
    : 'No terrain in data/terrain.'}</p></div>`);
  const e = d.elevation;
  served.push(`<div class="served-item"><h3>Elevation pieces</h3><p>${e && e.files
    ? `${plural(e.files, 'file', 'files')}, ${fmtSize(e.size)}; ${e.indexed == null ? 'not indexed yet (restart the elevation server)' : `${e.indexed} indexed by the server`}`
    : 'No .tif files in data/elevation.'}</p></div>`);
  $('#served').innerHTML = served.join('');
}

$('#src-list').addEventListener('click', async (ev) => {
  const unpack = ev.target.closest('[data-unpack]');
  if (unpack) {
    try {
      const job = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'unpack', params: { sources: [unpack.dataset.unpack] } }) });
      selectTab('build');
      viewJob(job.id);
    } catch (e) { alert(e.message); }
    return;
  }
  const del = ev.target.closest('[data-del]');
  const use = ev.target.closest('[data-use]');
  if (del) {
    const name = del.dataset.del;
    if (!confirm(`Delete data/src/${name}? This can't be undone.`)) return;
    try { await api(`/api/src?path=${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
    loadData();
  }
  if (use) {
    $(`input[name="kind"][value="${use.dataset.use}"]`).checked = true;
    onKindChange();
    for (const cb of $$('#src-pick input')) cb.checked = cb.value === use.dataset.name;
    updatePreview();
    selectTab('build');
  }
});

// uploads
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));
$('#upload').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });

function putFile(file, li, overwrite) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload?name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) li.textContent = `${file.name}: ${Math.round(e.loaded / e.total * 100)}% of ${fmtSize(e.total)}`;
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => resolve({ status: 0, text: '{"error":"connection lost"}' });
    xhr.send(file);
  });
}

async function uploadFiles(list) {
  for (const file of Array.from(list)) {
    const li = document.createElement('li');
    li.textContent = `${file.name}: starting`;
    $('#uploads').appendChild(li);
    let r = await putFile(file, li, false);
    if (r.status === 409 && confirm(`data/src/${file.name} exists. Replace it?`)) r = await putFile(file, li, true);
    let msg = '';
    try { msg = JSON.parse(r.text).error; } catch { msg = r.text; }
    li.textContent = r.status === 200 ? `${file.name}: uploaded (${fmtSize(file.size)})` : `${file.name}: not uploaded, ${msg || 'error ' + r.status}`;
    loadData();
  }
}

// ---------- build form ----------
const kind = () => $('input[name="kind"]:checked').value;

function suits(info, k) {
  if (!info) return true;
  return (info.use || []).includes(k);
}

function renderSourcePick() {
  const d = S.data;
  const box = $('#src-pick');
  if (!d) return;
  const k = kind();
  // keep ticked files that also suit the newly chosen tool
  const keep = new Set($$('#src-pick input:checked').map((i) => i.value)
    .filter((name) => { const f = d.src.find((x) => x.name === name); return f && suits(infoFor(f), k); }));
  if (!d.src.length) {
    box.innerHTML = '<p class="empty">No files in data/src. Add some on the Files tab.</p>';
    updatePreview();
    return;
  }
  const single = k === 'check-terrain';
  $('#src-legend').textContent = single ? 'Elevation model to compare with (optional)' : 'Source files';
  const rows = d.src.map((f) => {
    const info = infoFor(f);
    const ok = suits(info, k);
    return `<label class="src-row${ok ? '' : ' unsuited'}">
      <input type="${single ? 'radio' : 'checkbox'}" name="src" value="${esc(f.name)}" ${keep.has(f.name) ? 'checked' : ''}>
      <span class="nm">${esc(f.name)}${f.dir ? '/' : ''}</span>
      <span class="sm">${esc(info ? info.summary : 'reading…')}</span></label>`;
  });
  if (single) rows.unshift(`<label class="src-row"><input type="radio" name="src" value="" ${keep.size ? '' : 'checked'}>
      <span class="nm">Don't compare</span><span class="sm">Only check the tiles themselves</span></label>`);
  box.innerHTML = rows.join('');
  updatePreview();
}

function onKindChange() {
  const k = kind();
  for (const fs of $$('.opts')) fs.hidden = fs.dataset.for !== k;
  $('#run-job').textContent = KIND_BUTTON[k];
  $('#form-error').hidden = true;
  renderSourcePick();
}
$('.tools').addEventListener('change', onKindChange);
$('#build-form').addEventListener('input', updatePreview);
$('#build-form').addEventListener('change', updatePreview);

function collect() {
  const k = kind();
  const fs = $(`.opts[data-for="${k}"]`);
  const p = { sources: $$('#src-pick input:checked').map((i) => i.value).filter(Boolean) };
  for (const el of $$('input, select', fs)) {
    if (el.type === 'radio') { if (el.checked) p[el.name] = el.value; continue; }
    if (el.type === 'checkbox') { p[el.name] = el.checked; continue; }
    if (el.value !== '') p[el.name] = el.type === 'number' ? Number(el.value) : el.value;
  }
  if (k === 'terrain' && p.quality === 1) delete p.quality;
  return { kind: k, params: p };
}

function previewCommand({ kind: k, params: p }) {
  const src = (p.sources.length ? p.sources : ['<choose a file>']).map((s) => `data/src/${s}`);
  const a = ['./gcs-tools', k];
  if (k === 'mbtiles') {
    a.push(...src, `data/mbtiles/${p.name || 'custom'}.mbtiles`, '--format', p.format || 'auto');
    if (p.quality != null && ['auto', 'jpeg', 'webp'].includes(p.format)) a.push('--quality', p.quality);
    if (p.max_zoom != null) a.push('--max-zoom', p.max_zoom);
    if (p.overwrite) a.push('--overwrite');
  } else if (k === 'terrain') {
    a.push(...src, 'data/terrain', `--${p.mode || 'clean'}`);
    if (p.max_zoom != null) a.push('--max-zoom', p.max_zoom);
    if (p.quality != null) a.push('--quality', p.quality);
    if (p.max_zoom_error != null) a.push('--max-zoom-error', p.max_zoom_error);
  } else if (k === 'elevation') {
    a.push(...src, '--out', 'data/elevation');
    if (p.piece_size) a.push('--piece-size', p.piece_size);
    if (p.replace) a.push('--replace');
  } else {
    a.push('data/terrain');
    if (p.sources.length) a.push('--dem', `data/src/${p.sources[0]}`);
  }
  return a.join(' ');
}
function updatePreview() { $('#cmd-preview').textContent = previewCommand(collect()); }

$('#build-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const req = collect();
  const err = $('#form-error');
  err.hidden = true;
  if (req.kind !== 'check-terrain' && !req.params.sources.length) {
    err.textContent = 'Choose at least one source file.';
    err.hidden = false;
    return;
  }
  const btn = $('#run-job');
  btn.disabled = true;
  $('#job-state').textContent = 'Starting…';
  $('#job-state').className = 'job-state js-queued';
  try {
    const job = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    viewJob(job.id);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- jobs ----------
const JOB_WORD = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

function jobStateText(j) {
  if (j.status === 'running') return j.progress != null ? `Running, ${Math.round(j.progress)}%` : 'Running';
  if (j.status === 'done') return `Done in ${fmtDuration(j.ended - j.started)}`;
  if (j.status === 'failed') return `Failed (exit ${j.returncode})`;
  return JOB_WORD[j.status];
}

async function viewJob(id) {
  S.viewJob = id;
  S.logNext = 0;
  $('#job-log').textContent = '';
  await pollJob();
}

async function pollJob() {
  clearTimeout(S.pollTimer);
  if (S.viewJob == null) return;
  let j;
  try { j = await api(`/api/jobs/${S.viewJob}?since=${S.logNext}`); } catch { S.pollTimer = setTimeout(pollJob, 3000); return; }
  const log = $('#job-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if (j.lines.length) {
    log.textContent += (log.textContent ? '\n' : '') + j.lines.join('\n');
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  S.logNext = j.next;
  $('#job-title').textContent = j.title;
  const st = $('#job-state');
  st.textContent = jobStateText(j);
  st.className = `job-state js-${j.status}`;
  $('#job-cmd').textContent = j.command;
  const bar = $('#job-bar');
  bar.hidden = !(j.status === 'running' && j.progress != null);
  bar.firstElementChild.style.width = `${j.progress || 0}%`;
  $('#job-notes').innerHTML = (j.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
  $('#job-cancel').hidden = !['running', 'queued'].includes(j.status);
  updateChip(j);
  if (['running', 'queued'].includes(j.status)) {
    S.pollTimer = setTimeout(pollJob, 1000);
  } else if (S.lastFinished !== j.id) {
    S.lastFinished = j.id;
    loadJobs();
    if (j.started && Date.now() / 1000 - j.ended < 30) { loadData(); setTimeout(runChecks, 1500); }
  }
}

function updateChip(j) {
  const chip = $('#jobchip');
  if (j && ['running', 'queued'].includes(j.status)) {
    chip.hidden = false;
    chip.textContent = `${j.title}: ${jobStateText(j)}`;
  } else {
    chip.hidden = true;
  }
}
$('#jobchip').addEventListener('click', () => selectTab('build'));

$('#job-cancel').addEventListener('click', async () => {
  if (S.viewJob == null || !confirm('Cancel this job? A terrain build can be continued later.')) return;
  try { await api(`/api/jobs/${S.viewJob}/cancel`, { method: 'POST' }); } catch (e) { alert(e.message); }
  pollJob();
});

async function loadJobs() {
  try { S.jobs = await api('/api/jobs'); } catch { return; }
  $('#history').innerHTML = S.jobs.length ? S.jobs.map((j) => `<li><button type="button" data-job="${j.id}">
      <span class="hn">${esc(j.title)}, ${esc(fmtDate(j.created))}</span>
      <span class="hs js-${j.status}">${esc(JOB_WORD[j.status])}</span></button></li>`).join('')
    : '<li><p class="empty">Nothing built since the tools service started.</p></li>';
  return S.jobs;
}
$('#history').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-job]');
  if (b) viewJob(Number(b.dataset.job));
});

// ---------- start ----------
async function start() {
  try { S.info = await api('/api/info'); } catch (e) {
    $('#overall').textContent = `The tools service is not answering: ${e.message}`;
    return;
  }
  $('#host').textContent = `${location.hostname}, tools ${S.info.version}${S.info.docker ? '' : ', no Docker access (status and restart buttons off)'}`;
  let tab = 'health';
  try { tab = localStorage.getItem('gcs-tab') || 'health'; } catch { /* storage unavailable */ }
  selectTab(tab);
  onKindChange();
  applyHash();
  drawDiagram();
  await Promise.all([loadData(), loadJobs()]);
  const active = S.jobs.find((j) => ['running', 'queued'].includes(j.status)) || S.jobs[0];
  if (active) { S.lastFinished = active.status === 'running' || active.status === 'queued' ? null : active.id; viewJob(active.id); }
  runChecks();
  setInterval(() => { if (!document.hidden) runChecks(); }, 120000);
}
start();
