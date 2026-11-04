/* DataFlash reader. Streams the .bin once, a chunk at a time, and keeps every numeric column
   of every (message type, instance) as typed arrays, plus parameters, text messages, modes and arming. */
const DF = (() => {
  'use strict';
  const H1 = 0xA3, H2 = 0x95;
  const SZ = { a: 64, b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4, d: 8, n: 4, N: 16, Z: 64, c: 2, C: 2, e: 4, E: 4, L: 4, M: 1, q: 8, Q: 8, g: 2 };
  const NUMERIC = 'bBhHiIfdcCeELMqQg';
  const WIDE = 'dLiIeEqQ'; // kept as Float64 so latitude, GPS ms and large counters stay exact
  const INST1 = 'bBM';
  const SPECIAL = { FMT: 1, FMTU: 2, UNIT: 3, MSG: 4, MODE: 5, ARM: 6, EV: 7, ERR: 8, PARM: 9, VER: 10 };
  const UNIT_ALIAS = { degheading: 'deg', deglatitude: 'deg', deglongitude: 'deg', instance: '', 'm/s/s': 'm/s²', 'deg/s/s': 'deg/s²' };

  const MODE_NAMES = {
    copter: { 0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT', 13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE', 18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL', 22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID', 26: 'AUTOROTATE', 27: 'AUTO_RTL', 28: 'TURTLE' },
    plane: { 0: 'MANUAL', 1: 'CIRCLE', 2: 'STABILIZE', 3: 'TRAINING', 4: 'ACRO', 5: 'FBWA', 6: 'FBWB', 7: 'CRUISE', 8: 'AUTOTUNE', 10: 'AUTO', 11: 'RTL', 12: 'LOITER', 13: 'TAKEOFF', 14: 'AVOID_ADSB', 15: 'GUIDED', 17: 'QSTABILIZE', 18: 'QHOVER', 19: 'QLOITER', 20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE', 23: 'QACRO', 24: 'THERMAL', 25: 'LOITER_ALT_QLAND', 26: 'AUTOLAND' },
    rover: { 0: 'MANUAL', 1: 'ACRO', 3: 'STEERING', 4: 'HOLD', 5: 'LOITER', 6: 'FOLLOW', 7: 'SIMPLE', 8: 'DOCK', 9: 'CIRCLE', 10: 'AUTO', 11: 'RTL', 12: 'SMART_RTL', 15: 'GUIDED', 16: 'INITIALISING' },
    sub: { 0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 7: 'CIRCLE', 9: 'SURFACE', 16: 'POSHOLD', 19: 'MANUAL', 20: 'MOTOR_DETECT', 21: 'SURFTRAK' }
  };
  const ERR_SUBSYS = { 1: 'Main', 2: 'Radio', 3: 'Compass', 5: 'Radio failsafe', 6: 'Battery failsafe', 7: 'GPS failsafe', 8: 'GCS failsafe', 9: 'Fence failsafe', 10: 'Flight mode', 11: 'GPS', 12: 'Crash check', 13: 'Flip', 14: 'Autotune', 15: 'Parachute', 16: 'EKF check', 17: 'EKF failsafe', 18: 'Barometer', 19: 'CPU', 20: 'ADSB failsafe', 21: 'Terrain', 22: 'Navigation', 23: 'Terrain failsafe', 24: 'EKF primary', 25: 'Thrust loss', 26: 'Sensor failsafe', 27: 'Leak failsafe', 28: 'Pilot input', 29: 'Vibration failsafe', 30: 'Internal error', 31: 'Dead reckoning failsafe' };

  function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  function readNum(dv, o, ch) {
    switch (ch) {
      case 'b': return dv.getInt8(o);
      case 'B': case 'M': return dv.getUint8(o);
      case 'h': return dv.getInt16(o, true);
      case 'H': return dv.getUint16(o, true);
      case 'i': return dv.getInt32(o, true);
      case 'I': return dv.getUint32(o, true);
      case 'f': return dv.getFloat32(o, true);
      case 'd': return dv.getFloat64(o, true);
      case 'c': return dv.getInt16(o, true) * 0.01;
      case 'C': return dv.getUint16(o, true) * 0.01;
      case 'e': return dv.getInt32(o, true) * 0.01;
      case 'E': return dv.getUint32(o, true) * 0.01;
      case 'L': return dv.getInt32(o, true) * 1e-7;
      case 'q': return dv.getInt32(o + 4, true) * 4294967296 + dv.getUint32(o, true);
      case 'Q': return dv.getUint32(o + 4, true) * 4294967296 + dv.getUint32(o, true);
      case 'g': return halfToFloat(dv.getUint16(o, true));
    }
    return NaN;
  }
  function readStr(buf, o, n) {
    let s = '';
    for (let i = 0; i < n; i++) { const c = buf[o + i]; if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  function numCols(f) {
    const out = [];
    for (let i = 0; i < f.ch.length; i++) {
      const c = f.cols[i];
      if (NUMERIC.includes(f.ch[i]) && c !== 'TimeUS' && c !== 'TimeMS' && c !== undefined && i !== f.instCol) out.push(i);
    }
    return out;
  }
  function makeFmt(type, len, name, format, columns) {
    const cols = columns ? columns.split(',') : [];
    const f = { type, len, name, format, cols, off: [], ch: [], idx: Object.create(null), valid: true,
      timeOff: -1, timeKind: 0, instOff: -1, instCh: '', instCol: -1, units: '', num: [], streams: new Map(), stream: null,
      special: SPECIAL[name] || 0 };
    let o = 3;
    for (let i = 0; i < format.length; i++) {
      const ch = format[i], s = SZ[ch];
      if (s === undefined) { f.valid = false; break; }
      f.off.push(o); f.ch.push(ch);
      if (i < cols.length) f.idx[cols[i]] = i;
      o += s;
    }
    if (f.valid && o > len) f.valid = false;
    if (!f.valid) return f;
    const ti = f.idx.TimeUS;
    if (ti !== undefined && (f.ch[ti] === 'Q' || f.ch[ti] === 'q')) { f.timeOff = f.off[ti]; f.timeKind = 0; }
    else if (f.idx.TimeMS !== undefined && (f.ch[f.idx.TimeMS] === 'I' || f.ch[f.idx.TimeMS] === 'i')) { f.timeOff = f.off[f.idx.TimeMS]; f.timeKind = 1; }
    for (const nm of ['I', 'Instance', 'Inst', 'C', 'IMU']) {
      const i = f.idx[nm];
      if (i !== undefined && INST1.includes(f.ch[i])) { setInst(f, i); break; }
    }
    f.num = numCols(f);
    return f;
  }
  function setInst(f, i) {
    if (i < 0) { f.instOff = -1; f.instCh = ''; f.instCol = -1; }
    else { f.instOff = f.off[i]; f.instCh = f.ch[i]; f.instCol = i; }
    f.num = numCols(f);
  }
  function colVal(f, buf, dv, p, name) {
    const i = f.idx[name];
    if (i === undefined) return undefined;
    const ch = f.ch[i];
    if (ch === 'n') return readStr(buf, p + f.off[i], 4);
    if (ch === 'N') return readStr(buf, p + f.off[i], 16);
    if (ch === 'Z') return readStr(buf, p + f.off[i], 64);
    if (ch === 'a') return '';
    return readNum(dv, p + f.off[i], ch);
  }

  function grow(arr, n) { const a = new arr.constructor(n); a.set(arr); return a; }
  function newStream(ix, f, inst) {
    const cap = 256;
    const s = { f, name: f.name, inst, n: 0, cap, next: -Infinity, last: -Infinity, t: new Float64Array(cap),
      v: f.num.map(i => WIDE.includes(f.ch[i]) ? new Float64Array(cap) : new Float32Array(cap)) };
    if (inst >= 0) f.streams.set(inst, s); else f.stream = s;
    ix.streams.push(s);
    return s;
  }
  function addSample(s, dv, p, t) {
    if (t < s.last) return false;
    s.last = t;
    if (s.n === s.cap) {
      s.cap *= 2; s.t = grow(s.t, s.cap);
      for (let k = 0; k < s.v.length; k++) s.v[k] = grow(s.v[k], s.cap);
    }
    const f = s.f, num = f.num;
    s.t[s.n] = t;
    for (let k = 0; k < num.length; k++) { const i = num[k]; s.v[k][s.n] = readNum(dv, p + f.off[i], f.ch[i]); }
    s.n++;
    return true;
  }

  function vehicleFrom(text) {
    const m = /\b(ArduCopter|ArduHeli|ArduPlane|ArduRover|APMrover2|ArduSub|AntennaTracker|Blimp)\b/i.exec(text);
    if (!m) return '';
    const v = m[1].toLowerCase();
    if (v.includes('copter') || v.includes('heli')) return 'copter';
    if (v.includes('plane')) return 'plane';
    if (v.includes('rover')) return 'rover';
    if (v.includes('sub')) return 'sub';
    if (v.includes('tracker')) return 'tracker';
    return 'blimp';
  }

  function handleSpecial(ix, f, buf, dv, p, t) {
    if (!f.valid) return;
    switch (f.special) {
      case 1: { // FMT
        const ty = buf[p + 3], len = buf[p + 4];
        const name = readStr(buf, p + 5, 4), format = readStr(buf, p + 9, 16), cols = readStr(buf, p + 25, 64);
        const old = ix.fmts[ty];
        if (old && old.name === name && old.format === format && old.len === len) return;
        if (ty === 128 && len !== 89) return;
        if (old && (old.streams.size || old.stream)) return; // keep the format that data was already read with
        ix.fmts[ty] = makeFmt(ty, len, name, format, cols);
        return;
      }
      case 2: { // FMTU: '#' in the unit string marks the instance column
        const ty = colVal(f, buf, dv, p, 'FmtType'), units = colVal(f, buf, dv, p, 'UnitIds');
        const tf = ix.fmts[ty];
        if (!tf || !tf.valid || typeof units !== 'string') return;
        tf.units = units;
        if (tf.streams.size || tf.stream) return;
        const hash = units.indexOf('#');
        if (hash >= 0 && hash < tf.ch.length && INST1.includes(tf.ch[hash])) setInst(tf, hash);
        else if (tf.instCol >= 0) setInst(tf, -1);
        return;
      }
      case 3: { const id = colVal(f, buf, dv, p, 'Id'), lab = colVal(f, buf, dv, p, 'Label'); if (typeof id === 'number') ix.units[String.fromCharCode(id)] = lab; return; }
      case 4: {
        const text = colVal(f, buf, dv, p, 'Message') || '';
        if (ix.texts.length < 50000) ix.texts.push({ t, text });
        if (!ix.firmware) { const v = vehicleFrom(text); if (v) { ix.vehicle = v; ix.firmware = text; } }
        if (!ix.frame && /^Frame:/.test(text)) ix.frame = text.replace(/^Frame:\s*/, '');
        return;
      }
      case 5: ix.modes.push({ t, mode: colVal(f, buf, dv, p, 'Mode'), rsn: colVal(f, buf, dv, p, 'Rsn') }); return;
      case 6: ix.arms.push({ t, armed: colVal(f, buf, dv, p, 'ArmState') !== 0 }); return;
      case 7: { const id = colVal(f, buf, dv, p, 'Id'); if (id === 10 || id === 11) ix.evArms.push({ t, armed: id === 10 }); return; }
      case 8: if (ix.errs.length < 20000) ix.errs.push({ t, sub: colVal(f, buf, dv, p, 'Subsys'), code: colVal(f, buf, dv, p, 'ECode') }); return;
      case 9: { // PARM
        const name = colVal(f, buf, dv, p, 'Name'), val = colVal(f, buf, dv, p, 'Value');
        if (typeof name !== 'string' || !name || typeof val !== 'number') return;
        let rec = ix.params.get(name);
        if (!rec) { rec = { name, t: [], v: [], def: colVal(f, buf, dv, p, 'Default') }; ix.params.set(name, rec); }
        if (!rec.v.length || rec.v[rec.v.length - 1] !== val) { rec.t.push(t); rec.v.push(val); }
        return;
      }
      case 10: { // VER
        const fws = colVal(f, buf, dv, p, 'FWS');
        if (typeof fws === 'string' && fws && !ix.firmware) { const v = vehicleFrom(fws); if (v) { ix.vehicle = v; ix.firmware = fws; } }
        return;
      }
    }
  }

  /**
   * Read the whole file once. opt.maxHz limits how many samples per second are kept for each
   * message stream (0 keeps every sample). Returns an index of streams, fields, params and events.
   */
  async function scan(file, opt = {}) {
    const sampleUs = opt.maxHz ? 1e6 / opt.maxHz : 0;
    const CH = opt.chunk || (16 << 20), OV = 1024;
    const size = file.size;
    const fmts = new Array(256).fill(null);
    fmts[128] = makeFmt(128, 89, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns');
    const ix = {
      file, name: file.name || 'log.bin', size, fmts, counts: new Float64Array(256), nMsgs: 0, bad: 0, samples: 0,
      streams: [], modes: [], arms: [], evArms: [], texts: [], errs: [], params: new Map(), units: Object.create(null),
      tMin: Infinity, tMax: -Infinity, firmware: '', vehicle: '', frame: '', maxHz: opt.maxHz || 0, seconds: 0
    };
    let tGood = -1, candT = -1, candType = -1, inSync = true;
    const started = Date.now();
    let pos = 0;
    while (pos < size) {
      if (opt.isCancelled && opt.isCancelled()) throw new Error('cancelled');
      const end = Math.min(size, pos + CH + OV);
      const ab = await file.slice(pos, end).arrayBuffer();
      const buf = new Uint8Array(ab), dv = new DataView(ab), n = buf.length;
      const atEOF = end === size;
      const lim = atEOF ? n : CH;
      const relaxFrom = atEOF ? n - 1024 : Infinity;
      let p = 0, syncEnd = inSync ? 0 : -1;
      while (p < lim) {
        if (buf[p] !== H1 || buf[p + 1] !== H2) {
          let q = buf.indexOf(H1, p + 1);
          if (q < 0 || q > lim) q = lim;
          ix.bad += q - p; p = q; continue;
        }
        const typ = buf[p + 2];
        const f = fmts[typ];
        if (f === null) { ix.bad++; p++; continue; }
        const L = f.len;
        if (L < 3) { ix.bad++; p++; continue; }
        if (p + L > n) { ix.bad += n - p; p = n; break; }
        if (p !== syncEnd && p + L + 1 < n && (buf[p + L] !== H1 || buf[p + L + 1] !== H2) && p < relaxFrom) { ix.bad++; p++; continue; }
        syncEnd = p + L;
        ix.counts[typ]++;
        let t = -1;
        if (f.timeOff >= 0 && f.valid) {
          const o = p + f.timeOff;
          t = f.timeKind === 0 ? dv.getUint32(o + 4, true) * 4294967296 + dv.getUint32(o, true) : dv.getUint32(o, true) * 1000;
          // A big forward jump must be confirmed by a different message type before the time base follows it.
          if (tGood < 0) { if (t > 1e13) t = -1; else tGood = t; }
          else if (t < tGood - 60e6) t = -1;
          else if (t > tGood + 60e6) {
            if (candT >= 0 && typ !== candType && Math.abs(t - candT) < 60e6) { tGood = Math.max(t, candT); candT = -1; }
            else { candT = t; candType = typ; t = -1; }
          } else { if (t > tGood) tGood = t; candT = -1; }
          if (t >= 0) { if (t < ix.tMin) ix.tMin = t; if (t > ix.tMax) ix.tMax = t; }
        }
        if (f.special !== 0) handleSpecial(ix, f, buf, dv, p, t);
        if (t >= 0 && f.valid && f.num.length !== 0) {
          let s;
          if (f.instOff >= 0) {
            const raw = buf[p + f.instOff], iv = f.instCh === 'b' ? (raw << 24) >> 24 : raw;
            s = f.streams.get(iv);
            if (s === undefined) s = newStream(ix, f, iv);
          } else s = f.stream || newStream(ix, f, -1);
          if (sampleUs === 0) { if (addSample(s, dv, p, t)) ix.samples++; }
          else if (t >= s.next) { s.next = t + sampleUs; if (addSample(s, dv, p, t)) ix.samples++; }
        }
        p += L;
      }
      inSync = p === syncEnd;
      pos += p;
      if (opt.onProgress) opt.onProgress(pos / size, ix);
    }
    for (let i = 0; i < 256; i++) ix.nMsgs += ix.counts[i];
    if (!isFinite(ix.tMin)) { ix.tMin = 0; ix.tMax = 0; }
    ix.seconds = (Date.now() - started) / 1000;
    finalize(ix);
    return ix;
  }

  function unitLabel(ix, f, ci) {
    const uch = f.units ? f.units[ci] : '';
    if (!uch || uch === '-' || uch === '#' || uch === '?') return '';
    let lab = ix.units[uch];
    if (lab === undefined) return '';
    if (Object.prototype.hasOwnProperty.call(UNIT_ALIAS, lab)) lab = UNIT_ALIAS[lab];
    return lab;
  }

  function finalize(ix) {
    const src = ix.arms.length ? ix.arms : ix.evArms;
    const iv = []; let cur = null;
    for (const e of src) {
      if (e.t < 0) continue;
      if (e.armed && !cur) cur = { t0: e.t, t1: ix.tMax };
      else if (!e.armed && cur) { cur.t1 = e.t; iv.push(cur); cur = null; }
    }
    if (cur) iv.push(cur);
    ix.armed = iv;
    const modes = ix.modes.filter(m => m.t >= 0);
    ix.modes = modes;
    ix.modeSpans = modes.map((m, i) => ({ t0: m.t, t1: i + 1 < modes.length ? modes[i + 1].t : ix.tMax, mode: m.mode }));
    ix.texts = ix.texts.filter(m => m.t >= 0);
    ix.errs = ix.errs.filter(m => m.t >= 0);
    for (const p of ix.params.values()) {
      for (let i = 0; i < p.t.length; i++) if (!(p.t[i] >= ix.tMin)) p.t[i] = ix.tMin;
      p.t[0] = Math.min(p.t[0], ix.tMin);
    }
    // trim stream buffers
    for (const s of ix.streams) {
      s.t = s.t.subarray(0, s.n);
      s.v = s.v.map(a => a.subarray(0, s.n));
    }
    const byType = new Map();
    for (const s of ix.streams) {
      if (!s.n) continue;
      let g = byType.get(s.f);
      if (!g) { g = []; byType.set(s.f, g); }
      g.push(s);
    }
    ix.types = [];
    ix.fieldIndex = new Map();
    ix.fieldLower = new Map();
    ix.fieldIds = [];
    const reg = (key, fld) => { if (!ix.fieldIndex.has(key)) ix.fieldIndex.set(key, fld); const lk = key.toLowerCase(); if (!ix.fieldLower.has(lk)) ix.fieldLower.set(lk, fld); };
    for (const [f, list] of byType) {
      list.sort((a, b) => a.inst - b.inst);
      const multi = list.length > 1;
      let count = 0, hz = 0;
      for (const s of list) {
        count += s.n;
        const span = (s.t[s.n - 1] - s.t[0]) / 1e6;
        hz = Math.max(hz, span > 0 ? (s.n - 1) / span : 0);
      }
      const ty = { name: f.name, type: f.type, multi, insts: list.map(s => s.inst), count, hz, cols: [] };
      f.num.forEach((ci, k) => {
        const col = f.cols[ci], unit = unitLabel(ix, f, ci);
        ty.cols.push({ col, unit });
        list.forEach((s, si) => {
          const id = multi ? `${f.name}[${s.inst}].${col}` : `${f.name}.${col}`;
          const fld = { id, msg: f.name, inst: s.inst, col, unit, series: { t: s.t, v: s.v[k], unit, step: false, name: id } };
          reg(id, fld);
          if (s.inst >= 0) reg(`${f.name}[${s.inst}].${col}`, fld);
          if (si === 0) reg(`${f.name}.${col}`, fld);
          ix.fieldIds.push({ id, unit, hz: s.n > 1 ? (s.n - 1) / ((s.t[s.n - 1] - s.t[0]) / 1e6 || 1) : 0 });
        });
      });
      ix.types.push(ty);
    }
    ix.types.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    ix.fieldIds.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function modeName(ix, m) {
    const tbl = MODE_NAMES[ix && ix.vehicle];
    return (tbl && tbl[m] !== undefined) ? tbl[m] : 'Mode ' + m;
  }
  function modeNumber(ix, name) {
    const tbl = MODE_NAMES[ix && ix.vehicle];
    if (!tbl) return undefined;
    const up = String(name).toUpperCase();
    for (const k in tbl) if (tbl[k] === up) return Number(k);
    return undefined;
  }

  /** Synthetic ArduCopter log with two flights, so the page opens in a working state. */
  function demoLog() {
    let cap = 1 << 24, buf = new Uint8Array(cap), dv = new DataView(buf.buffer), n = 0;
    const ensure = k => { if (n + k > cap) { cap *= 2; const nb = new Uint8Array(cap); nb.set(buf); buf = nb; dv = new DataView(buf.buffer); } };
    const put = (ch, v) => {
      switch (ch) {
        case 'b': dv.setInt8(n, v); n += 1; break;
        case 'B': case 'M': dv.setUint8(n, v); n += 1; break;
        case 'h': dv.setInt16(n, v, true); n += 2; break;
        case 'H': dv.setUint16(n, v, true); n += 2; break;
        case 'i': dv.setInt32(n, v, true); n += 4; break;
        case 'I': dv.setUint32(n, v >>> 0, true); n += 4; break;
        case 'f': dv.setFloat32(n, v, true); n += 4; break;
        case 'd': dv.setFloat64(n, v, true); n += 8; break;
        case 'c': dv.setInt16(n, Math.round(v * 100), true); n += 2; break;
        case 'C': dv.setUint16(n, Math.round(v * 100), true); n += 2; break;
        case 'e': dv.setInt32(n, Math.round(v * 100), true); n += 4; break;
        case 'L': dv.setInt32(n, Math.round(v * 1e7), true); n += 4; break;
        case 'Q': case 'q': dv.setUint32(n, v % 4294967296, true); dv.setUint32(n + 4, Math.floor(v / 4294967296), true); n += 8; break;
        case 'n': case 'N': case 'Z': { const sz = SZ[ch]; for (let i = 0; i < sz; i++) buf[n + i] = i < v.length ? v.charCodeAt(i) : 0; n += sz; break; }
      }
    };
    const defs = Object.create(null);
    let T = 0;
    const D = (type, name, fmt, cols, units) => { let len = 3; for (const c of fmt) len += SZ[c]; defs[name] = { type, name, fmt, cols, units, len, done: false }; };
    const W = (name, vals) => {
      const d = defs[name];
      if (!d.done) {
        d.done = true;
        if (name !== 'FMT') W('FMT', [d.type, d.len, d.name, d.fmt, d.cols]);
        if (d.units && name !== 'FMTU') W('FMTU', [d.type, d.units, '-'.repeat(d.fmt.length)]);
      }
      ensure(300); buf[n++] = H1; buf[n++] = H2; buf[n++] = d.type;
      const f = d.fmt;
      if (name === 'FMT') { for (let i = 0; i < f.length; i++) put(f[i], vals[i]); return; }
      dv.setUint32(n, T % 4294967296, true); dv.setUint32(n + 4, Math.floor(T / 4294967296), true); n += 8;
      for (let i = 1; i < f.length; i++) put(f[i], vals[i - 1]);
    };
    D(128, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns');
    D(32, 'PARM', 'QNff', 'TimeUS,Name,Value,Default', 's---');
    D(33, 'MSG', 'QZ', 'TimeUS,Message', 's-');
    D(34, 'UNIT', 'QbZ', 'TimeUS,Id,Label', 's--');
    D(35, 'FMTU', 'QBNN', 'TimeUS,FmtType,UnitIds,MultIds', 's---');
    D(36, 'MODE', 'QMBB', 'TimeUS,Mode,ModeNum,Rsn', 's---');
    D(37, 'EV', 'QB', 'TimeUS,Id', 's-');
    D(38, 'ARM', 'QBIBB', 'TimeUS,ArmState,ArmChecks,Forced,Method', 's----');
    D(39, 'ERR', 'QBB', 'TimeUS,Subsys,ECode', 's--');
    D(40, 'CMD', 'QHHHffffLLfB', 'TimeUS,CTot,CNum,CId,Prm1,Prm2,Prm3,Prm4,Lat,Lng,Alt,Frame', 's-------DUm-');
    D(41, 'BARO', 'QBfffcfIffB', 'TimeUS,I,Alt,AltAMSL,Press,Temp,CRt,SMS,Offset,GndTemp,Health', 's#mmPOnsmO-');
    D(42, 'POS', 'QLLfff', 'TimeUS,Lat,Lng,Alt,RelHomeAlt,RelOriginAlt', 'sDUmmm');
    D(43, 'CTUN', 'Qfffffffff', 'TimeUS,ThI,ABst,ThO,ThH,DAlt,Alt,BAlt,DCRt,CRt', 's----mmmnn');
    D(44, 'BAT', 'QBfffffcfB', 'TimeUS,Inst,Volt,VoltR,Curr,CurrTot,EnrgTot,Temp,Res,RemPct', 's#vvAaXOw%');
    D(45, 'GPS', 'QBBIHBcLLeffff', 'TimeUS,I,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,Yaw', 's#-s-S-DUmnhnh');
    D(46, 'ATT', 'QccccCC', 'TimeUS,DesRoll,Roll,DesPitch,Pitch,DesYaw,Yaw', 'sddddhh');
    D(47, 'IMU', 'QBffffff', 'TimeUS,I,GyrX,GyrY,GyrZ,AccX,AccY,AccZ', 's#EEEooo');
    D(48, 'RFND', 'QBfBBb', 'TimeUS,Instance,Dist,Stat,Orient,Quality', 's#m--%');
    D(49, 'VER', 'QBHBBBBIZHBBII', 'TimeUS,BT,BST,Maj,Min,Pat,FWT,GH,FWS,APJ,BU,FV,IMI,ICI', 's-------------');
    D(50, 'RCOU', 'QHHHH', 'TimeUS,C1,C2,C3,C4', 'sYYYY');
    D(51, 'VIBE', 'QBfffI', 'TimeUS,IMU,VibeX,VibeY,VibeZ,Clip', 's#ooo-');
    D(52, 'AHR2', 'QccCfLLffff', 'TimeUS,Roll,Pitch,Yaw,Alt,Lat,Lng,Q1,Q2,Q3,Q4', 'sddhmDU????');
    D(53, 'XKQ', 'QBffff', 'TimeUS,C,Q1,Q2,Q3,Q4', 's#????');
    const quat = (r, p, y) => {
      const k = Math.PI / 360, cr = Math.cos(r * k), sr = Math.sin(r * k), cp = Math.cos(p * k), sp = Math.sin(p * k), cy = Math.cos(y * k), sy = Math.sin(y * k);
      return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
    };
    let ahDrift = [0, 0], gpsLag = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    T = 1.8e6;
    W('FMT', [128, 89, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns']); defs.FMT.done = true;
    for (const [id, lab] of [['s', 's'], ['m', 'm'], ['v', 'V'], ['A', 'A'], ['a', 'Ah'], ['n', 'm/s'], ['O', 'degC'], ['P', 'Pa'], ['%', '%'], ['E', 'rad/s'], ['o', 'm/s/s'], ['d', 'deg'], ['h', 'degheading'], ['D', 'deglatitude'], ['U', 'deglongitude'], ['S', 'satellites'], ['X', 'Wh'], ['w', 'Ohm'], ['Y', 'us'], ['#', 'instance']])
      W('UNIT', [id.charCodeAt(0), lab]);
    const params = { LOG_BITMASK: 655358, LOG_BACKEND_TYPE: 1, LOG_DISARMED: 0, FRAME_CLASS: 1, FRAME_TYPE: 1, INS_LOG_BAT_MASK: 1, INS_HNTCH_ENABLE: 0, INS_GYRO_FILTER: 20, INS_ACCEL_FILTER: 20, ATC_RAT_RLL_P: 0.135, ATC_RAT_RLL_I: 0.135, ATC_RAT_RLL_D: 0.0036, ATC_RAT_PIT_P: 0.135, ATC_RAT_PIT_I: 0.135, ATC_RAT_PIT_D: 0.0036, ATC_RAT_YAW_P: 0.18, MOT_THST_HOVER: 0.31, MOT_SPIN_MIN: 0.15, BATT_MONITOR: 4, BATT_CAPACITY: 5200, BATT_LOW_VOLT: 14.0, FS_THR_ENABLE: 1, RTL_ALT: 3000, WPNAV_SPEED: 800, PILOT_SPEED_UP: 250, EK3_ENABLE: 1, AHRS_EKF_TYPE: 3, GPS_TYPE: 1, ARMING_CHECK: 1, FLTMODE1: 0, FLTMODE2: 2, FLTMODE3: 5, FLTMODE4: 3, FLTMODE5: 6, FLTMODE6: 9 };
    W('MSG', ['ArduCopter V4.7.0-dev (0b6a14b0)']);
    W('MSG', ['ChibiOS: 2025a3b1']);
    W('MSG', ['CubeOrange 00340032 31315118 35353833']);
    W('MSG', ['Frame: QUAD/X']);
    W('VER', [3, 4, 4, 7, 0, 0, 0x0b6a14b0, 'ArduCopter V4.7.0-dev (0b6a14b0)', 140, 0, 0, 0, 0]);
    for (const k in params) W('PARM', [k, params[k], params[k]]);
    const home = [52.2297, 21.0122], mPerLat = 111320, mPerLng = 111320 * Math.cos(home[0] * Math.PI / 180);
    const wpsXY = [[0, 0], [0, 0], [0, 89], [41, 178], [82, 89], [0, 0]];
    wpsXY.forEach((w, i) => W('CMD', [wpsXY.length, i, i === 1 ? 22 : i === 5 ? 20 : 16, 0, 0, 0, 0, home[0] + w[1] / mPerLat, home[1] + w[0] / mPerLng, i === 1 ? 25 : i === 5 ? 0 : 40, 3]));
    W('MODE', [0, 0, 0]);
    const flights = [
      { t0: 62, t1: 318, modes: [[62, 0], [70, 2], [95, 5], [140, 3], [262, 6], [300, 9]], peak: 40 },
      { t0: 420, t1: 655, modes: [[420, 0], [428, 16], [470, 5], [520, 4], [600, 21], [640, 9]], peak: 28 }
    ];
    const paramEvents = [[540, 'ATC_RAT_RLL_P', 0.22], [578, 'ATC_RAT_RLL_P', 0.135]];
    let pe = 0, rllP = 0.135;
    const END = 700, TICK = 4000, dt = TICK / 1e6;
    let fi = 0, armed = false, modeIdx = 0, mode = 0, volt = 16.7, curTot = 0, enrg = 0, clip = 0;
    let px = 0, py = 0, vx = 0, vy = 0, roll = 0, pitch = 0, yaw = 90, rollPrev = 0, pitchPrev = 0, desYaw = 90;
    let wpi = 2, altPrev = 0, ph = 0, ph1 = 1.1, baroDrift = 0, oscEnv = 0, thrF = 0;
    let errDone = 0, wpMsg = -1;
    const altAt = (s, fl) => {
      if (!fl || s < fl.t0 || s > fl.t1) return 0;
      const u = (s - fl.t0) / (fl.t1 - fl.t0);
      const a = fl.peak * Math.min(1, Math.max(0, u - 0.02) * 9) * Math.min(1, (1 - u) * 7) + 3 * Math.sin(s / 7) * (u > 0.12 && u < 0.84 ? 1 : 0);
      return Math.max(0, a);
    };
    for (let step = 0; ; step++) {
      T = 1.8e6 + step * TICK;
      const s = T / 1e6;
      if (s > END) break;
      const fl = flights[fi];
      if (fl && !armed && s >= fl.t0) { armed = true; modeIdx = 0; W('ARM', [1, 0x3ffff, 0, 2]); W('EV', [10]); }
      if (fl && armed && modeIdx < fl.modes.length && s >= fl.modes[modeIdx][0]) {
        mode = fl.modes[modeIdx][1]; W('MODE', [mode, mode, 1]); modeIdx++;
        if (mode === 3) { W('MSG', ['Mission: 1 Takeoff']); wpi = 2; }
        if (mode === 6 && fi === 0) W('MSG', ['Mission complete, changing mode to RTL']);
      }
      if (fl && armed && s >= fl.t1) { armed = false; W('EV', [11]); W('ARM', [0, 0x3ffff, 0, 2]); W('MSG', ['Disarming motors']); fi++; }
      if (pe < paramEvents.length && s >= paramEvents[pe][0]) { const [, nm, val] = paramEvents[pe]; W('PARM', [nm, val, params[nm]]); if (nm === 'ATC_RAT_RLL_P') rllP = val; pe++; }
      if (fi === 1 && !armed && s > 340 && s < 341) { volt = 16.75; curTot = 0; enrg = 0; }

      const alt = altAt(s, flights[Math.min(fi, 1)] && armed ? flights[fi] : null);
      const climb = (alt - altPrev) / dt; altPrev = alt;
      const air = armed && alt > 0.3;
      // horizontal: navigation modes chase a target, pilot modes follow stick input
      let desRoll = 0, desPitch = 0;
      if (air) {
        let tx = null, ty = null;
        if (mode === 3) { const w = wpsXY[wpi]; tx = w[0]; ty = w[1]; if (Math.hypot(tx - px, ty - py) < 3 && wpi < 4) { wpi++; if (wpMsg !== wpi) { wpMsg = wpi; W('MSG', ['Reached command #' + wpi]); } } }
        else if (mode === 6 || mode === 21 || mode === 9) { tx = 0; ty = 0; }
        else if (mode === 4) { tx = 40; ty = -50; }
        if (tx !== null) {
          const ex = tx - px, ey = ty - py, d = Math.hypot(ex, ey), sp = Math.min(8, d * 0.6);
          const tvx = d > 0.01 ? ex / d * sp : 0, tvy = d > 0.01 ? ey / d * sp : 0;
          const ax = clamp((tvx - vx) * 1.2, -3, 3), ay = clamp((tvy - vy) * 1.2, -3, 3);
          desRoll = Math.atan(ax / 9.81) * 57.3; desPitch = -Math.atan(ay / 9.81) * 57.3;
          if (sp > 1) desYaw = (Math.atan2(ex, ey) * 57.3 + 360) % 360;
        } else {
          desRoll = 7 * Math.sin(s / 2.3) * Math.sin(s / 11) + 3 * Math.sin(s / 0.9) * (Math.sin(s / 17) > 0.6 ? 1 : 0);
          desPitch = 6 * Math.sin(s / 3.1 + 1) * Math.sin(s / 13);
        }
      }
      const tau = 0.12;
      roll += (desRoll - roll) * dt / tau; pitch += (desPitch - pitch) * dt / tau;
      const yerr = ((desYaw - yaw + 540) % 360) - 180; yaw = (yaw + clamp(yerr, -1, 1) * 60 * dt + 360) % 360;
      const tuneBad = air && rllP > 0.2;
      oscEnv += ((tuneBad ? 1 : 0) - oscEnv) * dt / 3;
      const osc = 3.2 * oscEnv * Math.sin(2 * Math.PI * 6.5 * s);
      const rollOut = air ? roll + osc + rnd() * 0.35 : rnd() * 0.15;
      const pitchOut = air ? pitch + rnd() * 0.35 : rnd() * 0.15;
      const rollRate = (rollOut - rollPrev) / dt / 57.3, pitchRate = (pitchOut - pitchPrev) / dt / 57.3;
      rollPrev = rollOut; pitchPrev = pitchOut;
      if (air) {
        vx += (9.81 * Math.tan(roll / 57.3) - 0.35 * vx) * dt;
        vy += (-9.81 * Math.tan(pitch / 57.3) - 0.35 * vy) * dt;
      } else { vx *= 0.9; vy *= 0.9; }
      px += vx * dt; py += vy * dt;
      const tiltC = Math.cos(roll / 57.3) * Math.cos(pitch / 57.3);
      const thr = armed ? (air ? clamp(0.31 / tiltC + climb * 0.02 + rnd() * 0.01, 0.15, 0.9) : 0.15) : 0;
      thrF += (thr - thrF) * dt / 0.05;
      const fm = 48 + 40 * (thrF - 0.31);
      ph += 2 * Math.PI * fm * dt; ph1 += 2 * Math.PI * fm * 1.003 * dt;
      const ampV = armed ? (air ? 6 : 2.5) : 0;
      // IMUs at 250 Hz
      for (const [inst, phase, k] of [[0, ph, 1], [1, ph1, 0.85]]) {
        const accZ = -9.81 + k * ampV * (Math.sin(phase) + 0.35 * Math.sin(2 * phase)) + rnd() * 0.25;
        const accX = 0.6 * k * ampV * Math.sin(phase + 1.2) + (air ? -9.81 * Math.sin(pitchOut / 57.3) : 0) + rnd() * 0.15;
        const accY = 0.55 * k * ampV * Math.sin(phase + 2.1) + (air ? 9.81 * Math.sin(rollOut / 57.3) : 0) + rnd() * 0.15;
        W('IMU', [inst, rollRate + 0.03 * ampV * Math.sin(phase) + rnd() * 0.01, pitchRate + 0.03 * ampV * Math.sin(phase + 0.7) + rnd() * 0.01, (armed ? clamp(yerr, -1, 1) * 1.05 : 0) + rnd() * 0.005, accX, accY, accZ]);
      }
      if (step % 10 === 0) {
        W('ATT', [desRoll, rollOut, desPitch, pitchOut, desYaw, yaw]);
        W('XKQ', [0, ...quat(rollOut, pitchOut, yaw)]);
        W('XKQ', [1, ...quat(rollOut + 0.4, pitchOut - 0.3, yaw + 1.5)]);
      }
      if (step % 25 === 0) {
        baroDrift += rnd() * 0.004;
        const ab = alt + rnd() * 0.25;
        W('BARO', [0, ab, 112 + ab, 101325 - ab * 12, 24 + s / 200, climb + rnd() * 0.3, T / 1000, 0, 21, 1]);
        W('BARO', [1, ab + 0.3 + baroDrift + rnd() * 0.2, 112.3 + ab, 101321 - ab * 12, 26 + s / 150, climb + rnd() * 0.3, T / 1000, 0, 21, 1]);
        const lat = home[0] + py / mPerLat, lng = home[1] + px / mPerLng;
        W('POS', [lat, lng, 112 + alt, alt, alt]);
        ahDrift[0] += (Math.sin(s / 23) * 1.5 - ahDrift[0]) * 0.02; ahDrift[1] += (Math.cos(s / 31) * 1.2 - ahDrift[1]) * 0.02;
        const qa = quat(rollOut, pitchOut, yaw);
        W('AHR2', [rollOut, pitchOut, yaw, 112 + alt + ahDrift[0] * 0.5, lat + ahDrift[1] / mPerLat, lng + ahDrift[0] / mPerLng, qa[0], qa[1], qa[2], qa[3]]);
        gpsLag.push([lat, lng, alt]); if (gpsLag.length > 2) gpsLag.shift();
        if (armed) W('CTUN', [0.3, 1, thrF, 0.31, alt + climb * 0.4, alt + rnd() * 0.1, ab, climb, climb + rnd() * 0.15]);
        const curr = armed ? 14 + 10 * clamp(alt / 10, 0, 1) + 0.6 * Math.hypot(roll, pitch) + rnd() * 1.5 : 0.6;
        curTot += curr * 0.1 / 3600; volt = Math.max(13.6, volt - (armed ? 0.00062 : 0.00001));
        const vOut = volt - curr * 0.012 + rnd() * 0.02;
        enrg += vOut * curr * 0.1 / 3600;
        W('BAT', [0, vOut, volt, curr, curTot, enrg, 30 + (armed ? 8 * clamp(s % 300 / 200, 0, 1) : 0), 0.012, Math.max(0, Math.round((volt - 13.6) / 3.1 * 100))]);
        if (fi === 1 && armed) W('RFND', [0, Math.max(0.2, alt / tiltC + rnd() * 0.06), 4, 25, 100]);
        const base = armed ? 1000 + 1000 * thrF : 1000;
        W('RCOU', [Math.round(base - roll * 5 + pitch * 5 + yerr * 0.4), Math.round(base + roll * 5 - pitch * 5 + yerr * 0.4), Math.round(base + roll * 5 + pitch * 5 - yerr * 0.4), Math.round(base - roll * 5 - pitch * 5 - yerr * 0.4)]);
        if (fi === 0 && armed && s > 316.5 && s < 316.7) clip++;
        const vb = ampV * 0.75;
        W('VIBE', [0, vb * 0.6 + Math.abs(rnd()) * 0.8, vb * 0.55 + Math.abs(rnd()) * 0.8, vb + Math.abs(rnd()) * 1.2, clip]);
        W('VIBE', [1, vb * 0.5 + Math.abs(rnd()) * 0.7, vb * 0.5 + Math.abs(rnd()) * 0.7, vb * 0.85 + Math.abs(rnd()), 0]);
      }
      if (step % 50 === 0) {
        const lagged = gpsLag[0] || [home[0] + py / mPerLat, home[1] + px / mPerLng, alt];
        const lat = lagged[0] + rnd() * 0.6 / mPerLat, lng = lagged[1] + rnd() * 0.6 / mPerLng;
        const sp = Math.hypot(vx, vy);
        W('GPS', [0, 6, Math.round(T / 1000) % 604800000, 2350, 18 + Math.round(Math.sin(s / 60) * 2), 0.62 + 0.1 * Math.sin(s / 45), lat, lng, 112 + alt, sp + Math.abs(rnd()) * 0.1, (Math.atan2(vx, vy) * 57.3 + 360) % 360, -climb, 0]);
      }
      if (!errDone && s >= 201.3) { errDone = 1; W('ERR', [16, 2]); W('MSG', ['EKF3 lane switch 1']); }
      if (errDone === 1 && s >= 202) { errDone = 2; W('ERR', [16, 0]); }
    }
    return buf.slice(0, n);
  }

  return { scan, demoLog, modeName, modeNumber, MODE_NAMES, ERR_SUBSYS, readNum, makeFmt };
})();
