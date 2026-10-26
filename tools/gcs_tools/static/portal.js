'use strict';
// Front page: fill in links to the other servers (they run on their own ports)
// and show whether each one answers.

(function () {
  const HOST = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const size = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  };
  const date = (t) => new Date(t * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

  async function get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }

  function setState(el, up, upText, downText) {
    if (!el) return;
    el.textContent = up ? upText : downText;
    el.classList.toggle('st-ok', up);
    el.classList.toggle('st-fail', !up);
  }

  async function start() {
    let info;
    try { info = await get('/api/info'); } catch {
      document.getElementById('summary').textContent = 'The tools service is not answering.';
      return;
    }
    const url = (svc, path) => `http://${HOST}:${info.ports[svc]}${path}`;
    document.getElementById('host').textContent = location.hostname;
    document.querySelector('[data-app="logviewer"]').href = url('logviewer', '/');
    document.querySelector('[data-app="webtools"]').href = url('webtools', '/');
    document.querySelector('[data-app="tilemap"]').href = url('mbtiles', '/services');

    const [status, data] = await Promise.all([get('/api/status').catch(() => null), get('/api/data').catch(() => null)]);

    if (status) {
      const names = { logviewer: 'Log viewer', webtools: 'WebTools', mbtiles: 'Tile server', terrain: 'Terrain', elevation: 'Elevation API' };
      for (const svc of Object.keys(names)) {
        const st = status[svc] || {};
        let up = `Running on port ${info.ports[svc]}`;
        if (svc === 'mbtiles' && st.tilesets) {
          up = st.tilesets.length ? `Running, ${st.tilesets.join(', ')}` : 'Running, but no tile sets loaded';
          const set = st.tilesets.includes('custom') ? 'custom' : st.tilesets[0];
          if (set) document.querySelector('[data-app="tilemap"]').href = url('mbtiles', `/services/${encodeURIComponent(set)}/map`);
        }
        if (st.up && !st.ok) up = { terrain: 'Running, no terrain in data/terrain yet' }[svc] || `Running, but answered HTTP ${st.code}`;
        const el = document.querySelector(`[data-state="${svc}"]`);
        setState(el, st.up, up, 'Not reachable');
        if (el && st.up && !st.ok) el.classList.replace('st-ok', 'st-warn');
      }
      const down = Object.keys(names).filter((s) => !(status[s] || {}).up);
      const total = Object.keys(names).length;
      const summary = document.getElementById('summary');
      summary.textContent = down.length ? `Not reachable: ${down.map((s) => names[s]).join(', ')}` : `All ${total} servers are up`;
      summary.className = `summary ${down.length ? 'st-fail' : 'st-ok'}`;
      setState(document.getElementById('health-state'), !down.length,
        `${total} of ${total} servers up. Open for a full check.`, `${total - down.length} of ${total} servers up. Open for details.`);
    }

    if (data) {
      const put = (key, text) => { const el = document.querySelector(`[data-data="${key}"]`); if (el) el.textContent = text; };
      const m = data.mbtiles.find((x) => x.name === 'custom') || data.mbtiles[0];
      put('mbtiles', m ? `Now: ${m.name}.mbtiles, zoom ${m.minzoom}–${m.maxzoom}, ${size(m.size)}` : 'Now: no .mbtiles yet');
      const t = data.terrain;
      put('terrain', t && !t.error ? `Now: levels 0–${t.levels - 1}, built ${date(t.mtime)}` : 'Now: no terrain yet');
      const e = data.elevation;
      put('elevation', e && e.files ? `Now: ${plural(e.files, 'piece', 'pieces')}, ${size(e.size)}` : 'Now: no pieces yet');
      put('src', `${plural(data.src.length, 'file', 'files')} in data/src, ${size(data.disk.free)} free`);
    }
  }

  start();
}());
