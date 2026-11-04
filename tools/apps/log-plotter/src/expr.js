/* Formula engine: parses formulas such as `lowpass(ATT.Roll - ATT.DesRoll, 2)` and evaluates them
   over whole log fields. A value is a plain number or a series {t (µs), v, unit, step, konst}. */
const EX = (() => {
  'use strict';

  class FormulaError extends Error {
    constructor(message, pos, end) { super(message); this.pos = pos; this.end = end === undefined ? pos : end; }
  }

  /* ---------------- lexer ---------------- */
  const REF_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\[\s*\d+\s*\])?\.[A-Za-z_][A-Za-z0-9_]*/y;
  const ID_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
  const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const OPS2 = ['**', '<=', '>=', '==', '!=', '&&', '||'];
  const OPS1 = '+-*/%^(),<>!?:=';

  function lex(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if ((c >= '0' && c <= '9') || c === '.') {
        NUM_RE.lastIndex = i;
        const m = NUM_RE.exec(src);
        if (m) { out.push({ t: 'num', v: parseFloat(m[0]), pos: i, end: i + m[0].length }); i += m[0].length; continue; }
      }
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
        REF_RE.lastIndex = i;
        let m = REF_RE.exec(src);
        if (m) {
          const txt = m[0], dot = txt.lastIndexOf('.'), br = txt.indexOf('[');
          const msg = br >= 0 ? txt.slice(0, br) : txt.slice(0, dot);
          const inst = br >= 0 ? parseInt(txt.slice(br + 1, txt.indexOf(']')), 10) : null;
          out.push({ t: 'ref', msg, inst, col: txt.slice(dot + 1), v: txt, pos: i, end: i + txt.length });
          i += txt.length; continue;
        }
        ID_RE.lastIndex = i;
        m = ID_RE.exec(src);
        out.push({ t: 'id', v: m[0], pos: i, end: i + m[0].length });
        i += m[0].length; continue;
      }
      if (c === '"' || c === "'") {
        const j = src.indexOf(c, i + 1);
        if (j < 0) throw new FormulaError('This text has no closing quote', i, src.length);
        out.push({ t: 'str', v: src.slice(i + 1, j), pos: i, end: j + 1 });
        i = j + 1; continue;
      }
      const two = src.substr(i, 2);
      if (OPS2.includes(two)) { out.push({ t: 'op', v: two === '**' ? '^' : two, pos: i, end: i + 2 }); i += 2; continue; }
      if (OPS1.includes(c)) { out.push({ t: 'op', v: c, pos: i, end: i + 1 }); i++; continue; }
      throw new FormulaError(`“${c}” can't be used in a formula`, i, i + 1);
    }
    out.push({ t: 'eof', pos: src.length, end: src.length });
    return out;
  }

  /* ---------------- parser (Pratt) ---------------- */
  const BP = { '?': [1, 0], '||': [2, 3], '&&': [4, 5], '==': [6, 7], '!=': [6, 7], '<': [8, 9], '>': [8, 9], '<=': [8, 9], '>=': [8, 9], '+': [10, 11], '-': [10, 11], '*': [12, 13], '/': [12, 13], '%': [12, 13], '^': [17, 16] };
  const KW = { and: '&&', or: '||' };
  const UNARY_BP = 15;

  function parse(src) {
    const toks = lex(src);
    let i = 0;
    const peek = () => toks[i];
    const isOp = (tok, v) => tok.t === 'op' && tok.v === v;
    const fail = (tok, msg) => { throw new FormulaError(msg, tok.pos, tok.end); };
    function primary() {
      const tok = toks[i++];
      switch (tok.t) {
        case 'num': return { k: 'num', v: tok.v, pos: tok.pos, end: tok.end };
        case 'str': return { k: 'str', v: tok.v, pos: tok.pos, end: tok.end };
        case 'ref': return { k: 'ref', msg: tok.msg, inst: tok.inst, col: tok.col, text: tok.v, pos: tok.pos, end: tok.end };
        case 'id': {
          if (tok.v === 'not') { const a = expr(UNARY_BP); return { k: 'un', op: '!', a, pos: tok.pos, end: a.end }; }
          if (isOp(peek(), '(')) {
            i++;
            const args = [];
            if (!isOp(peek(), ')')) {
              for (;;) {
                args.push(expr(0));
                const p = peek();
                if (isOp(p, ',')) { i++; continue; }
                if (isOp(p, ')')) break;
                fail(p, p.t === 'eof' ? `Add a ) to close ${tok.v}(` : `Expected a comma or ) inside ${tok.v}( … )`);
              }
            }
            const close = toks[i++];
            return { k: 'call', name: tok.v, args, pos: tok.pos, end: close.end, nameEnd: tok.end };
          }
          return { k: 'id', name: tok.v, pos: tok.pos, end: tok.end };
        }
        case 'op': {
          if (tok.v === '(') {
            const e = expr(0);
            const c = toks[i++];
            if (!isOp(c, ')')) fail(c, c.t === 'eof' ? 'Add a ) to close the bracket' : 'Expected )');
            return e;
          }
          if (tok.v === '-' || tok.v === '+' || tok.v === '!') { const a = expr(UNARY_BP); return { k: 'un', op: tok.v, a, pos: tok.pos, end: a.end }; }
          if (tok.v === ')') fail(tok, 'There is a ) without a matching (');
          if (tok.v === ',') fail(tok, 'A comma only separates the arguments of a function');
          return fail(tok, `Something is missing before “${tok.v}”`);
        }
        case 'eof': return fail(tok, 'The formula ends too early');
      }
      return fail(tok, 'Unexpected input');
    }
    function expr(minBp) {
      let left = primary();
      for (;;) {
        const tok = peek();
        let op = null;
        if (tok.t === 'op') op = tok.v; else if (tok.t === 'id' && KW[tok.v]) op = KW[tok.v];
        if (op === '=') fail(tok, 'Use == to compare. A single = only names a field, at the start: Power = BAT.Volt * BAT.Curr');
        const bp = op && BP[op];
        if (!bp || bp[0] < minBp) break;
        i++;
        if (op === '?') {
          const a = expr(0);
          const c = toks[i++];
          if (!isOp(c, ':')) fail(c, 'A condition needs both parts: condition ? value_if_true : value_if_false');
          const b = expr(1);
          left = { k: 'tern', c: left, a, b, pos: left.pos, end: b.end };
          continue;
        }
        const right = expr(bp[1]);
        left = { k: 'bin', op, a: left, b: right, pos: left.pos, end: right.end, opPos: tok.pos };
      }
      return left;
    }
    if (toks.length === 1) fail(toks[0], 'The formula is empty');
    const ast = expr(0);
    const t = peek();
    if (t.t !== 'eof') {
      if (isOp(t, ')')) fail(t, 'There is a ) without a matching (');
      if (isOp(t, ',')) fail(t, 'A comma only separates the arguments of a function');
      fail(t, `An operator is missing before “${src.slice(t.pos, t.end)}”`);
    }
    return ast;
  }

  /** "Power = BAT.Volt * BAT.Curr" → name "Power", body offset. */
  function splitName(text) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(text);
    if (!m) return { name: '', body: text, offset: 0 };
    return { name: m[1], body: text.slice(m[0].length), offset: m[0].length };
  }

  /* ---------------- series helpers ---------------- */
  let LOG = null;
  const isS = v => typeof v === 'object' && v !== null;
  const DT_CACHE = new WeakMap();
  function medianDt(s) {
    const T = s.t;
    let d = DT_CACHE.get(T);
    if (d !== undefined) return d;
    const n = T.length;
    if (n < 2) d = 1e6;
    else {
      const m = Math.min(n - 1, 4001), step = (n - 1) / m, arr = new Float64Array(m);
      let k = 0;
      for (let j = 0; j < m; j++) { const i = Math.floor(j * step); const v = T[i + 1] - T[i]; if (v > 0) arr[k++] = v; }
      const a = arr.subarray(0, k).sort();
      d = k ? a[k >> 1] : 1e6;
    }
    DT_CACHE.set(T, d);
    return d;
  }
  function gapUs(s) { return Math.max(10 * medianDt(s), 1e6); }
  function lowerBound(T, t, lo = 0, hi = T.length) { while (lo < hi) { const m = (lo + hi) >>> 1; if (T[m] < t) lo = m + 1; else hi = m; } return lo; }
  function upperBound(T, t, lo = 0, hi = T.length) { while (lo < hi) { const m = (lo + hi) >>> 1; if (T[m] <= t) lo = m + 1; else hi = m; } return lo; }
  function konst(value, unit) {
    const a = LOG ? LOG.tMin : 0, b = LOG ? Math.max(LOG.tMax, a + 1) : 1;
    return { t: Float64Array.of(a, b), v: Float64Array.of(value, value), unit: unit || '', step: true, konst: true };
  }
  function resampleTo(s, T) {
    const n = T.length, o = new Float64Array(n);
    if (s.konst) { o.fill(s.v[0]); return o; }
    const st = s.t, sv = s.v, m = st.length;
    if (!m) { o.fill(NaN); return o; }
    let j = 0;
    if (s.step) {
      for (let i = 0; i < n; i++) {
        const t = T[i];
        while (j + 1 < m && st[j + 1] <= t) j++;
        o[i] = t < st[0] ? NaN : sv[j];
      }
      return o;
    }
    const gap = gapUs(s);
    for (let i = 0; i < n; i++) {
      const t = T[i];
      if (t < st[0] || t > st[m - 1]) { o[i] = NaN; continue; }
      while (j + 1 < m && st[j + 1] < t) j++;
      if (j + 1 >= m || st[j] === t) { o[i] = sv[j]; continue; }
      const t0 = st[j], t1 = st[j + 1];
      if (t1 === t) { o[i] = sv[j + 1]; continue; }
      if (t1 - t0 > gap) { o[i] = NaN; continue; }
      o[i] = sv[j] + (sv[j + 1] - sv[j]) * (t - t0) / (t1 - t0);
    }
    return o;
  }
  function mergeTimes(list) {
    const all = [];
    for (const s of list) for (let i = 0; i < s.t.length; i++) all.push(s.t[i]);
    all.sort((a, b) => a - b);
    const out = [];
    for (const t of all) if (!out.length || out[out.length - 1] !== t) out.push(t);
    return Float64Array.from(out);
  }
  /** Bring values onto one timeline: the series with the most samples, others interpolated (held for step series). */
  function align(vals) {
    const ser = vals.filter(isS);
    let base = null;
    for (const v of ser) if (!v.konst && !v.step && (!base || v.t.length > base.t.length)) base = v;
    let T;
    if (base) T = base.t;
    else {
      const steps = ser.filter(v => !v.konst);
      if (steps.length > 1) T = mergeTimes(steps);
      else T = (steps[0] || ser[0]).t;
    }
    let step = true, kon = true;
    const cols = vals.map(v => {
      if (!isS(v)) return v;
      if (!v.step) step = false;
      if (!v.konst) kon = false;
      return v.t === T ? v.v : resampleTo(v, T);
    });
    return { t: T, cols, step, konst: kon };
  }
  const unitOf = (...vals) => { for (const v of vals) if (isS(v) && v.unit) return v.unit; return ''; };
  function map1(x, f, unit) {
    if (!isS(x)) return f(x);
    const v = x.v, n = v.length, o = new Float64Array(n);
    for (let i = 0; i < n; i++) o[i] = f(v[i]);
    return { t: x.t, v: o, unit: unit === undefined ? x.unit : unit, step: x.step, konst: x.konst };
  }
  function map2(a, b, f, unit) {
    if (!isS(a) && !isS(b)) return f(a, b);
    const A = align([a, b]), n = A.t.length, o = new Float64Array(n), ca = A.cols[0], cb = A.cols[1];
    if (typeof ca === 'number') for (let i = 0; i < n; i++) o[i] = f(ca, cb[i]);
    else if (typeof cb === 'number') for (let i = 0; i < n; i++) o[i] = f(ca[i], cb);
    else for (let i = 0; i < n; i++) o[i] = f(ca[i], cb[i]);
    return { t: A.t, v: o, unit: unit === undefined ? unitOf(a, b) : unit, step: A.step, konst: A.konst };
  }
  function mapK(vals, f, unit) {
    if (!vals.some(isS)) return f(vals);
    const A = align(vals), n = A.t.length, o = new Float64Array(n), k = vals.length, tmp = new Array(k);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < k; j++) { const c = A.cols[j]; tmp[j] = typeof c === 'number' ? c : c[i]; }
      o[i] = f(tmp);
    }
    return { t: A.t, v: o, unit: unit === undefined ? unitOf(...vals) : unit, step: A.step, konst: A.konst };
  }
  function out(x, v, unit) { return { t: x.t, v, unit: unit === undefined ? x.unit : unit, step: x.step, konst: false }; }
  const perS = u => u ? (u.endsWith('·s') ? u.slice(0, -2) : u + '/s') : '/s';
  const timesS = u => u ? (u.endsWith('/s') ? u.slice(0, -2) : u === 'W' ? 'W·s' : u + '·s') : 's';

  /* ---------------- operators ---------------- */
  const nanOr = f => (a, b) => (a !== a || b !== b) ? NaN : (f(a, b) ? 1 : 0);
  const BIN = {
    '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
    '%': (a, b) => { const r = a % b; return r !== 0 && (r < 0) !== (b < 0) ? r + b : r; },
    '^': Math.pow,
    '<': nanOr((a, b) => a < b), '>': nanOr((a, b) => a > b), '<=': nanOr((a, b) => a <= b), '>=': nanOr((a, b) => a >= b),
    '==': nanOr((a, b) => a === b), '!=': nanOr((a, b) => a !== b),
    '&&': nanOr((a, b) => a && b), '||': nanOr((a, b) => a || b)
  };
  const UNIT_SIMPLE = { 'V·A': 'W', 'A·V': 'W', 'W·s': 'J', 'm/s·s': 'm', 'deg/s·s': 'deg' };
  const simp = u => UNIT_SIMPLE[u] || u;
  function binUnit(op, a, b) {
    const ua = isS(a) ? a.unit : '', ub = isS(b) ? b.unit : '';
    switch (op) {
      case '+': case '-': case '%': return ua || ub;
      case '*':
        if (isS(a) && isS(b)) return simp([ua, ub].filter(Boolean).join('·'));
        if (isS(a) && b === 1000 && ua === 's') return 'ms';
        if (isS(b) && a === 1000 && ub === 's') return 'ms';
        return ua || ub;
      case '/':
        if (isS(a) && isS(b)) return ua === ub ? '' : (ua || '1') + (ub ? '/' + ub : '');
        if (isS(a)) {
          if (b === 3600 && ua.endsWith('·s')) return ua === 'W·s' ? 'Wh' : ua.slice(0, -2) + 'h';
          if (b === 3600 && ua === 'J') return 'Wh';
          return ua;
        }
        return ub ? '1/' + ub : '';
      default: return '';
    }
  }

  /* ---------------- function registry & docs ---------------- */
  const FN = Object.create(null);
  const CATS = [];
  let curCat = null;
  function cat(id, title, intro) { curCat = { id, title, intro, items: [] }; CATS.push(curCat); }
  function doc(sig, desc, ex) { curCat.items.push({ sig, desc, ex: ex || [] }); }
  function fn(names, sig, desc, ex, min, max, impl, extra) {
    const e = Object.assign({ name: names[0], names, sig, desc, ex, min, max, impl }, extra || {});
    for (const n of names) FN[n.toLowerCase()] = e;
    curCat.items.push(e);
    return e;
  }
  function argErr(node, i, msg) { const a = node.args[i] || node; throw new FormulaError(msg, a.pos, a.end); }
  function needS(node, args, i) {
    const v = args[i];
    if (!isS(v)) argErr(node, i, `${node.name}() needs a log field or a formula here, not a plain number`);
    if (v.konst && !node._konstOk) argErr(node, i, `${node.name}() needs a field that changes over time here`);
    return v;
  }
  function needN(node, args, i, def) {
    if (args.length <= i || args[i] === undefined) {
      if (def === undefined) argErr(node, i, `${node.name}() needs more arguments: ${FN[node.name.toLowerCase()].sig}`);
      return def;
    }
    const v = args[i];
    if (isS(v)) { if (v.konst) return v.v[0]; argErr(node, i, `Argument ${i + 1} of ${node.name}() must be a single number, like 5`); }
    return v;
  }
  function needPos(node, args, i, def, what) {
    const v = needN(node, args, i, def);
    if (!(v > 0)) argErr(node, i, `${what || 'This value'} must be above zero`);
    return v;
  }
  const el1 = (f, unit) => (a) => map1(a[0], f, unit);

  /* ----- guide entries (no implementation) ----- */
  cat('fields', 'Fields, names and numbers', 'A formula works on whole log fields. Every field is a series of samples with timestamps, and the result is plotted against the shared time axis.');
  doc('MSG.Column', 'A column of a log message: the message name, a dot, then the column. The Fields list on the left shows everything in the open log, with units.', ['BARO.Alt', 'ATT.Roll', 'BAT.Volt']);
  doc('MSG[i].Column', 'One instance of a message that ArduPilot logs per sensor, such as IMU, BARO, GPS or BAT. Instances count from 0, so IMU[1] is the second IMU. Without [i] you get the first instance.', ['BARO[1].Alt', 'IMU[0].AccZ', 'VIBE[1].VibeZ']);
  doc('PARM.NAME', 'A parameter over time. It steps where the parameter was changed during the log, so you can see a tuning change line up with the flight. param("NAME") does the same.', ['PARM.ATC_RAT_RLL_P', 'param("MOT_THST_HOVER")']);
  doc('Name = formula', 'Start a formula with a name and an equals sign to name the field. Any formula in any graph can then use that name, so you can build a value once and reuse it.', ['Power = BAT.Volt * BAT.Curr', 'Error = ATT.Roll - ATT.DesRoll']);
  doc('pi  e  g  nan  true  false', 'Constants. g is standard gravity, 9.80665 m/s². nan is "no value": a sample that is nan is left out of the line, which is handy with if().', ['ATT.Roll * pi / 180', 'IMU[0].AccZ / g']);
  doc('armed', 'A step field that is 1 while the vehicle is armed and 0 otherwise.', ['armed', 'if(armed, CTUN.Alt, nan)']);
  doc('mode', 'The flight mode number as a step field. Mode names for the vehicle type of the open log can be used as numbers, such as LOITER or AUTO.', ['mode', 'mode == LOITER', 'if(mode == AUTO, GPS.Spd, nan)']);

  cat('ops', 'Operators', 'Operators work on numbers and whole fields alike. Comparisons and logic give 1 for true and 0 for false.');
  doc('a + b   a - b   a * b   a / b', 'Add, subtract, multiply and divide. Units follow along: volts times amps is shown as V·A.', ['BAT.Volt * BAT.Curr', 'ATT.Roll - ATT.DesRoll', 'BARO[0].Alt - BARO[1].Alt']);
  doc('a ^ b   a ** b', 'Power. -2^2 is -4, as on paper.', ['GPS.Spd ^ 2', 'IMU[0].AccX^2 + IMU[0].AccY^2']);
  doc('a % b', 'Remainder, always with the sign of b, so -30 % 360 is 330. Useful for headings.', ['(ATT.Yaw + 180) % 360']);
  doc('<  >  <=  >=  ==  !=', 'Comparisons. 1 where true, 0 where false.', ['BAT.Volt < 15', 'GPS.NSats >= 10']);
  doc('a && b   a || b   !a', 'And, or, not. The words and, or, not work too.', ['armed && CTUN.Alt > 5', 'not armed']);
  doc('cond ? a : b', 'Pick a where the condition is true and b elsewhere. Same as if(cond, a, b).', ['CTUN.Alt > 10 ? BAT.Curr : nan']);
  doc('( … )', 'Brackets group a part of the formula so it is worked out first.', ['(BARO[0].Alt + BARO[1].Alt) / 2']);

  cat('combine', 'How fields with different timestamps combine', 'Each log message has its own timestamps and rate. When a formula mixes fields from different messages, the result takes the timestamps of the field with the most samples. The other fields are interpolated in a straight line between their samples. Step fields (parameters, mode, armed) hold their last value instead. Outside the time a field was logged, the result has no value. Plain numbers apply everywhere.');
  doc('deg(IMU[0].GyrX) - deriv(ATT.Roll)', 'In the demo log ATT is logged at 25 Hz and IMU at 250 Hz, so this result has the IMU timestamps and the ATT part is interpolated onto them.', ['deg(IMU[0].GyrX) - deriv(ATT.Roll)']);
  doc('at(x, ref)   hold(x, ref)', 'Choose the timestamps yourself: at() interpolates x onto the samples of ref, hold() keeps the last sample of x.', ['at(GPS.Spd, ATT.Roll)', 'hold(GPS.NSats, ATT.Roll)']);

  /* ----- basic math ----- */
  cat('math', 'Basic math', 'These work sample by sample and accept fields or plain numbers.');
  fn(['abs'], 'abs(x)', 'Absolute value: removes the sign.', ['abs(ATT.Roll)', 'abs(ATT.Roll - ATT.DesRoll)'], 1, 1, el1(Math.abs));
  fn(['sqrt'], 'sqrt(x)', 'Square root.', ['sqrt(IMU[0].AccX^2 + IMU[0].AccY^2)'], 1, 1, el1(Math.sqrt, ''));
  fn(['cbrt'], 'cbrt(x)', 'Cube root.', ['cbrt(BARO.Press)'], 1, 1, el1(Math.cbrt, ''));
  fn(['sq'], 'sq(x)', 'Square, the same as x ^ 2.', ['sq(GPS.Spd)'], 1, 1, el1(v => v * v, ''));
  fn(['pow'], 'pow(x, y)', 'x to the power of y.', ['pow(GPS.Spd, 2)'], 2, 2, a => map2(a[0], a[1], Math.pow, ''));
  fn(['exp'], 'exp(x)', 'e to the power of x.', ['exp(-abs(ATT.Roll - ATT.DesRoll))'], 1, 1, el1(Math.exp, ''));
  fn(['ln', 'log'], 'ln(x)   log(x)', 'Natural logarithm. log() is the same, not base 10.', ['ln(BARO.Press / 101325)'], 1, 1, el1(Math.log, ''));
  fn(['log10'], 'log10(x)', 'Base-10 logarithm.', ['20 * log10(VIBE.VibeZ)'], 1, 1, el1(Math.log10, ''));
  fn(['log2'], 'log2(x)', 'Base-2 logarithm.', ['log2(GPS.NSats)'], 1, 1, el1(Math.log2, ''));
  fn(['sign'], 'sign(x)', '-1 for negative values, 1 for positive, 0 for zero.', ['sign(CTUN.CRt)'], 1, 1, el1(Math.sign, ''));
  fn(['floor'], 'floor(x)', 'Round down to a whole number.', ['floor(BAT.Volt)'], 1, 1, el1(Math.floor));
  fn(['ceil'], 'ceil(x)', 'Round up to a whole number.', ['ceil(CTUN.Alt)'], 1, 1, el1(Math.ceil));
  fn(['round'], 'round(x, digits)', 'Round to the nearest value. digits is optional: round(x, 1) keeps one decimal, round(x, -1) rounds to tens.', ['round(BAT.Volt, 1)', 'round(CTUN.Alt)'], 1, 2, (a, node) => {
    const d = needN(node, a, 1, 0), k = Math.pow(10, d);
    return map1(a[0], v => Math.round(v * k) / k);
  });
  fn(['trunc'], 'trunc(x)', 'Drop the decimals, toward zero.', ['trunc(ATT.Roll)'], 1, 1, el1(Math.trunc));
  fn(['min'], 'min(a, b, …)', 'The smallest of two or more values at each moment. For the smallest value of one field over the log, use minof(x).', ['min(BARO[0].Alt, BARO[1].Alt)', 'min(BAT.Curr, 20)'], 2, 20, a => mapK(a, xs => { let m = Infinity; for (const x of xs) { if (x !== x) return NaN; if (x < m) m = x; } return m; }));
  fn(['max'], 'max(a, b, …)', 'The largest of two or more values at each moment. For the largest value of one field over the log, use maxof(x).', ['max(abs(ATT.Roll), abs(ATT.Pitch))', 'max(VIBE.VibeX, VIBE.VibeY, VIBE.VibeZ)'], 2, 20, a => mapK(a, xs => { let m = -Infinity; for (const x of xs) { if (x !== x) return NaN; if (x > m) m = x; } return m; }));
  fn(['clip', 'clamp'], 'clip(x, low, high)', 'Limit x to the range from low to high.', ['clip(ATT.Roll, -10, 10)', 'clip(BAT.Curr, 0, 30)'], 3, 3, a => mapK(a, ([x, lo, hi]) => x !== x ? NaN : x < lo ? lo : x > hi ? hi : x, unitOf(a[0])));
  fn(['hypot', 'norm'], 'hypot(a, b, …)   norm(a, b, …)', 'Length of a vector: the square root of the sum of squares.', ['hypot(IMU[0].AccX, IMU[0].AccY, IMU[0].AccZ)', 'norm(VIBE.VibeX, VIBE.VibeY)'], 2, 20, a => mapK(a, xs => { let s = 0; for (const x of xs) s += x * x; return Math.sqrt(s); }));
  fn(['mod'], 'mod(x, m)', 'Remainder of x divided by m, always with the sign of m.', ['mod(ATT.Yaw + 90, 360)'], 2, 2, a => map2(a[0], a[1], BIN['%'], unitOf(a[0])));
  fn(['rescale'], 'rescale(x, inLow, inHigh, outLow, outHigh)', 'Map one range onto another in a straight line, such as a PWM output onto percent.', ['rescale(RCOU.C1, 1000, 2000, 0, 100)'], 5, 5, (a, node) => {
    const p = [1, 2, 3, 4].map(i => needN(node, a, i));
    const k = (p[3] - p[2]) / (p[1] - p[0]);
    return map1(a[0], v => p[2] + (v - p[0]) * k, '');
  });
  fn(['deadband'], 'deadband(x, width)', 'Zero while x is within ±width, and shifted toward zero by width outside it.', ['deadband(ATT.Roll - ATT.DesRoll, 2)'], 2, 2, (a, node) => {
    const w = needN(node, a, 1);
    return map1(a[0], v => v > w ? v - w : v < -w ? v + w : (v === v ? 0 : NaN));
  });

  /* ----- trig ----- */
  cat('trig', 'Trigonometry and angles', 'sin, cos and tan take radians. ArduPilot logs most angles in degrees, so convert with rad() first.');
  fn(['sin'], 'sin(x)', 'Sine of an angle in radians.', ['sin(rad(ATT.Roll))'], 1, 1, el1(Math.sin, ''));
  fn(['cos'], 'cos(x)', 'Cosine of an angle in radians.', ['cos(rad(ATT.Pitch))'], 1, 1, el1(Math.cos, ''));
  fn(['tan'], 'tan(x)', 'Tangent of an angle in radians.', ['tan(rad(ATT.Roll)) * g'], 1, 1, el1(Math.tan, ''));
  fn(['asin'], 'asin(x)', 'Inverse sine, in radians.', ['deg(asin(clip(IMU[0].AccY / g, -1, 1)))'], 1, 1, el1(Math.asin, 'rad'));
  fn(['acos'], 'acos(x)', 'Inverse cosine, in radians.', ['deg(acos(clip(-IMU[0].AccZ / g, -1, 1)))'], 1, 1, el1(Math.acos, 'rad'));
  fn(['atan'], 'atan(x)', 'Inverse tangent, in radians.', ['deg(atan(CTUN.CRt / GPS.Spd))'], 1, 1, el1(Math.atan, 'rad'));
  fn(['atan2'], 'atan2(y, x)', 'The angle of the point (x, y), in radians, over the full circle.', ['deg(atan2(IMU[0].AccY, -IMU[0].AccZ))'], 2, 2, a => map2(a[0], a[1], Math.atan2, 'rad'));
  fn(['sinh'], 'sinh(x)', 'Hyperbolic sine.', ['sinh(ATT.Roll / 30)'], 1, 1, el1(Math.sinh, ''));
  fn(['cosh'], 'cosh(x)', 'Hyperbolic cosine.', ['cosh(ATT.Roll / 30)'], 1, 1, el1(Math.cosh, ''));
  fn(['tanh'], 'tanh(x)', 'Hyperbolic tangent, a smooth limit to ±1.', ['tanh(ATT.Roll / 10)'], 1, 1, el1(Math.tanh, ''));
  fn(['deg'], 'deg(x)', 'Radians to degrees.', ['deg(IMU[0].GyrX)'], 1, 1, a => map1(a[0], v => v * 180 / Math.PI, isS(a[0]) && a[0].unit === 'rad/s' ? 'deg/s' : 'deg'));
  fn(['rad'], 'rad(x)', 'Degrees to radians.', ['rad(ATT.Roll)'], 1, 1, a => map1(a[0], v => v * Math.PI / 180, isS(a[0]) && a[0].unit === 'deg/s' ? 'rad/s' : 'rad'));
  fn(['wrap180'], 'wrap180(x)', 'Wrap an angle in degrees into -180 … 180.', ['wrap180(ATT.Yaw - ATT.DesYaw)'], 1, 1, el1(v => { const r = ((v + 180) % 360 + 360) % 360 - 180; return r; }));
  fn(['wrap360'], 'wrap360(x)', 'Wrap an angle in degrees into 0 … 360.', ['wrap360(ATT.Yaw + 180)'], 1, 1, el1(v => ((v % 360) + 360) % 360));
  fn(['unwrap'], 'unwrap(x, period)', 'Remove the jumps where an angle wraps around, so a heading that turns twice reads 0 … 720. period is 360 unless you give another, such as 2*pi.', ['unwrap(ATT.Yaw)', 'unwrap(GPS.GCrs)'], 1, 2, (a, node) => {
    const x = needS(node, a, 0), P = needPos(node, a, 1, 360, 'The period'), v = x.v, n = v.length, o = new Float64Array(n);
    let off = 0, prev = NaN;
    for (let i = 0; i < n; i++) {
      const c = v[i];
      if (c !== c) { o[i] = NaN; continue; }
      if (prev === prev) { const d = c - prev; if (d > P / 2) off -= P * Math.round(d / P); else if (d < -P / 2) off += P * Math.round(-d / P); }
      prev = c; o[i] = c + off;
    }
    return out(x, o);
  });

  /* ----- conditions ----- */
  cat('logic', 'Conditions and missing values', 'Use conditions to keep part of a field, or to mark moments.');
  fn(['if'], 'if(cond, a, b)', 'a where cond is true (not zero), b elsewhere. Use nan for b to hide the rest of the line.', ['if(armed, BAT.Curr, nan)', 'if(CTUN.Alt > 5, ATT.Roll, 0)'], 3, 3, a => mapK(a, ([c, x, y]) => c !== c ? NaN : (c ? x : y), unitOf(a[1], a[2])));
  fn(['between'], 'between(x, low, high)', '1 while x is within low … high, else 0.', ['between(BAT.Volt, 14, 15)'], 3, 3, a => mapK(a, ([x, lo, hi]) => x !== x ? NaN : (x >= lo && x <= hi ? 1 : 0), ''));
  fn(['isnan'], 'isnan(x)', '1 where x has no value, else 0.', ['isnan(BARO[0].Alt - RFND.Dist)'], 1, 1, el1(v => v !== v ? 1 : 0, ''));
  fn(['fillnan'], 'fillnan(x, value)', 'Fill missing values. With a value, gaps get that value. Without one, each gap keeps the last good value.', ['fillnan(if(armed, CTUN.Alt, nan), 0)', 'fillnan(RFND.Dist - CTUN.Alt)'], 1, 2, (a, node) => {
    if (a.length > 1) return map2(a[0], a[1], (x, f) => x !== x ? f : x, unitOf(a[0]));
    const x = needS(node, a, 0), v = x.v, n = v.length, o = new Float64Array(n);
    let last = NaN;
    for (let i = 0; i < n; i++) { const c = v[i]; if (c === c) last = c; o[i] = c === c ? c : last; }
    return out(x, o);
  });

  /* ----- filters ----- */
  cat('filters', 'Filters', 'Frequencies are in hertz. Filters use the real time between samples, and restart after a gap in the log of more than a second.');
  function lp1(x, hz) {
    const T = x.t, v = x.v, n = v.length, o = new Float64Array(n), RC = 1 / (2 * Math.PI * hz), gap = gapUs(x);
    let y = NaN, tp = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = v[i];
      if (c !== c) { o[i] = NaN; continue; }
      if (y !== y || T[i] - tp > gap) y = c;
      else { const d = (T[i] - tp) / 1e6; y += d / (RC + d) * (c - y); }
      tp = T[i]; o[i] = y;
    }
    return o;
  }
  function hp1(x, hz) {
    const T = x.t, v = x.v, n = v.length, o = new Float64Array(n), RC = 1 / (2 * Math.PI * hz), gap = gapUs(x);
    let y = 0, xp = NaN, tp = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = v[i];
      if (c !== c) { o[i] = NaN; continue; }
      if (xp !== xp || T[i] - tp > gap) y = 0;
      else { const d = (T[i] - tp) / 1e6; y = RC / (RC + d) * (y + c - xp); }
      xp = c; tp = T[i]; o[i] = y;
    }
    return o;
  }
  function rbj(type, fc, fs, q) {
    const w0 = 2 * Math.PI * fc / fs, cs = Math.cos(w0), al = Math.sin(w0) / (2 * q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
    else { b0 = 1; b1 = -2 * cs; b2 = 1; }
    const a0 = 1 + al;
    return [b0 / a0, b1 / a0, b2 / a0, -2 * cs / a0, (1 - al) / a0];
  }
  function biquad(T, v, co, reverse, gap) {
    const n = v.length, o = new Float64Array(n), [b0, b1, b2, a1, a2] = co;
    const dc = (b0 + b1 + b2) / (1 + a1 + a2);
    let x1 = NaN, x2 = NaN, y1 = NaN, y2 = NaN, tp = NaN;
    for (let k = 0; k < n; k++) {
      const i = reverse ? n - 1 - k : k, c = v[i];
      if (c !== c) { o[i] = NaN; continue; }
      if (x1 !== x1 || Math.abs(T[i] - tp) > gap) { x1 = x2 = c; y1 = y2 = c * (isFinite(dc) ? dc : 0); }
      const y = b0 * c + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = c; y2 = y1; y1 = y; tp = T[i]; o[i] = y;
    }
    return o;
  }
  function fsOf(node, x, fc, argi) {
    const fs = 1e6 / medianDt(x);
    if (fc >= fs / 2) argErr(node, argi, `${fmt(fc)} Hz is at or above half the sample rate of this field (${fmt(fs)} Hz samples, so at most ${fmt(fs / 2 * 0.99)} Hz)`);
    return fs;
  }
  const fmt = v => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toPrecision(3).replace(/\.?0+$/, '');
  fn(['lowpass', 'lpf'], 'lowpass(x, hz)', 'First-order low-pass filter with a cut-off frequency in Hz. Smooths noise and adds a little delay.', ['lowpass(ATT.Roll, 2)', 'lowpass(IMU[0].AccZ, 5)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0); return out(x, lp1(x, needPos(node, a, 1, undefined, 'The cut-off frequency')));
  });
  fn(['highpass', 'hpf'], 'highpass(x, hz)', 'First-order high-pass filter. Removes slow drift and keeps fast changes.', ['highpass(BARO[0].Alt, 0.1)', 'highpass(IMU[0].AccZ, 20)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0); return out(x, hp1(x, needPos(node, a, 1, undefined, 'The cut-off frequency')));
  });
  fn(['lowpass2', 'lpf2'], 'lowpass2(x, hz)', 'Second-order Butterworth low-pass, like the filters ArduPilot runs on its gyros and accelerometers. Steeper than lowpass().', ['lowpass2(IMU[0].AccZ, 20)', 'lowpass2(IMU[0].GyrX, 40)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), fc = needPos(node, a, 1, undefined, 'The cut-off frequency'), fs = fsOf(node, x, fc, 1);
    return out(x, biquad(x.t, x.v, rbj('lp', fc, fs, Math.SQRT1_2), false, gapUs(x)));
  });
  fn(['highpass2', 'hpf2'], 'highpass2(x, hz)', 'Second-order Butterworth high-pass.', ['highpass2(IMU[0].AccZ, 30)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), fc = needPos(node, a, 1, undefined, 'The cut-off frequency'), fs = fsOf(node, x, fc, 1);
    return out(x, biquad(x.t, x.v, rbj('hp', fc, fs, Math.SQRT1_2), false, gapUs(x)));
  });
  fn(['bandpass'], 'bandpass(x, lowHz, highHz)', 'Keep only frequencies between lowHz and highHz.', ['bandpass(IMU[0].AccZ, 30, 70)'], 3, 3, (a, node) => {
    const x = needS(node, a, 0), lo = needPos(node, a, 1, undefined, 'The low frequency'), hi = needPos(node, a, 2, undefined, 'The high frequency');
    if (hi <= lo) argErr(node, 2, 'The high frequency must be above the low one');
    const fs = fsOf(node, x, hi, 2), gap = gapUs(x);
    const h = biquad(x.t, x.v, rbj('hp', lo, fs, Math.SQRT1_2), false, gap);
    return out(x, biquad(x.t, h, rbj('lp', hi, fs, Math.SQRT1_2), false, gap));
  });
  fn(['notch'], 'notch(x, hz, width)', 'Notch filter: removes a narrow band around hz. width is the band in Hz (default hz/4). Try it on IMU data at the motor frequency you see in a Spectrum graph.', ['notch(IMU[0].AccZ, 48, 12)', 'notch(IMU[0].GyrX, 48)'], 2, 3, (a, node) => {
    const x = needS(node, a, 0), fc = needPos(node, a, 1, undefined, 'The notch frequency'), bw = needPos(node, a, 2, fc / 4, 'The width'), fs = fsOf(node, x, fc, 1);
    return out(x, biquad(x.t, x.v, rbj('notch', fc, fs, fc / bw), false, gapUs(x)));
  });
  fn(['filtfilt', 'zerolag'], 'filtfilt(x, hz)', 'Second-order low-pass run forward and then backward, so the result has no delay. Good for lining up events in time; not something the autopilot could do live.', ['filtfilt(ATT.Roll, 2)', 'filtfilt(IMU[0].AccZ, 10)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), fc = needPos(node, a, 1, undefined, 'The cut-off frequency'), fs = fsOf(node, x, fc, 1), gap = gapUs(x), co = rbj('lp', fc, fs, Math.SQRT1_2);
    return out(x, biquad(x.t, biquad(x.t, x.v, co, false, gap), co, true, gap));
  });
  fn(['ema'], 'ema(x, seconds)', 'Exponential moving average with a time constant in seconds. ema(x, 1) follows a step to 63% after one second.', ['ema(BAT.Curr, 5)', 'ema(GPS.Spd, 2)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), tau = needPos(node, a, 1, undefined, 'The time constant'), T = x.t, v = x.v, n = v.length, o = new Float64Array(n), gap = gapUs(x);
    let y = NaN, tp = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = v[i];
      if (c !== c) { o[i] = NaN; continue; }
      if (y !== y || T[i] - tp > gap) y = c; else y += (1 - Math.exp(-(T[i] - tp) / 1e6 / tau)) * (c - y);
      tp = T[i]; o[i] = y;
    }
    return out(x, o);
  });

  /* ----- moving windows ----- */
  cat('windows', 'Moving windows', 'Each point is computed from the samples in the window that ends at that point, so the window size is in seconds, not samples. smooth() centres the window instead.');
  function winSum(x, back, fwd, kind) {
    const T = x.t, v = x.v, n = v.length, o = new Float64Array(n);
    let lo = 0, hi = 0, sum = 0, sq = 0, cnt = 0, ref = NaN;
    for (let i = 0; i < n && ref !== ref; i++) if (v[i] === v[i]) ref = v[i];
    if (ref !== ref) ref = 0;
    for (let i = 0; i < n; i++) {
      const tEnd = T[i] + fwd, tStart = T[i] - back;
      while (hi < n && T[hi] <= tEnd) { const c = v[hi]; if (c === c) { const d = c - ref; sum += d; sq += d * d; cnt++; } hi++; }
      while (lo < hi && T[lo] < tStart) { const c = v[lo]; if (c === c) { const d = c - ref; sum -= d; sq -= d * d; cnt--; } lo++; }
      if (!cnt) { o[i] = NaN; continue; }
      if (kind === 'avg') o[i] = ref + sum / cnt;
      else if (kind === 'sum') o[i] = sum + ref * cnt;
      else if (kind === 'std') o[i] = cnt > 1 ? Math.sqrt(Math.max(0, (sq - sum * sum / cnt) / (cnt - 1))) : 0;
      else if (kind === 'rms') { const m = sum / cnt; o[i] = Math.sqrt(Math.max(0, sq / cnt + 2 * ref * m + ref * ref)); }
    }
    return o;
  }
  function winExt(x, back, kind) {
    const T = x.t, v = x.v, n = v.length, o = new Float64Array(n), dq = new Int32Array(n);
    let h = 0, tl = 0, lo = 0;
    const better = kind === 'min' ? (a, b) => a <= b : (a, b) => a >= b;
    for (let i = 0; i < n; i++) {
      const c = v[i];
      if (c === c) { while (tl > h && better(c, v[dq[tl - 1]])) tl--; dq[tl++] = i; }
      const tStart = T[i] - back;
      while (lo < i && T[lo] < tStart) lo++;
      while (tl > h && dq[h] < lo) h++;
      o[i] = tl > h ? v[dq[h]] : NaN;
    }
    return o;
  }
  function winMedian(x, back) {
    const T = x.t, v = x.v, n = v.length, o = new Float64Array(n), win = [];
    let lo = 0;
    const ins = c => { let a = 0, b = win.length; while (a < b) { const m = (a + b) >> 1; if (win[m] < c) a = m + 1; else b = m; } win.splice(a, 0, c); };
    const del = c => { let a = 0, b = win.length; while (a < b) { const m = (a + b) >> 1; if (win[m] < c) a = m + 1; else b = m; } win.splice(a, 1); };
    for (let i = 0; i < n; i++) {
      const c = v[i];
      if (c === c) ins(c);
      const tStart = T[i] - back;
      while (lo < i && T[lo] < tStart) { const d = v[lo]; if (d === d) del(d); lo++; }
      const k = win.length;
      o[i] = k ? (k & 1 ? win[k >> 1] : (win[k / 2 - 1] + win[k / 2]) / 2) : NaN;
    }
    return o;
  }
  const W = (node, a) => needPos(node, a, 1, undefined, 'The window') * 1e6;
  fn(['movavg', 'sma', 'mavg'], 'movavg(x, seconds)', 'Moving average over the last given seconds.', ['movavg(BAT.Curr, 10)', 'movavg(ATT.Roll, 0.5)'], 2, 2, (a, node) => { const x = needS(node, a, 0); return out(x, winSum(x, W(node, a), 0, 'avg')); });
  fn(['smooth'], 'smooth(x, seconds)', 'Moving average centred on each point, so it has no delay.', ['smooth(GPS.Spd, 3)', 'smooth(IMU[0].AccZ, 0.2)'], 2, 2, (a, node) => { const x = needS(node, a, 0), w = W(node, a); return out(x, winSum(x, w / 2, w / 2, 'avg')); });
  fn(['movmedian', 'medfilt'], 'movmedian(x, seconds)', 'Moving median. Removes single spikes while keeping steps sharp.', ['movmedian(RFND.Dist, 1)', 'movmedian(GPS.HDop, 5)'], 2, 2, (a, node) => { const x = needS(node, a, 0); return out(x, winMedian(x, W(node, a))); });
  fn(['movmin'], 'movmin(x, seconds)', 'Smallest value in the window.', ['movmin(BAT.Volt, 5)'], 2, 2, (a, node) => { const x = needS(node, a, 0); return out(x, winExt(x, W(node, a), 'min')); });
  fn(['movmax'], 'movmax(x, seconds)', 'Largest value in the window. Makes a peak-hold line.', ['movmax(abs(ATT.Roll), 2)', 'movmax(VIBE.VibeZ, 10)'], 2, 2, (a, node) => { const x = needS(node, a, 0); return out(x, winExt(x, W(node, a), 'max')); });
  fn(['movrange', 'p2p'], 'movrange(x, seconds)', 'Peak to peak: largest minus smallest value in the window.', ['movrange(IMU[0].AccZ, 0.5)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), w = W(node, a), hi = winExt(x, w, 'max'), lo = winExt(x, w, 'min');
    for (let i = 0; i < hi.length; i++) hi[i] -= lo[i];
    return out(x, hi);
  });
  fn(['movstd'], 'movstd(x, seconds)', 'Standard deviation in the window: how much the value moves around its average.', ['movstd(IMU[0].AccZ, 1)', 'movstd(ATT.Roll - ATT.DesRoll, 2)'], 2, 2, (a, node) => { const x = needS(node, a, 0); return out(x, winSum(x, W(node, a), 0, 'std')); });
  fn(['movrms'], 'movrms(x, seconds)', 'Root mean square in the window. For vibration, use it on high-passed data.', ['movrms(highpass(IMU[0].AccZ, 5), 1)'], 2, 2, (a, node) => { const x = needS(node, a, 0); return out(x, winSum(x, W(node, a), 0, 'rms')); });
  fn(['movsum'], 'movsum(x, seconds)', 'Sum of the samples in the window.', ['movsum(diff(VIBE.Clip), 10)'], 2, 2, (a, node) => { const x = needS(node, a, 0); return out(x, winSum(x, W(node, a), 0, 'sum')); });

  /* ----- calculus & timing ----- */
  cat('calculus', 'Rates, integrals and timing', 'Rates are per second and integrals are over seconds. Units follow: the derivative of m is m/s.');
  fn(['deriv', 'derivative', 'ddt'], 'deriv(x)', 'Rate of change per second, from the neighbouring samples. Noisy fields benefit from a filter first.', ['deriv(CTUN.Alt)', 'deriv(lowpass(GPS.Spd, 1))'], 1, 1, (a, node) => {
    const x = needS(node, a, 0), T = x.t, v = x.v, n = v.length, o = new Float64Array(n), gap = gapUs(x);
    for (let i = 0; i < n; i++) {
      let p = i > 0 ? i - 1 : i, q = i + 1 < n ? i + 1 : i;
      if (T[q] - T[i] > gap) q = i;
      if (T[i] - T[p] > gap) p = i;
      const d = T[q] - T[p];
      o[i] = d > 0 ? (v[q] - v[p]) / (d / 1e6) : NaN;
    }
    return out(x, o, perS(x.unit));
  });
  fn(['diff'], 'diff(x)', 'Change from the previous sample, without dividing by time. Shows when a counter steps.', ['diff(VIBE.Clip)', 'diff(GPS.GMS)'], 1, 1, (a, node) => {
    const x = needS(node, a, 0), v = x.v, n = v.length, o = new Float64Array(n);
    o[0] = NaN; for (let i = 1; i < n; i++) o[i] = v[i] - v[i - 1];
    return out(x, o);
  });
  fn(['integral', 'integrate'], 'integral(x)', 'Running integral over time from the start of the log, by the trapezoid rule. Current in amps gives amp-seconds; divide by 3600 for amp-hours.', ['integral(BAT.Curr) / 3600', 'integral(BAT.Volt * BAT.Curr) / 3600', 'integral(CTUN.CRt)'], 1, 1, (a, node) => {
    const x = needS(node, a, 0), T = x.t, v = x.v, n = v.length, o = new Float64Array(n), gap = gapUs(x);
    let acc = 0;
    if (n) o[0] = 0;
    for (let i = 1; i < n; i++) {
      const d = T[i] - T[i - 1], p = v[i - 1], c = v[i];
      if (d > 0 && d <= gap && p === p && c === c) acc += (p + c) / 2 * d / 1e6;
      o[i] = acc;
    }
    return out(x, o, timesS(x.unit));
  });
  fn(['cumsum'], 'cumsum(x)', 'Running sum of the samples.', ['cumsum(diff(VIBE.Clip) > 0)'], 1, 1, (a, node) => {
    const x = needS(node, a, 0), v = x.v, n = v.length, o = new Float64Array(n);
    let acc = 0; for (let i = 0; i < n; i++) { if (v[i] === v[i]) acc += v[i]; o[i] = acc; }
    return out(x, o);
  });
  fn(['dt'], 'dt(x)', 'Seconds between each sample and the one before. Spikes show where the log dropped samples.', ['dt(IMU[0].AccZ) * 1000', 'dt(ATT.Roll)'], 1, 1, (a, node) => {
    const x = needS(node, a, 0), T = x.t, n = T.length, o = new Float64Array(n);
    o[0] = NaN; for (let i = 1; i < n; i++) o[i] = (T[i] - T[i - 1]) / 1e6;
    return out(x, o, 's');
  });
  fn(['rate'], 'rate(x)', 'Logging rate in samples per second, from the time between samples.', ['rate(IMU[0].AccZ)', 'movavg(rate(ATT.Roll), 1)'], 1, 1, (a, node) => {
    const x = needS(node, a, 0), T = x.t, n = T.length, o = new Float64Array(n);
    o[0] = NaN; for (let i = 1; i < n; i++) { const d = T[i] - T[i - 1]; o[i] = d > 0 ? 1e6 / d : NaN; }
    return out(x, o, 'Hz');
  });

  /* ----- statistics ----- */
  cat('stats', 'Statistics', 'These give one number for the whole log, drawn as a flat line. Add a start and end time in seconds to use only that part: mean(BAT.Curr, 100, 200). For live numbers over the visible range or a selection, see the columns next to each field.');
  function rangeVals(node, a) {
    const x = needS(node, a, 0);
    const T = x.t, i0 = a.length > 1 ? lowerBound(T, needN(node, a, 1) * 1e6) : 0, i1 = a.length > 2 ? upperBound(T, needN(node, a, 2) * 1e6) : T.length;
    const vals = [];
    for (let i = i0; i < i1; i++) { const c = x.v[i]; if (c === c) vals.push(c); }
    return { x, vals };
  }
  const stat = (names, sig, desc, ex, f, unitFn) => fn(names, sig, desc, ex, 1, 3, (a, node) => {
    node._konstOk = true;
    const { x, vals } = rangeVals(node, a);
    return konst(vals.length ? f(vals) : NaN, unitFn ? unitFn(x.unit) : x.unit);
  });
  const meanOf = vs => { let s = 0; for (const v of vs) s += v; return s / vs.length; };
  const stdOf = vs => { if (vs.length < 2) return 0; const m = meanOf(vs); let s = 0; for (const v of vs) s += (v - m) * (v - m); return Math.sqrt(s / (vs.length - 1)); };
  const pctOf = (vs, p) => { const s = Float64Array.from(vs).sort(); const k = (s.length - 1) * p / 100, lo = Math.floor(k), hi = Math.ceil(k); return s[lo] + (s[hi] - s[lo]) * (k - lo); };
  stat(['mean', 'avg'], 'mean(x, from, to)', 'Average. from and to are optional times in seconds.', ['mean(BAT.Curr)', 'mean(BAT.Curr, 100, 200)', 'CTUN.Alt - mean(CTUN.Alt)'], meanOf);
  stat(['median'], 'median(x, from, to)', 'Middle value: half the samples are below it.', ['median(GPS.HDop)'], vs => pctOf(vs, 50));
  stat(['std', 'stdev'], 'std(x, from, to)', 'Standard deviation.', ['std(ATT.Roll - ATT.DesRoll)'], stdOf);
  stat(['rms'], 'rms(x, from, to)', 'Root mean square.', ['rms(ATT.Roll - ATT.DesRoll)'], vs => { let s = 0; for (const v of vs) s += v * v; return Math.sqrt(s / vs.length); });
  stat(['minof'], 'minof(x, from, to)', 'Smallest value.', ['minof(BAT.Volt)'], vs => { let m = Infinity; for (const v of vs) if (v < m) m = v; return m; });
  stat(['maxof'], 'maxof(x, from, to)', 'Largest value.', ['maxof(CTUN.Alt)'], vs => { let m = -Infinity; for (const v of vs) if (v > m) m = v; return m; });
  stat(['first'], 'first(x, from, to)', 'First value. x - first(x) makes a field start at zero.', ['BARO[0].Alt - first(BARO[0].Alt)'], vs => vs[0]);
  stat(['last'], 'last(x, from, to)', 'Last value.', ['last(BAT.CurrTot)'], vs => vs[vs.length - 1]);
  fn(['percentile', 'pct'], 'percentile(x, p, from, to)', 'The value that p percent of the samples are below. percentile(x, 95) ignores the top 5% of spikes.', ['percentile(VIBE.VibeZ, 95)'], 2, 4, (a, node) => {
    node._konstOk = true;
    const p = needN(node, a, 1);
    if (!(p >= 0 && p <= 100)) argErr(node, 1, 'The percentile must be between 0 and 100');
    const b = [a[0]].concat(a.slice(2));
    const { x, vals } = rangeVals(node, b);
    return konst(vals.length ? pctOf(vals, p) : NaN, x.unit);
  });
  fn(['detrend'], 'detrend(x)', 'Subtract the average, so the field centres on zero.', ['detrend(BARO[1].Alt - BARO[0].Alt)'], 1, 1, (a, node) => {
    const x = needS(node, a, 0); let s = 0, c = 0; for (const v of x.v) if (v === v) { s += v; c++; }
    const m = c ? s / c : 0; return map1(x, v => v - m);
  });
  fn(['normalize'], 'normalize(x)', 'Scale to 0 … 1 between the smallest and largest value. Puts fields with different units on one axis.', ['normalize(BAT.Curr)', 'normalize(RCOU.C1)'], 1, 1, (a, node) => {
    const x = needS(node, a, 0); let lo = Infinity, hi = -Infinity; for (const v of x.v) if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const k = hi > lo ? 1 / (hi - lo) : 0; return map1(x, v => (v - lo) * k, '');
  });
  fn(['zscore'], 'zscore(x)', 'Subtract the average and divide by the standard deviation.', ['zscore(IMU[0].AccZ)'], 1, 1, (a, node) => {
    const x = needS(node, a, 0), vs = []; for (const v of x.v) if (v === v) vs.push(v);
    const m = vs.length ? meanOf(vs) : 0, sd = stdOf(vs) || 1; return map1(x, v => (v - m) / sd, '');
  });

  /* ----- time ----- */
  cat('time', 'Time and resampling', 'Times are seconds since the autopilot booted, as on the time axis.');
  fn(['shift', 'delay'], 'shift(x, seconds)', 'Move a field later in time (negative moves it earlier). Use it to line up a delayed sensor.', ['shift(GPS.Alt, -0.2)', 'shift(ATT.DesRoll, 0.12)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), d = needN(node, a, 1) * 1e6, T = new Float64Array(x.t.length);
    for (let i = 0; i < T.length; i++) T[i] = x.t[i] + d;
    return { t: T, v: x.v, unit: x.unit, step: x.step, konst: false };
  });
  fn(['resample'], 'resample(x, hz)', 'Resample to an even rate, interpolating between samples.', ['resample(GPS.Spd, 50)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), hz = needPos(node, a, 1, undefined, 'The rate'), t0 = x.t[0], t1 = x.t[x.t.length - 1];
    const n = Math.floor((t1 - t0) / 1e6 * hz) + 1;
    if (n > 2e7) argErr(node, 1, 'That would make more than 20 million samples. Use a lower rate.');
    const T = new Float64Array(n); for (let i = 0; i < n; i++) T[i] = t0 + i * 1e6 / hz;
    return { t: T, v: resampleTo(x, T), unit: x.unit, step: false, konst: false };
  });
  fn(['at'], 'at(x, ref)', 'x interpolated onto the timestamps of ref.', ['at(GPS.Spd, ATT.Roll)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), r = needS(node, a, 1);
    return { t: r.t, v: resampleTo(x, r.t), unit: x.unit, step: false, konst: false };
  });
  fn(['hold'], 'hold(x, ref)', 'x on the timestamps of ref, keeping the last sample of x with no interpolation.', ['hold(GPS.NSats, ATT.Roll)'], 2, 2, (a, node) => {
    const x = needS(node, a, 0), r = needS(node, a, 1);
    return { t: r.t, v: resampleTo(Object.assign({}, x, { step: true }), r.t), unit: x.unit, step: false, konst: false };
  });
  fn(['time'], 'time(x)', 'The timestamp of each sample of x, in seconds since boot.', ['time(BAT.Volt)', 'time(ATT.Roll) - first(time(ATT.Roll))'], 1, 1, (a, node) => {
    const x = needS(node, a, 0), o = new Float64Array(x.t.length);
    for (let i = 0; i < o.length; i++) o[i] = x.t[i] / 1e6;
    return out(x, o, 's');
  });
  fn(['window'], 'window(x, from, to)', 'Keep x only between two times in seconds and leave the rest empty.', ['window(ATT.Roll, 520, 600)'], 3, 3, (a, node) => {
    const x = needS(node, a, 0), t0 = needN(node, a, 1) * 1e6, t1 = needN(node, a, 2) * 1e6;
    const o = new Float64Array(x.v.length);
    for (let i = 0; i < o.length; i++) o[i] = x.t[i] >= t0 && x.t[i] <= t1 ? x.v[i] : NaN;
    return out(x, o);
  });

  /* ----- ArduPilot ----- */
  cat('ardupilot', 'ArduPilot helpers', 'Shortcuts for things that come up when reading flight logs.');
  fn(['param'], 'param("NAME")', 'A parameter over time, the same as PARM.NAME. The quotes are optional.', ['param("ATC_RAT_RLL_P")', 'GPS.Spd / (param("WPNAV_SPEED") / 100)'], 1, 1, null, { raw: true });
  fn(['homedist'], 'homedist(lat, lng)', 'Distance in metres from the first position fix, from a latitude and longitude field.', ['homedist(GPS.Lat, GPS.Lng)', 'homedist(POS.Lat, POS.Lng)'], 2, 2, (a, node) => {
    needS(node, a, 0); needS(node, a, 1);
    const A = align(a), la = A.cols[0], lo = A.cols[1], n = A.t.length, o = new Float64Array(n);
    let h0 = NaN, g0 = NaN, k = 0;
    for (let i = 0; i < n; i++) {
      const x = la[i], y = lo[i];
      if (x !== x || y !== y || (x === 0 && y === 0)) { o[i] = NaN; continue; }
      if (h0 !== h0) { h0 = x; g0 = y; k = Math.cos(x * Math.PI / 180); }
      o[i] = Math.hypot((x - h0) * 111319.5, (y - g0) * 111319.5 * k);
    }
    return { t: A.t, v: o, unit: 'm', step: false, konst: false };
  });
  fn(['pathlen'], 'pathlen(lat, lng)', 'Distance travelled in metres, adding up the path between position samples.', ['pathlen(GPS.Lat, GPS.Lng)'], 2, 2, (a, node) => {
    needS(node, a, 0); needS(node, a, 1);
    const A = align(a), la = A.cols[0], lo = A.cols[1], n = A.t.length, o = new Float64Array(n);
    let px = NaN, py = NaN, acc = 0;
    for (let i = 0; i < n; i++) {
      const x = la[i], y = lo[i];
      if (x !== x || y !== y || (x === 0 && y === 0)) { o[i] = acc; continue; }
      if (px === px) acc += Math.hypot((x - px) * 111319.5, (y - py) * 111319.5 * Math.cos(x * Math.PI / 180));
      px = x; py = y; o[i] = acc;
    }
    return { t: A.t, v: o, unit: 'm', step: false, konst: false };
  });
  fn(['tilt'], 'tilt(roll, pitch)', 'Total lean angle in degrees from roll and pitch in degrees.', ['tilt(ATT.Roll, ATT.Pitch)'], 2, 2, a => map2(a[0], a[1], (r, p) => Math.acos(Math.min(1, Math.cos(r * Math.PI / 180) * Math.cos(p * Math.PI / 180))) * 180 / Math.PI, 'deg'));

  /* ---------------- evaluation ---------------- */
  const CONSTS = { pi: Math.PI, e: Math.E, g: 9.80665, nan: NaN, inf: Infinity, true: 1, false: 0 };
  const CACHE = new Map();
  let cacheBytes = 0;
  const CACHE_MAX = 512 * 1024 * 1024;
  function cacheGet(key) { const v = CACHE.get(key); if (v) { CACHE.delete(key); CACHE.set(key, v); } return v; }
  function cachePut(key, val) {
    if (!isS(val)) return;
    const b = val.v.byteLength + (val.t.byteLength || 0) / 4;
    if (b > CACHE_MAX / 2) return;
    CACHE.set(key, val); cacheBytes += b;
    for (const [k, v] of CACHE) { if (cacheBytes <= CACHE_MAX) break; CACHE.delete(k); cacheBytes -= v.v.byteLength + (v.t.byteLength || 0) / 4; }
  }
  function setLog(ix) { LOG = ix; CACHE.clear(); cacheBytes = 0; }

  function suggest(word, list, max = 3) {
    const w = word.toLowerCase();
    const scored = [];
    for (const c of list) {
      const l = c.toLowerCase();
      let d = lev(w, l, 4);
      if (l.startsWith(w) || l.includes(w)) d = Math.min(d, 1);
      if (d <= Math.max(2, Math.floor(w.length / 3))) scored.push([d, c]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
    return scored.slice(0, max).map(s => s[1]);
  }
  function lev(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = new Array(b.length + 1), cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i; let best = i;
      for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < best) best = cur[j]; }
      if (best > cap) return cap + 1;
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }
  const orList = xs => xs.length ? ` Did you mean ${xs.map(x => x).join(' or ')}?` : '';

  function needLog(node) { if (!LOG) throw new FormulaError('Open a log first', node.pos, node.end); }
  function paramRec(name) {
    if (!LOG) return null;
    let p = LOG.params.get(name);
    if (!p) { const up = name.toUpperCase(); for (const [k, v] of LOG.params) if (k.toUpperCase() === up) { p = v; break; } }
    return p || null;
  }
  function paramSeries(name, node) {
    needLog(node);
    const p = paramRec(name);
    if (!p) throw new FormulaError(`This log has no parameter ${name}.` + orList(suggest(name, [...LOG.params.keys()])), node.pos, node.end);
    return { t: Float64Array.from(p.t), v: Float64Array.from(p.v), unit: '', step: true, konst: false, param: p.name };
  }
  function resolveRef(node) {
    needLog(node);
    const { msg, inst, col } = node;
    if (msg.toUpperCase() === 'PARM' && inst === null) {
      if (paramRec(col)) return { kind: 'param', name: paramRec(col).name };
    }
    const key = inst === null ? `${msg}.${col}` : `${msg}[${inst}].${col}`;
    const f = LOG.fieldIndex.get(key) || LOG.fieldLower.get(key.toLowerCase());
    if (f) return { kind: 'field', f };
    if (msg.toUpperCase() === 'PARM') throw new FormulaError(`This log has no parameter ${col}.` + orList(suggest(col, [...LOG.params.keys()])), node.pos, node.end);
    const ty = LOG.types.find(t => t.name === msg) || LOG.types.find(t => t.name.toLowerCase() === msg.toLowerCase());
    if (!ty) throw new FormulaError(`This log has no ${msg} messages.` + orList(suggest(msg, LOG.types.map(t => t.name))), node.pos, node.end);
    const colHit = ty.cols.find(c => c.col.toLowerCase() === col.toLowerCase());
    if (!colHit) throw new FormulaError(`${ty.name} has no column ${col}.` + (suggest(col, ty.cols.map(c => c.col)).length ? orList(suggest(col, ty.cols.map(c => c.col))) : ` Its columns: ${ty.cols.map(c => c.col).join(', ')}.`), node.pos, node.end);
    throw new FormulaError(`${ty.name} has no instance ${inst}. It has ${ty.insts.map(i => `[${i}]`).join(', ')}.`, node.pos, node.end);
  }
  function stepSeries(times, values) { return { t: Float64Array.from(times), v: Float64Array.from(values), unit: '', step: true, konst: false }; }
  function builtin(name, node) {
    needLog(node);
    if (name === 'armed') {
      const T = [LOG.tMin], V = [0];
      for (const a of LOG.armed) { T.push(a.t0, a.t1); V.push(1, 0); }
      return stepSeries(T, V);
    }
    if (name === 'mode') {
      if (!LOG.modes.length) throw new FormulaError('This log has no MODE messages', node.pos, node.end);
      return Object.assign(stepSeries(LOG.modes.map(m => m.t), LOG.modes.map(m => m.mode)), { isMode: true });
    }
    return undefined;
  }

  function makeCtx(vars) { return { vars: vars || new Map(), parsed: new Map(), stack: [] }; }
  function varDef(ctx, name) {
    let key = name;
    if (!ctx.vars.has(key)) { for (const k of ctx.vars.keys()) if (k.toLowerCase() === name.toLowerCase()) { key = k; break; } }
    if (!ctx.vars.has(key)) return null;
    let p = ctx.parsed.get(key);
    if (!p) {
      const text = ctx.vars.get(key), sp = splitName(text);
      try { p = { name: key, ast: parse(sp.body) }; } catch (e) { p = { name: key, error: e }; }
      ctx.parsed.set(key, p);
    }
    return p;
  }
  function canon(node, ctx) {
    switch (node.k) {
      case 'num': return String(node.v);
      case 'str': return JSON.stringify(node.v);
      case 'ref': {
        try { const r = resolveRef(node); return r.kind === 'param' ? `P:${r.name}` : `F:${r.f.id}`; } catch (e) { return node.text; }
      }
      case 'id': {
        const lname = node.name.toLowerCase();
        if (lname in CONSTS) return lname;
        const vd = varDef(ctx, node.name);
        if (vd && vd.ast && !ctx.stack.includes(vd.name)) { ctx.stack.push(vd.name); const s = '(' + canon(vd.ast, ctx) + ')'; ctx.stack.pop(); return s; }
        return node.name;
      }
      case 'call': {
        const f = FN[node.name.toLowerCase()];
        return (f ? f.name : node.name) + '(' + node.args.map(a => canon(a, ctx)).join(',') + ')';
      }
      case 'un': return node.op + '(' + canon(node.a, ctx) + ')';
      case 'bin': return '(' + canon(node.a, ctx) + node.op + canon(node.b, ctx) + ')';
      case 'tern': return '(' + canon(node.c, ctx) + '?' + canon(node.a, ctx) + ':' + canon(node.b, ctx) + ')';
    }
    return '?';
  }

  function ev(node, ctx) {
    switch (node.k) {
      case 'num': return node.v;
      case 'str': throw new FormulaError('Text in quotes only goes inside param("…")', node.pos, node.end);
      case 'ref': {
        const r = resolveRef(node);
        return r.kind === 'param' ? paramSeries(r.name, node) : r.f.series;
      }
      case 'id': return evId(node, ctx);
      case 'un': {
        const a = ev(node.a, ctx);
        if (node.op === '-') return map1(a, v => -v);
        if (node.op === '+') return a;
        return map1(a, v => v !== v ? NaN : (v ? 0 : 1), '');
      }
      case 'bin': {
        const a = ev(node.a, ctx), b = ev(node.b, ctx);
        return map2(a, b, BIN[node.op], binUnit(node.op, a, b));
      }
      case 'tern': {
        const c = ev(node.c, ctx), a = ev(node.a, ctx), b = ev(node.b, ctx);
        return mapK([c, a, b], ([x, y, z]) => x !== x ? NaN : (x ? y : z), unitOf(a, b));
      }
      case 'call': {
        const key = canon(node, ctx);
        const hit = cacheGet(key);
        if (hit) return hit;
        const val = evCall(node, ctx);
        cachePut(key, val);
        return val;
      }
    }
    throw new FormulaError('Unexpected input', node.pos, node.end);
  }
  function evId(node, ctx) {
    const name = node.name, lname = name.toLowerCase();
    if (lname in CONSTS) return CONSTS[lname];
    const vd = varDef(ctx, name);
    if (vd) {
      if (ctx.stack.includes(vd.name)) throw new FormulaError(`${vd.name} refers back to itself`, node.pos, node.end);
      if (vd.error) throw new FormulaError(`The field named ${vd.name} has an error: ${vd.error.message}`, node.pos, node.end);
      const key = 'V:' + canon(vd.ast, ctx);
      const hit = cacheGet(key);
      if (hit) return hit;
      ctx.stack.push(vd.name);
      try { const v = ev(vd.ast, ctx); cachePut(key, v); return v; }
      catch (e) {
        if (!(e instanceof FormulaError)) throw e;
        const w = new FormulaError(e._wrapped ? e.message : `The field named ${vd.name} has an error: ${e.message}`, node.pos, node.end);
        w._wrapped = true; throw w;
      }
      finally { ctx.stack.pop(); }
    }
    if (lname === 'armed' || lname === 'mode') return builtin(lname, node);
    if (LOG) { const m = DF.modeNumber(LOG, name); if (m !== undefined) return m; }
    if (FN[lname]) throw new FormulaError(`${name} is a function. Add brackets: ${FN[lname].sig}`, node.pos, node.end);
    if (LOG && LOG.types.some(t => t.name === name)) throw new FormulaError(`Add a column after ${name}, such as ${name}.${LOG.types.find(t => t.name === name).cols[0].col}`, node.pos, node.end);
    const pool = [...Object.keys(CONSTS), 'armed', 'mode', ...ctx.vars.keys()];
    throw new FormulaError(`Unknown name “${name}”.` + orList(suggest(name, pool)) + (/^[A-Z][A-Z0-9_]*$/.test(name) && LOG && paramRec(name) ? ` For the parameter, write PARM.${name}.` : ''), node.pos, node.end);
  }
  function evCall(node, ctx) {
    const f = FN[node.name.toLowerCase()];
    if (!f) throw new FormulaError(`There is no function ${node.name}().` + orList(suggest(node.name, Object.keys(FN))), node.pos, node.nameEnd);
    checkCount(f, node);
    if (f.raw) {
      const a = node.args[0];
      const name = a.k === 'str' ? a.v : a.k === 'id' ? a.name : a.k === 'ref' ? a.text : null;
      if (!name) throw new FormulaError('Write the parameter name in quotes: param("ATC_RAT_RLL_P")', a.pos, a.end);
      return paramSeries(name, a);
    }
    const args = node.args.map(a => ev(a, ctx));
    return f.impl(args, node, ctx);
  }
  function checkCount(f, node) {
    const n = node.args.length;
    if (n < f.min || n > f.max) {
      const want = f.min === f.max ? `${f.min} argument${f.min > 1 ? 's' : ''}` : f.max >= 20 ? `at least ${f.min} arguments` : `${f.min} to ${f.max} arguments`;
      throw new FormulaError(`${f.name}() takes ${want}: ${f.sig}`, node.pos, node.end);
    }
  }

  /** Walk the formula without computing anything: names, functions and argument counts. */
  function checkNode(node, ctx) {
    switch (node.k) {
      case 'ref': resolveRef(node); return;
      case 'id': {
        const lname = node.name.toLowerCase();
        if (lname in CONSTS || lname === 'armed' || lname === 'mode') return;
        const vd = varDef(ctx, node.name);
        if (vd) {
          if (ctx.stack.includes(vd.name)) throw new FormulaError(`${vd.name} refers back to itself`, node.pos, node.end);
          if (vd.error) throw new FormulaError(`The field named ${vd.name} has an error: ${vd.error.message}`, node.pos, node.end);
          return;
        }
        if (LOG && DF.modeNumber(LOG, node.name) !== undefined) return;
        evId(node, ctx); return;
      }
      case 'un': checkNode(node.a, ctx); return;
      case 'bin': checkNode(node.a, ctx); checkNode(node.b, ctx); return;
      case 'tern': checkNode(node.c, ctx); checkNode(node.a, ctx); checkNode(node.b, ctx); return;
      case 'call': {
        const f = FN[node.name.toLowerCase()];
        if (!f) throw new FormulaError(`There is no function ${node.name}().` + orList(suggest(node.name, Object.keys(FN))), node.pos, node.nameEnd);
        checkCount(f, node);
        if (f.raw) { const a = node.args[0]; const name = a.k === 'str' ? a.v : a.k === 'id' ? a.name : null; if (!name) throw new FormulaError('Write the parameter name in quotes', a.pos, a.end); paramSeries(name, a); return; }
        for (const a of node.args) checkNode(a, ctx);
        return;
      }
      case 'str': throw new FormulaError('Text in quotes only goes inside param("…")', node.pos, node.end);
    }
  }
  function shiftErr(e, off) {
    if (e instanceof FormulaError) return { message: e.message, pos: e.pos + off, end: e.end + off };
    return { message: e && e.message ? e.message : String(e), pos: 0, end: 0 };
  }

  function badName(sp) {
    if (!sp.name) return null;
    const l = sp.name.toLowerCase();
    if (FN[l] || l in CONSTS || l === 'armed' || l === 'mode') return { message: `${sp.name} is already a built-in name. Pick another name.`, pos: 0, end: sp.name.length };
    if (LOG && DF.modeNumber(LOG, sp.name) !== undefined) return { message: `${sp.name} is a flight mode name. Pick another name.`, pos: 0, end: sp.name.length };
    return null;
  }

  /** Quick check while typing. Returns null or {message, pos, end}. */
  function check(text, vars) {
    const sp = splitName(text);
    const bad = badName(sp);
    if (bad) return bad;
    try {
      const ast = parse(sp.body);
      const ctx = makeCtx(vars);
      if (sp.name) ctx.stack.push(sp.name);
      checkNode(ast, ctx);
      return null;
    } catch (e) { return shiftErr(e, sp.offset); }
  }

  /** Evaluate a field's text. Returns {series, name, unit, key} or {error}. */
  function run(text, vars) {
    const sp = splitName(text);
    const bad = badName(sp);
    if (bad) return { error: bad, name: sp.name };
    try {
      const ast = parse(sp.body);
      const ctx = makeCtx(vars);
      if (sp.name) ctx.stack.push(sp.name);
      const key = canon(ast, ctx);
      let val = cacheGet('T:' + key);
      if (!val) {
        val = ev(ast, ctx);
        if (!isS(val)) val = konst(val, '');
        cachePut('T:' + key, val);
      }
      return { series: val, name: sp.name, unit: val.unit || '', key, simple: ast.k === 'ref' };
    } catch (e) {
      if (!(e instanceof FormulaError)) console.error(e);
      return { error: shiftErr(e, sp.offset), name: sp.name };
    }
  }

  /* ---------------- spectrum ---------------- */
  const TW = new Map();
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    let tw = TW.get(n);
    if (!tw) { tw = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) }; for (let k = 0; k < n / 2; k++) { tw.c[k] = Math.cos(-2 * Math.PI * k / n); tw.s[k] = Math.sin(-2 * Math.PI * k / n); } TW.set(n, tw); }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = tw.c[k * step], wi = tw.s[k * step];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
  }
  /** Averaged amplitude spectrum (Welch, Hann window, 50% overlap) of x between t0 and t1 (µs). */
  function spectrum(x, t0, t1, opt = {}) {
    if (!x || x.konst) return null;
    const T = x.t, i0 = lowerBound(T, t0), i1 = upperBound(T, t1);
    if (i1 - i0 < 32) return null;
    const mdt = medianDt(x), fs = 1e6 / mdt;
    const ta = T[i0], tb = T[i1 - 1];
    let N = Math.floor((tb - ta) / mdt) + 1;
    if (N < 32) return null;
    const stride = N > 4e6 ? Math.ceil(N / 4e6) : 1;
    // uniform samples, linear interpolation, gaps filled with the running mean later
    const u = new Float64Array(Math.ceil(N / stride));
    let j = i0;
    for (let k = 0, m = 0; k < N; k += stride, m++) {
      const t = ta + k * mdt;
      while (j + 1 < i1 && T[j + 1] < t) j++;
      const a = x.v[j], b = j + 1 < i1 ? x.v[j + 1] : a, tj = T[j], tk = j + 1 < i1 ? T[j + 1] : tj;
      u[m] = tk > tj && t > tj ? a + (b - a) * Math.min(1, (t - tj) / (tk - tj)) : a;
    }
    const fsU = fs / stride;
    N = u.length;
    // aim for about 0.5 Hz resolution (finer for slow fields), with at least a few averages
    let seg = opt.seg || Math.pow(2, Math.ceil(Math.log2(Math.max(64, fsU / (opt.res || 0.5)))));
    seg = Math.max(32, Math.min(seg, 8192, Math.pow(2, Math.floor(Math.log2(Math.max(32, N / 3))))));
    if (seg > N) seg = Math.pow(2, Math.floor(Math.log2(N)));
    let hop = seg / 2, count = Math.floor((N - seg) / hop) + 1;
    if (count > 800) { hop = Math.floor((N - seg) / 799); count = Math.floor((N - seg) / hop) + 1; }
    const w = new Float64Array(seg); let wsum = 0;
    for (let k = 0; k < seg; k++) { w[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (seg - 1)); wsum += w[k]; }
    const P = new Float64Array(seg / 2 + 1), re = new Float64Array(seg), im = new Float64Array(seg);
    let used = 0;
    for (let s = 0; s < count; s++) {
      const off = s * hop;
      let mean = 0, good = 0;
      for (let k = 0; k < seg; k++) { const v = u[off + k]; if (v === v) { mean += v; good++; } }
      if (good < seg * 0.9) continue;
      mean /= good;
      for (let k = 0; k < seg; k++) { const v = u[off + k]; re[k] = ((v === v ? v : mean) - mean) * w[k]; im[k] = 0; }
      fft(re, im);
      for (let k = 0; k <= seg / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
      used++;
    }
    if (!used) return null;
    const A = new Float64Array(seg / 2 + 1), F = new Float64Array(seg / 2 + 1);
    for (let k = 0; k <= seg / 2; k++) { A[k] = Math.sqrt(P[k] / used) * 2 / wsum; F[k] = k * fsU / seg; }
    A[0] /= 2;
    const peaks = [];
    for (let k = 2; k < seg / 2; k++) if (A[k] > A[k - 1] && A[k] >= A[k + 1]) peaks.push(k);
    peaks.sort((p, q) => A[q] - A[p]);
    const top = [];
    for (const k of peaks) {
      if (top.some(p => Math.abs(p.k - k) < Math.max(4, p.k * 0.15))) continue;
      const a = A[k - 1], b = A[k], c = A[k + 1], den = a - 2 * b + c, d = den ? 0.5 * (a - c) / den : 0;
      top.push({ k, f: (k + d) * fsU / seg, a: b });
      if (top.length === 3) break;
    }
    return { f: F, a: A, fs: fsU, seg, count: used, peaks: top, t0: ta, t1: tb, res: fsU / seg };
  }

  function fnList() {
    const seen = new Set(), outL = [];
    for (const c of CATS) for (const it of c.items) if (it.impl !== undefined && !seen.has(it)) { seen.add(it); outL.push(it); }
    return outL;
  }

  return { lex, parse, splitName, check, run, setLog, spectrum, medianDt, gapUs, isS, lowerBound, upperBound, resampleTo, CATS, FN, CONSTS, fnList, FormulaError };
})();
