/* Geodesy for the 3D view: WGS84 ellipsoid or sphere, a local scene frame (x east, y up, z south),
   web-mercator tile maths and EGM96 geoid heights from a 1-degree grid (bilinear, ~0.1 m median error). */
const GEO = (() => {
  'use strict';
  const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), RS = 6371008.8, D2R = Math.PI / 180;
  const GEOID_B64 = '__GEOID_B64__';
  let grid = null;
  function geoidN(lat, lon) {
    if (!grid) {
      const bin = atob(GEOID_B64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      grid = new Int16Array(u8.buffer);
    }
    const rows = 181, cols = 361;
    lon = ((lon % 360) + 360) % 360;
    const y = 90 - Math.max(-90, Math.min(90, lat)), x = lon;
    const r0 = Math.min(rows - 2, Math.floor(y)), c0 = Math.min(cols - 2, Math.floor(x)), fy = y - r0, fx = x - c0;
    const g = (r, c) => grid[r * cols + c];
    return (g(r0, c0) * (1 - fx) * (1 - fy) + g(r0, c0 + 1) * fx * (1 - fy) + g(r0 + 1, c0) * (1 - fx) * fy + g(r0 + 1, c0 + 1) * fx * fy) / 100;
  }
  function ecef(lat, lon, h, sphere, out) {
    const la = lat * D2R, lo = lon * D2R, cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
    if (sphere) { const r = RS + h; out[0] = r * cl * co; out[1] = r * cl * so; out[2] = r * sl; }
    else { const N = A / Math.sqrt(1 - E2 * sl * sl); out[0] = (N + h) * cl * co; out[1] = (N + h) * cl * so; out[2] = (N * (1 - E2) + h) * sl; }
    return out;
  }
  /** Local frame at (lat0, lon0): scene x = east, y = up, z = south, metres. */
  function frame(lat0, lon0, sphere) {
    const o = ecef(lat0, lon0, 0, sphere, [0, 0, 0]);
    const la = lat0 * D2R, lo = lon0 * D2R;
    const e = [-Math.sin(lo), Math.cos(lo), 0];
    const n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const t = [0, 0, 0];
    const rot = (dx, dy, dz, out, k) => {
      out[k] = e[0] * dx + e[1] * dy + e[2] * dz;
      out[k + 1] = u[0] * dx + u[1] * dy + u[2] * dz;
      out[k + 2] = -(n[0] * dx + n[1] * dy + n[2] * dz);
    };
    return {
      lat0, lon0, sphere,
      /** Write the scene position of (lat, lon, height) into out[k..k+2]. */
      toScene(lat, lon, h, out, k = 0) { ecef(lat, lon, h, sphere, t); rot(t[0] - o[0], t[1] - o[1], t[2] - o[2], out, k); return out; },
      /** Latitude, longitude and height of a scene point. */
      fromScene(x, y, z) {
        const X = o[0] + e[0] * x + u[0] * y - n[0] * z, Y = o[1] + e[1] * x + u[1] * y - n[1] * z, Z = o[2] + e[2] * x + u[2] * y - n[2] * z;
        const p = Math.hypot(X, Y), lon = Math.atan2(Y, X) / D2R;
        if (sphere) { const r = Math.hypot(p, Z); return { lat: Math.asin(Z / r) / D2R, lon, h: r - RS }; }
        let lat = Math.atan2(Z, p * (1 - E2)), h = 0;
        for (let i = 0; i < 5; i++) { const sl = Math.sin(lat), N = A / Math.sqrt(1 - E2 * sl * sl); h = p / Math.cos(lat) - N; lat = Math.atan2(Z, p * (1 - E2 * N / (N + h))); }
        return { lat: lat / D2R, lon, h };
      },
      /** Rotate an ECEF direction into scene axes. */
      dir(dx, dy, dz, out, k = 0) { rot(dx, dy, dz, out, k); return out; },
      /** East, north and up unit vectors at (lat, lon) in scene axes. */
      enu(lat, lon) {
        const a = lat * D2R, b = lon * D2R, E = [0, 0, 0], N = [0, 0, 0], U = [0, 0, 0];
        rot(-Math.sin(b), Math.cos(b), 0, E, 0);
        rot(-Math.sin(a) * Math.cos(b), -Math.sin(a) * Math.sin(b), Math.cos(a), N, 0);
        rot(Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a), U, 0);
        return { E, N, U };
      }
    };
  }
  const merc = {
    x: (lon, z) => (lon + 180) / 360 * Math.pow(2, z),
    y: (lat, z) => { const l = Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R; return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 * Math.pow(2, z); },
    lon: (x, z) => x / Math.pow(2, z) * 360 - 180,
    lat: (y, z) => { const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return Math.atan(Math.sinh(n)) / D2R; }
  };
  /** Metres per degree of latitude and longitude near lat. */
  function mPerDeg(lat) { const l = lat * D2R; return { lat: 111132.92 - 559.82 * Math.cos(2 * l), lon: 111412.84 * Math.cos(l) - 93.5 * Math.cos(3 * l) }; }
  return { geoidN, ecef, frame, merc, mPerDeg, A, RS, D2R };
})();
