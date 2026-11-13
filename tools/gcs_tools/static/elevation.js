'use strict';
/* global L */
// Elevation viewer: local imagery from the map tile server as the base map, heights
// from open-elevation (through the tools server, which batches requests).

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HOST = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const ACCENT = '#8E2C6F';
  const CARPET_DEG = 0.05;   // up to this size: every 1-arc-second sample (the carpet API)
  const MAX_AREA_DEG = 3;     // bigger areas are sampled on a coarser grid

  async function api(path) {
    const r = await fetch(path);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }
  function msg(text, err) {
    const el = $('#msg');
    el.textContent = text || '';
    el.classList.toggle('err', !!err);
  }
  const fmtM = (v) => `${Math.round(v)} m`;
  const fmtLL = (ll) => `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;

  const map = L.map('map', { attributionControl: false, minZoom: 1, maxZoom: 20, worldCopyJump: true, zoomSnap: 0.5 });
  map.setView([20, 0], 2);
  let base = null;
  const overlays = { pieces: L.layerGroup().addTo(map), terrain: L.layerGroup().addTo(map) };
  const work = L.layerGroup().addTo(map);

  // ---------- modes ----------
  const HINTS = {
    point: 'Click anywhere to read the height there.',
    profile: 'Click to add points along a route. Double-click, or press Show profile, to see the height along it.',
    area: `Click two opposite corners of an area to shade it by height. Small areas (under ${CARPET_DEG}°, about 5 km) use every sample; bigger ones, up to ${MAX_AREA_DEG}°, are shaded more coarsely.`,
  };
  let mode = 'point';
  function setMode(m) {
    mode = m;
    $('#hint').textContent = HINTS[m];
    for (const k of ['point', 'profile', 'area']) $(`#out-${k}`).hidden = k !== m;
    if (m === 'profile') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    map.getContainer().style.cursor = 'crosshair';
    resetProfile(); resetArea(); msg('');
  }
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));

  // ---------- point ----------
  const pointList = [];
  async function readPoint(ll) {
    const mk = L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: ACCENT, fillOpacity: 1 }).addTo(work);
    try {
      const r = await api(`/api/elevation/points?points=${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`);
      const h = r.data[0];
      mk.bindPopup(`<b>${esc(fmtM(h))}</b><br>${esc(fmtLL(ll))}`).openPopup();
      pointList.unshift({ ll, h });
      pointList.length = Math.min(pointList.length, 10);
      $('#points').innerHTML = pointList.map((p) => `<li><span class="h">${esc(fmtM(p.h))}</span><span class="ll">${esc(fmtLL(p.ll))}</span></li>`).join('');
      msg(h === 0 ? 'No elevation data at that point (0 m).' : '');
    } catch (e) {
      mk.remove();
      msg(`Couldn't read the height: ${e.message}`, true);
    }
  }

  // ---------- profile ----------
  let profPts = [];
  let profLine = null;
  let profMarker = null;
  function resetProfile() {
    profPts = [];
    if (profLine) { profLine.remove(); profLine = null; }
    if (profMarker) { profMarker.remove(); profMarker = null; }
    $('#prof-chart').innerHTML = '';
    $('#prof-stats').innerHTML = '';
    $('#prof-go').disabled = true;
  }
  function addProfilePoint(ll) {
    profPts.push(ll);
    if (!profLine) profLine = L.polyline(profPts, { color: ACCENT, weight: 3 }).addTo(work);
    else profLine.setLatLngs(profPts);
    $('#prof-go').disabled = profPts.length < 2;
  }
  function sampleRoute(pts) {
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const d = map.distance(pts[i - 1], pts[i]); seg.push(d); total += d; }
    const n = Math.max(40, Math.min(400, Math.round(total / 25)));
    const out = [];
    for (let k = 0; k < n; k++) {
      let target = total * k / (n - 1);
      let i = 0;
      while (i < seg.length - 1 && target > seg[i]) { target -= seg[i]; i++; }
      const f = seg[i] ? Math.min(1, target / seg[i]) : 0;
      const a = pts[i], b = pts[i + 1];
      out.push({ ll: L.latLng(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f), d: total * k / (n - 1) });
    }
    return { samples: out, total };
  }
  async function showProfile() {
    if (profPts.length < 2) return;
    const { samples, total } = sampleRoute(profPts);
    msg('Reading heights…');
    try {
      const pts = samples.map((s) => `${s.ll.lat.toFixed(6)},${s.ll.lng.toFixed(6)}`).join(',');
      const r = await api(`/api/elevation/points?points=${pts}`);
      samples.forEach((s, i) => { s.h = r.data[i]; });
      drawChart(samples, total);
      msg(samples.some((s) => s.h === 0) ? 'Part of the route has no elevation data (shown as 0 m).' : '');
    } catch (e) {
      msg(`Couldn't read the profile: ${e.message}`, true);
    }
  }
  function drawChart(s, total) {
    const W = 320, H = 180, PL = 44, PR = 10, PT = 14, PB = 24;
    const hs = s.map((p) => p.h);
    let lo = Math.min(...hs), hi = Math.max(...hs);
    if (hi - lo < 10) { hi += 5; lo -= 5; }
    const x = (d) => PL + (W - PL - PR) * d / total;
    const y = (h) => PT + (H - PT - PB) * (1 - (h - lo) / (hi - lo));
    const line = s.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.h).toFixed(1)}`).join('');
    const area = `${line}L${x(total).toFixed(1)},${H - PB}L${PL},${H - PB}Z`;
    const km = total >= 2000;
    const dl = (d) => (km ? `${(d / 1000).toFixed(d < 10000 ? 1 : 0)} km` : `${Math.round(d)} m`);
    $('#prof-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Height along the route">
      <path class="area" d="${area}"/><path class="line" d="${line}"/>
      <line class="axis" x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}"/>
      <line class="axis" x1="${PL}" y1="${PT}" x2="${PL}" y2="${H - PB}"/>
      <text x="${PL - 6}" y="${y(hi) + 4}" text-anchor="end">${Math.round(hi)}</text>
      <text x="${PL - 6}" y="${y(lo) + 4}" text-anchor="end">${Math.round(lo)}</text>
      <text x="${PL}" y="${H - 6}">0</text>
      <text x="${W - PR}" y="${H - 6}" text-anchor="end">${dl(total)}</text>
      <g id="xh" visibility="hidden"><line class="cross" y1="${PT}" y2="${H - PB}"/><circle class="dot" r="3.5"/>
        <text class="readout" y="${PT - 3}"></text></g>
      <rect id="hit" x="${PL}" y="${PT}" width="${W - PL - PR}" height="${H - PT - PB}" fill="transparent"/></svg>`;
    let up = 0, down = 0;
    for (let i = 1; i < hs.length; i++) { const dh = hs[i] - hs[i - 1]; if (dh > 0) up += dh; else down -= dh; }
    $('#prof-stats').innerHTML = `<dt>Length</dt><dd>${esc(dl(total))}</dd>
      <dt>Lowest</dt><dd>${esc(fmtM(Math.min(...hs)))}</dd><dt>Highest</dt><dd>${esc(fmtM(Math.max(...hs)))}</dd>
      <dt>Climb</dt><dd>${esc(fmtM(up))}</dd><dt>Descent</dt><dd>${esc(fmtM(down))}</dd>`;

    const svg = $('#prof-chart svg');
    const xh = svg.querySelector('#xh');
    const move = (ev) => {
      const pt = svg.createSVGPoint();
      const e = ev.touches ? ev.touches[0] : ev;
      pt.x = e.clientX; pt.y = e.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      const d = Math.max(0, Math.min(total, (p.x - PL) / (W - PL - PR) * total));
      let best = s[0];
      for (const q of s) if (Math.abs(q.d - d) < Math.abs(best.d - d)) best = q;
      xh.setAttribute('visibility', 'visible');
      xh.querySelector('line').setAttribute('x1', x(best.d)); xh.querySelector('line').setAttribute('x2', x(best.d));
      xh.querySelector('circle').setAttribute('cx', x(best.d)); xh.querySelector('circle').setAttribute('cy', y(best.h));
      const t = xh.querySelector('text');
      t.textContent = `${fmtM(best.h)} at ${dl(best.d)}`;
      t.setAttribute('x', Math.min(Math.max(x(best.d), PL + 50), W - PR - 50)); t.setAttribute('text-anchor', 'middle');
      if (!profMarker) profMarker = L.circleMarker(best.ll, { radius: 6, color: '#fff', weight: 2, fillColor: ACCENT, fillOpacity: 1 }).addTo(work);
      else profMarker.setLatLng(best.ll);
    };
    svg.querySelector('#hit').addEventListener('mousemove', move);
    svg.querySelector('#hit').addEventListener('touchmove', (e) => { e.preventDefault(); move(e); }, { passive: false });
  }
  $('#prof-go').addEventListener('click', showProfile);
  $('#prof-clear').addEventListener('click', () => { resetProfile(); msg(''); });

  // ---------- area ----------
  let corner = null, cornerMk = null, areaRect = null, areaImg = null;
  function resetArea() {
    corner = null;
    for (const l of [cornerMk, areaRect, areaImg]) if (l) l.remove();
    cornerMk = areaRect = areaImg = null;
    $('#area-legend').hidden = true;
    $('#area-stats').innerHTML = '';
  }
  async function areaClick(ll) {
    if (!corner || areaImg) {
      resetArea();
      corner = ll;
      cornerMk = L.circleMarker(ll, { radius: 5, color: ACCENT, weight: 2, fillOpacity: 0.3 }).addTo(work);
      msg('Now click the opposite corner.');
      return;
    }
    const s = Math.min(corner.lat, ll.lat), n = Math.max(corner.lat, ll.lat);
    const w = Math.min(corner.lng, ll.lng), e = Math.max(corner.lng, ll.lng);
    if (n - s > MAX_AREA_DEG || e - w > MAX_AREA_DEG) {
      msg(`That area is ${(n - s).toFixed(1)}° by ${(e - w).toFixed(1)}°; keep each side under ${MAX_AREA_DEG}°. Click a first corner again.`, true);
      resetArea();
      return;
    }
    if (n - s < 0.0006 || e - w < 0.0006) { msg('That area is too small. Click a first corner again.', true); resetArea(); return; }
    cornerMk.remove(); cornerMk = null;
    areaRect = L.rectangle([[s, w], [n, e]], { color: ACCENT, weight: 1.5, fill: false, dashArray: '5 4' }).addTo(work);
    msg('Reading heights…');
    try {
      const latMid = (s + n) / 2;
      const hM = (n - s) * 110540, wM = (e - w) * 111320 * Math.cos(latMid * Math.PI / 180);
      let r;
      if (n - s <= CARPET_DEG && e - w <= CARPET_DEG) {
        r = await api(`/api/elevation/carpet?points=${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`);
      } else {
        const cell = Math.max(hM, wM) / 160;
        const cols = Math.max(2, Math.round(wM / cell)), rows = Math.max(2, Math.round(hM / cell));
        r = await api(`/api/elevation/grid?bounds=${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}&cols=${cols}&rows=${rows}`);
      }
      const grid = r.data.carpet;
      const url = relief(grid, hM / Math.max(grid.length - 1, 1), wM / Math.max(grid[0].length - 1, 1));
      areaImg = L.imageOverlay(url.dataUrl, [[s, w], [n, e]], { opacity: Number($('#area-opacity').value) }).addTo(work);
      areaRect.bringToFront();
      $('#area-legend').hidden = false;
      $('#area-lo').textContent = fmtM(url.lo);
      $('#area-hi').textContent = fmtM(url.hi);
      const st = r.data.stats;
      $('#area-stats').innerHTML = `<dt>Lowest</dt><dd>${esc(fmtM(st.min))}</dd><dt>Highest</dt><dd>${esc(fmtM(st.max))}</dd>
        <dt>Average</dt><dd>${esc(fmtM(st.avg))}</dd><dt>Samples</dt><dd>${grid.length} × ${grid[0].length}</dd>`;
      msg('');
    } catch (err) {
      msg(`Couldn't read the area: ${err.message}`, true);
      resetArea();
    }
  }
  $('#area-opacity').addEventListener('input', (e) => { if (areaImg) areaImg.setOpacity(Number(e.target.value)); });
  $('#area-clear').addEventListener('click', () => { resetArea(); msg(''); });

  const RAMP = [[0, [79, 138, 91]], [0.3, [169, 188, 116]], [0.55, [225, 207, 147]], [0.8, [187, 142, 98]], [1, [243, 239, 234]]];
  function ramp(t) {
    for (let i = 1; i < RAMP.length; i++) {
      if (t <= RAMP[i][0]) {
        const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i];
        const f = (t - t0) / (t1 - t0);
        return c0.map((v, k) => v + (c1[k] - v) * f);
      }
    }
    return RAMP[RAMP.length - 1][1];
  }
  // grid[i][j]: i from south to north, j from west to east; dy, dx: sample spacing in metres
  function relief(grid, dy, dx) {
    const rows = grid.length, cols = grid[0].length;
    let lo = Infinity, hi = -Infinity;
    for (const row of grid) for (const v of row) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = Math.max(hi - lo, 1);
    const L0 = [-0.5, 0.5, 0.7071];  // light from the north-west, 45° up
    const cv = document.createElement('canvas');
    cv.width = cols; cv.height = rows;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cols, rows);
    const z = (i, j) => grid[Math.min(rows - 1, Math.max(0, i))][Math.min(cols - 1, Math.max(0, j))];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const gx = (z(i, j + 1) - z(i, j - 1)) / (2 * dx) * 1.5;
        const gy = (z(i + 1, j) - z(i - 1, j)) / (2 * dy) * 1.5;
        const nl = Math.hypot(gx, gy, 1);
        const shade = Math.max(0, (-gx * L0[0] - gy * L0[1] + L0[2]) / nl);
        const c = ramp((grid[i][j] - lo) / span);
        const k = 0.45 + 0.7 * shade;
        const o = ((rows - 1 - i) * cols + j) * 4;  // north at the top
        img.data[o] = Math.min(255, c[0] * k);
        img.data[o + 1] = Math.min(255, c[1] * k);
        img.data[o + 2] = Math.min(255, c[2] * k);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { dataUrl: cv.toDataURL('image/png'), lo, hi };
  }

  // ---------- clicks ----------
  map.on('click', (e) => {
    if (mode === 'point') readPoint(e.latlng);
    else if (mode === 'profile') addProfilePoint(e.latlng);
    else areaClick(e.latlng);
  });
  map.on('dblclick', () => { if (mode === 'profile') showProfile(); });

  // ---------- layers ----------
  function toggle(id, layer) {
    $(id).addEventListener('change', (e) => { if (e.target.checked) layer.addTo(map); else layer.remove(); });
  }
  toggle('#lay-pieces', overlays.pieces);
  toggle('#lay-terrain', overlays.terrain);

  async function start() {
    setMode('point');
    let info, cov;
    try {
      [info, cov] = await Promise.all([api('/api/info'), api('/api/elevation/coverage')]);
    } catch (e) {
      msg(`The tools service is not answering: ${e.message}`, true);
      return;
    }
    const sel = $('#base');
    const sets = cov.tilesets.filter((t) => !t.error);
    sel.innerHTML = sets.length
      ? sets.map((t) => `<option value="${esc(t.name)}">${esc(t.name)} (zoom ${esc(t.minzoom)}–${esc(t.maxzoom)})</option>`).join('') + '<option value="">None</option>'
      : '<option value="">No imagery in data/mbtiles</option>';
    const pick = sets.find((t) => t.name === 'custom') || sets[0];
    if (pick) sel.value = pick.name;
    const setBase = () => {
      if (base) { base.remove(); base = null; }
      const t = sets.find((x) => x.name === sel.value);
      if (!t) return;
      const opts = { maxNativeZoom: Number(t.maxzoom) || 18, minNativeZoom: 0, maxZoom: 20 };
      if (t.bounds && t.bounds.length === 4) opts.bounds = L.latLngBounds([[t.bounds[1], t.bounds[0]], [t.bounds[3], t.bounds[2]]]);
      base = L.tileLayer(`http://${HOST}:${info.ports.mbtiles}/services/${encodeURIComponent(t.name)}/tiles/{z}/{x}/{y}.png`, opts).addTo(map);
      base.bringToBack();
    };
    sel.addEventListener('change', setBase);
    setBase();

    const all = [];
    for (const p of cov.pieces) {
      const b = [[p.bounds[1], p.bounds[0]], [p.bounds[3], p.bounds[2]]];
      L.rectangle(b, { color: ACCENT, weight: 1.2, dashArray: '6 5', fillOpacity: 0.02, interactive: false }).addTo(overlays.pieces);
      all.push(...b);
    }
    if (cov.terrain && cov.terrain.bounds) {
      const t = cov.terrain.bounds;
      const b = [[t[1], t[0]], [t[3], t[2]]];
      L.rectangle(b, { color: '#2E7D4F', weight: 1.5, dashArray: '3 4', fill: false, interactive: false }).addTo(overlays.terrain);
      all.push(...b);
    }
    if (!all.length && pick && pick.bounds) all.push([pick.bounds[1], pick.bounds[0]], [pick.bounds[3], pick.bounds[2]]);
    if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [20, 20] });
    if (!cov.pieces.length) msg('No elevation pieces are indexed yet: build them on the tools page, then restart the elevation server.', true);
  }
  start();
}());
