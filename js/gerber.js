// Gerber RS-274X / X2 and Excellon drill parser.
// Output units: mm, Y up. Geometry is kept as SVG path data (y already flipped: svgY = -y).

const f = (n) => Math.round(n * 10000) / 10000;

// ---------------- aperture macro expressions ----------------
function evalExpr(src, vars) {
  const s = src.replace(/\s+/g, '').replace(/[xX]/g, '*');
  let i = 0;
  const peek = () => s[i];
  function num() {
    if (peek() === '$') { i++; let d = ''; while (/\d/.test(peek())) d += s[i++]; return vars[+d] ?? 0; }
    let t = '';
    while (i < s.length && /[0-9.]/.test(peek())) t += s[i++];
    return t ? parseFloat(t) : 0;
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr(); if (peek() === ')') i++; return v; }
    return num();
  }
  function term() { let v = factor(); while (peek() === '*' || peek() === '/') { const o = s[i++]; const r = factor(); v = o === '*' ? v * r : r ? v / r : 0; } return v; }
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const o = s[i++]; const r = term(); v = o === '+' ? v + r : v - r; } return v; }
  return expr();
}

// ---------------- shapes -> svg path (mm, local coords, svg y flipped) ----------------
const rot = (x, y, a) => { if (!a) return [x, y]; const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [x * c - y * s, x * s + y * c]; };
const P = (x, y) => `${f(x)} ${f(-y)}`;
function polyPath(pts) { return 'M' + pts.map(([x, y]) => P(x, y)).join('L') + 'Z'; }
function circlePath(cx, cy, r) {
  if (r <= 0) return '';
  return `M${P(cx + r, cy)}A${f(r)} ${f(r)} 0 1 0 ${P(cx - r, cy)}A${f(r)} ${f(r)} 0 1 0 ${P(cx + r, cy)}Z`;
}
function rectPts(cx, cy, w, h, a = 0) {
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => { const [rx, ry] = rot(x, y, a); return [cx + rx, cy + ry]; });
}
function obroundPath(w, h) {
  if (Math.abs(w - h) < 1e-9) return circlePath(0, 0, w / 2);
  if (w > h) { const r = h / 2, dx = w / 2 - r; return `M${P(-dx, -r)}L${P(dx, -r)}A${f(r)} ${f(r)} 0 0 0 ${P(dx, r)}L${P(-dx, r)}A${f(r)} ${f(r)} 0 0 0 ${P(-dx, -r)}Z`; }
  const r = w / 2, dy = h / 2 - r;
  return `M${P(r, -dy)}L${P(r, dy)}A${f(r)} ${f(r)} 0 0 0 ${P(-r, dy)}L${P(-r, -dy)}A${f(r)} ${f(r)} 0 0 0 ${P(r, -dy)}Z`;
}
function regPolyPts(cx, cy, d, n, a = 0) {
  const pts = [];
  for (let k = 0; k < n; k++) { const t = ((a + (360 * k) / n) * Math.PI) / 180; pts.push([cx + (d / 2) * Math.cos(t), cy + (d / 2) * Math.sin(t)]); }
  return pts;
}
function holePath(hole) {
  if (!hole || !hole.length || !(hole[0] > 0)) return '';
  if (hole.length === 1) return circlePath(0, 0, hole[0] / 2);
  return polyPath(rectPts(0, 0, hole[0], hole[1]));
}

/** standard aperture -> {d, w(stroke width for circle), bbox r} */
function stdAperture(type, p) {
  let d = '', r = 0, circ = 0, rectWH = null;
  if (type === 'C') { d = circlePath(0, 0, p[0] / 2) + holePath(p.slice(1)); r = p[0] / 2; circ = p[0]; }
  else if (type === 'R') { d = polyPath(rectPts(0, 0, p[0], p[1])) + holePath(p.slice(2)); r = Math.hypot(p[0], p[1]) / 2; rectWH = [p[0], p[1]]; }
  else if (type === 'O') { d = obroundPath(p[0], p[1]) + holePath(p.slice(2)); r = Math.max(p[0], p[1]) / 2; }
  else if (type === 'P') { d = polyPath(regPolyPts(0, 0, p[0], Math.max(3, Math.round(p[1])), p[2] || 0)) + holePath(p.slice(3)); r = p[0] / 2; }
  return { d, r, circ, rectWH, fillRule: 'evenodd' };
}

/** macro primitives -> list of {on, d} */
function macroAperture(body, params, scale) {
  const vars = {};
  params.forEach((v, i) => (vars[i + 1] = v));
  const parts = [];
  let rmax = 0;
  const grow = (pts) => { for (const [x, y] of pts) rmax = Math.max(rmax, Math.hypot(x, y)); };
  for (let raw of body) {
    raw = raw.trim();
    if (!raw || raw[0] === '0') continue;
    const vm = /^\$(\d+)=(.+)$/.exec(raw);
    if (vm) { vars[+vm[1]] = evalExpr(vm[2], vars); continue; }
    const a = raw.split(',').map((x) => evalExpr(x, vars));
    const code = Math.round(a[0]);
    const S = scale; // inch->mm
    try {
      switch (code) {
        case 1: { const [, on, dia, cx, cy, rt] = a; const [x, y] = rot(cx * S, cy * S, rt || 0); parts.push({ on: !!on, d: circlePath(x, y, (dia * S) / 2) }); rmax = Math.max(rmax, Math.hypot(x, y) + (dia * S) / 2); break; }
        case 2: case 20: { const [, on, w, sx, sy, ex, ey, rt] = a; const len = Math.hypot(ex - sx, ey - sy); const ang = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI; const pts = rectPts(((sx + ex) / 2) * S, ((sy + ey) / 2) * S, len * S, w * S, ang).map(([x, y]) => rot(x, y, rt || 0)); grow(pts); parts.push({ on: !!on, d: polyPath(pts) }); break; }
        case 21: { const [, on, w, h, cx, cy, rt] = a; const pts = rectPts(cx * S, cy * S, w * S, h * S).map(([x, y]) => rot(x, y, rt || 0)); grow(pts); parts.push({ on: !!on, d: polyPath(pts) }); break; }
        case 22: { const [, on, w, h, x0, y0, rt] = a; const pts = rectPts((x0 + w / 2) * S, (y0 + h / 2) * S, w * S, h * S).map(([x, y]) => rot(x, y, rt || 0)); grow(pts); parts.push({ on: !!on, d: polyPath(pts) }); break; }
        case 4: { const on = a[1], n = Math.round(a[2]); const pts = []; for (let k = 0; k <= n; k++) pts.push(rot(a[3 + k * 2] * S, a[4 + k * 2] * S, a[5 + n * 2] || 0)); grow(pts); parts.push({ on: !!on, d: polyPath(pts) }); break; }
        case 5: { const [, on, n, cx, cy, dia, rt] = a; const c = rot(cx * S, cy * S, rt || 0); const pts = regPolyPts(c[0], c[1], dia * S, Math.round(n), rt || 0); grow(pts); parts.push({ on: !!on, d: polyPath(pts) }); break; }
        case 6: { // moire
          const [, cx, cy, od, th, gap, nmax, cth, clen, rt] = a; let d = '';
          let ro = od / 2;
          for (let k = 0; k < nmax && ro > 0; k++) { const ri = Math.max(0, ro - th); const c = rot(cx * S, cy * S, rt || 0); d += circlePath(c[0], c[1], ro * S) + (ri > 0 ? circlePath(c[0], c[1], ri * S) : ''); ro = ri - gap; }
          parts.push({ on: true, d, evenodd: true });
          for (const ang of [0, 90]) { const pts = rectPts(cx * S, cy * S, clen * S, cth * S, ang).map(([x, y]) => rot(x, y, rt || 0)); parts.push({ on: true, d: polyPath(pts) }); }
          rmax = Math.max(rmax, (Math.max(od, clen) * S) / 2 + Math.hypot(cx, cy) * S);
          break;
        }
        case 7: { // thermal
          const [, cx, cy, od, id, gap, rt] = a; const c = rot(cx * S, cy * S, rt || 0);
          parts.push({ on: true, d: circlePath(c[0], c[1], (od * S) / 2) + circlePath(c[0], c[1], (id * S) / 2), evenodd: true });
          for (const ang of [0, 90]) { const pts = rectPts(cx * S, cy * S, od * S * 1.05, gap * S, ang).map(([x, y]) => rot(x, y, rt || 0)); parts.push({ on: false, d: polyPath(pts) }); }
          rmax = Math.max(rmax, (od * S) / 2 + Math.hypot(cx, cy) * S);
          break;
        }
        default: break;
      }
    } catch (e) { /* skip bad primitive */ }
  }
  return { parts, r: rmax, macro: true };
}

// ---------------- Gerber ----------------
export function parseGerber(text) {
  const out = { kind: 'gerber', blocks: [], aps: {}, attrs: {}, bbox: [Infinity, Infinity, -Infinity, -Infinity], nObjects: 0 };
  let fmt = { int: 2, dec: 5, zeros: 'L' }, scale = 25.4; // default inch
  let unitSet = false;
  const macros = {};
  let cur = { dark: true, items: [] };
  out.blocks.push(cur);
  let ap = null, interp = 1, quadrant = 'multi', x = 0, y = 0, lastD = 2;
  let region = false, contour = [], regionParts = [];
  let srStack = null; // {x,y,i,j, start index}
  const objAttrs = {};
  let tf = {};
  const grow = (x1, y1, r = 0) => { const b = out.bbox; b[0] = Math.min(b[0], x1 - r); b[1] = Math.min(b[1], y1 - r); b[2] = Math.max(b[2], x1 + r); b[3] = Math.max(b[3], y1 + r); };
  const attrs = () => { const a = {}; if (objAttrs.N != null) a.net = objAttrs.N; if (objAttrs.C != null) a.comp = objAttrs.C; if (objAttrs.P != null) a.pin = objAttrs.P; return a; };
  const coord = (s) => {
    if (s == null) return null;
    if (s.includes('.')) return parseFloat(s) * scale;
    let neg = s[0] === '-'; if (s[0] === '-' || s[0] === '+') s = s.slice(1);
    const tot = fmt.int + fmt.dec;
    if (fmt.zeros === 'T') s = s.padEnd(tot, '0'); else s = s.padStart(tot, '0');
    const v = parseInt(s, 10) / Math.pow(10, fmt.dec);
    return (neg ? -v : v) * scale;
  };
  const push = (it) => { cur.items.push(it); out.nObjects++; };

  function arcPath(x0, y0, x1, y1, i, j, cw) {
    // returns {cx, cy, r, sweep, large, d}
    let cx, cy;
    if (quadrant === 'single') {
      let best = null;
      for (const [si, sj] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ccx = x0 + si * Math.abs(i), ccy = y0 + sj * Math.abs(j);
        const r0 = Math.hypot(x0 - ccx, y0 - ccy), r1 = Math.hypot(x1 - ccx, y1 - ccy);
        let a0 = Math.atan2(y0 - ccy, x0 - ccx), a1 = Math.atan2(y1 - ccy, x1 - ccx);
        let span = cw ? a0 - a1 : a1 - a0; while (span < 0) span += 2 * Math.PI; while (span > 2 * Math.PI) span -= 2 * Math.PI;
        const err = Math.abs(r0 - r1);
        if (span <= Math.PI / 2 + 1e-6 && (!best || err < best.err)) best = { ccx, ccy, err };
      }
      if (!best) best = { ccx: x0 + i, ccy: y0 + j };
      cx = best.ccx; cy = best.ccy;
    } else { cx = x0 + i; cy = y0 + j; }
    const r = Math.hypot(x0 - cx, y0 - cy);
    let a0 = Math.atan2(y0 - cy, x0 - cx), a1 = Math.atan2(y1 - cy, x1 - cx);
    let span = cw ? a0 - a1 : a1 - a0; while (span <= 0) span += 2 * Math.PI; while (span > 2 * Math.PI) span -= 2 * Math.PI;
    const full = Math.abs(x0 - x1) < 1e-7 && Math.abs(y0 - y1) < 1e-7 && quadrant === 'multi';
    if (full) span = 2 * Math.PI;
    // SVG with flipped y: CCW in gerber == sweep-flag 0
    const sweep = cw ? 1 : 0;
    let d;
    if (full) { const mx = 2 * cx - x0, my = 2 * cy - y0; d = `A${f(r)} ${f(r)} 0 1 ${sweep} ${P(mx, my)}A${f(r)} ${f(r)} 0 1 ${sweep} ${P(x1, y1)}`; }
    else d = `A${f(r)} ${f(r)} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${P(x1, y1)}`;
    return { cx, cy, r, d };
  }

  function flushContour() {
    if (contour.length > 1) regionParts.push('M' + contour.join('') + 'Z');
    contour = [];
  }

  function doOp(op, nx, ny, i, j) {
    if (op === 2) { if (region) { flushContour(); contour = [P(nx, ny)]; } x = nx; y = ny; return; }
    if (op === 3) {
      if (!ap) return;
      const a = out.aps[ap];
      if (!a) { x = nx; y = ny; return; }
      push({ t: 'F', x: nx, y: ny, ap, ...attrs() });
      grow(nx, ny, a.r || 0);
      x = nx; y = ny; return;
    }
    // D01
    if (region) {
      if (!contour.length) contour = [P(x, y)];
      if (interp === 1) contour.push('L' + P(nx, ny));
      else { const r = arcPath(x, y, nx, ny, i || 0, j || 0, interp === 2); contour.push(r.d); grow(r.cx, r.cy, r.r); }
      grow(nx, ny);
      x = nx; y = ny; return;
    }
    const a = out.aps[ap];
    if (!a) { x = nx; y = ny; return; }
    if (interp === 1) {
      if (a.rectWH && !a.circ) {
        // rectangle aperture swept along segment -> hexagon (Minkowski sum)
        const [w, h] = a.rectWH; const pts = [];
        const cs = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
        for (const [cxo, cyo] of cs) pts.push([x + cxo, y + cyo], [nx + cxo, ny + cyo]);
        push({ t: 'R', d: hullPath(pts), ...attrs() });
      } else {
        push({ t: 'L', x1: x, y1: y, x2: nx, y2: ny, w: a.circ || a.r * 2, ...attrs() });
      }
      grow(x, y, a.r); grow(nx, ny, a.r);
    } else {
      const r = arcPath(x, y, nx, ny, i || 0, j || 0, interp === 2);
      push({ t: 'A', d: `M${P(x, y)}${r.d}`, w: a.circ || a.r * 2, x1: x, y1: y, x2: nx, y2: ny, cx: r.cx, cy: r.cy, r: r.r, cw: interp === 2, ...attrs() });
      grow(r.cx, r.cy, r.r + a.r);
    }
    x = nx; y = ny;
  }

  // tokenizer
  let p = 0;
  const N = text.length;
  let nextPct = -1; // cached position of the next '%'
  while (p < N) {
    const c = text[p];
    if (c === '\n' || c === '\r' || c === ' ' || c === '\t') { p++; continue; }
    if (c === '%') {
      const e = text.indexOf('%', p + 1);
      const blk = text.slice(p + 1, e < 0 ? N : e);
      p = e < 0 ? N : e + 1;
      const cmds = blk.split('*').map((s) => s.replace(/[\r\n]/g, '')).filter((s) => s.length);
      if (!cmds.length) continue;
      const first = cmds[0];
      const code = first.slice(0, 2);
      if (code === 'FS') {
        const m = /FS([LTD]?)([AI]?)X(\d)(\d)Y(\d)(\d)/.exec(first);
        if (m) fmt = { zeros: m[1] === 'T' ? 'T' : 'L', int: +m[3], dec: +m[4] };
      } else if (code === 'MO') { scale = /MM/.test(first) ? 1 : 25.4; unitSet = true; }
      else if (code === 'AD') {
        const m = /^ADD(\d+)([^,]+)(?:,(.*))?$/.exec(first);
        if (m) {
          const id = +m[1], nm = m[2], params = m[3] ? m[3].split('X').map((v) => parseFloat(v)) : [];
          if (/^[CROP]$/.test(nm)) { const sp = params.map((v, k) => (nm === 'P' && (k === 1 || k === 2) ? v : v * scale)); out.aps[id] = stdAperture(nm, sp); }
          else if (macros[nm]) out.aps[id] = macroAperture(macros[nm], params, scale);
          else out.aps[id] = { d: '', r: 0 };
        }
      } else if (code === 'AM') {
        macros[first.slice(2)] = cmds.slice(1);
      } else if (code === 'LP') {
        const dark = first[2] !== 'C';
        if (dark !== cur.dark) { cur = { dark, items: [] }; out.blocks.push(cur); }
      } else if (code === 'SR') {
        const m = /SR(?:X(\d+))?(?:Y(\d+))?(?:I([\d.]+))?(?:J([\d.]+))?/.exec(first);
        // close previous SR
        if (srStack) endSR();
        const xr = m && m[1] ? +m[1] : 1, yr = m && m[2] ? +m[2] : 1;
        if (xr > 1 || yr > 1) srStack = { xr, yr, i: (m[3] ? +m[3] : 0) * scale, j: (m[4] ? +m[4] : 0) * scale, blockIdx: out.blocks.length - 1, itemIdx: cur.items.length, startBlocks: out.blocks.length };
      } else if (code === 'TF') {
        const parts = first.slice(2).split(','); tf[parts[0].replace(/^\./, '')] = parts.slice(1);
      } else if (code === 'TO') {
        const parts = first.slice(2).split(',');
        const k = parts[0].replace(/^\./, '');
        if (k === 'N') objAttrs.N = parts.slice(1).join(',');
        else if (k === 'C') objAttrs.C = parts[1];
        else if (k === 'P') objAttrs.P = parts.slice(1, 3).join('.');
      } else if (code === 'TD') {
        const k = first.slice(2).replace(/^\./, '');
        if (!k) { delete objAttrs.N; delete objAttrs.C; delete objAttrs.P; } else delete objAttrs[k];
      } else if (code === 'IP') { /* image polarity: ignore (positive) */ }
      continue;
    }
    // word command up to '*'
    let e = text.indexOf('*', p);
    if (nextPct < p) { nextPct = text.indexOf('%', p); if (nextPct < 0) nextPct = N; }
    if (nextPct < N && (e < 0 || nextPct < e)) e = nextPct - 1; // never swallow an extended block
    let w = text.slice(p, e < 0 ? N : e).replace(/[\r\n\s]/g, '');
    p = e < 0 ? N : e + 1;
    if (!w) continue;
    if (w.startsWith('G04') || w.startsWith('G4')) continue;
    if (w === 'M02' || w === 'M00' || w === 'M2') break;
    // deprecated unit codes
    if (w.startsWith('G70')) { if (!unitSet) scale = 25.4; w = w.slice(3); }
    else if (w.startsWith('G71')) { if (!unitSet) scale = 1; w = w.slice(3); }
    if (w.startsWith('G54')) w = w.slice(3);
    if (w.startsWith('G55')) w = w.slice(3);
    // G codes that can prefix coordinates
    let gm;
    while ((gm = /^G0?([0-9]{1,2})/.exec(w))) {
      const g = +gm[1];
      if (g === 1 || g === 2 || g === 3) interp = g;
      else if (g === 74) quadrant = 'single';
      else if (g === 75) quadrant = 'multi';
      else if (g === 36) { region = true; contour = []; regionParts = []; }
      else if (g === 37) { flushContour(); if (regionParts.length) push({ t: 'R', d: regionParts.join(''), ...attrs() }); region = false; regionParts = []; }
      w = w.slice(gm[0].length);
    }
    if (!w) continue;
    const dsel = /^D(\d+)$/.exec(w);
    if (dsel && +dsel[1] >= 10) { ap = +dsel[1]; continue; }
    const m = /^(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?(?:I([+-]?[\d.]+))?(?:J([+-]?[\d.]+))?(?:D0?([123]))?$/.exec(w);
    if (!m) continue;
    const nx = m[1] != null ? coord(m[1]) : x;
    const ny = m[2] != null ? coord(m[2]) : y;
    const ii = m[3] != null ? coord(m[3]) : 0, jj = m[4] != null ? coord(m[4]) : 0;
    let op = m[5] != null ? +m[5] : lastD;
    lastD = op;
    doOp(op, nx, ny, ii, jj);
  }
  if (srStack) endSR();

  function endSR() {
    const s = srStack; srStack = null;
    // collect items added since SR start (in current and later blocks) and replicate with offsets
    const copies = [];
    for (let bi = s.blockIdx; bi < out.blocks.length; bi++) {
      const b = out.blocks[bi];
      const from = bi === s.blockIdx ? s.itemIdx : 0;
      copies.push({ b, items: b.items.slice(from) });
    }
    for (let ix = 0; ix < s.xr; ix++) for (let iy = 0; iy < s.yr; iy++) {
      if (!ix && !iy) continue;
      for (const { b, items } of copies) for (const it of items) b.items.push({ ...it, ox: (it.ox || 0) + ix * s.i, oy: (it.oy || 0) + iy * s.j });
    }
    const bb = out.bbox; bb[2] += (s.xr - 1) * s.i; bb[3] += (s.yr - 1) * s.j;
  }

  out.attrs = tf;
  if (!isFinite(out.bbox[0])) out.bbox = [0, 0, 0, 0];
  return out;
}

function hullPath(pts) {
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of s.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return polyPath(lo.slice(0, -1).concat(up.slice(0, -1)));
}

// ---------------- Excellon ----------------
export function parseExcellon(text) {
  const out = { kind: 'drill', holes: [], slots: [], tools: {}, bbox: [Infinity, Infinity, -Infinity, -Infinity], plated: null };
  let scale = 25.4, zeros = 'T' /* trailing zeros present -> leading suppressed */, int = 2, dec = 4, fmtSet = false;
  let tool = null, x = 0, y = 0, route = false, plunge = false, interp = 0;
  const grow = (px, py, r) => { const b = out.bbox; b[0] = Math.min(b[0], px - r); b[1] = Math.min(b[1], py - r); b[2] = Math.max(b[2], px + r); b[3] = Math.max(b[3], py + r); };
  const coord = (s) => {
    if (s == null) return null;
    if (s.includes('.')) return parseFloat(s) * scale;
    const neg = s[0] === '-'; if (/^[+-]/.test(s)) s = s.slice(1);
    const tot = int + dec;
    // LZ: leading zeros kept -> trailing may be suppressed -> pad right ; TZ: trailing kept -> pad left
    s = zeros === 'L' ? s.padEnd(tot, '0') : s.padStart(tot, '0');
    const v = parseInt(s, 10) / Math.pow(10, dec);
    return (neg ? -v : v) * scale;
  };
  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith(';')) {
      const fm = /FILE_FORMAT=(\d):(\d)/i.exec(l); if (fm) { int = +fm[1]; dec = +fm[2]; fmtSet = true; }
      if (/TYPE=PLATED/i.test(l)) out.plated = true;
      if (/TYPE=NON_PLATED/i.test(l)) out.plated = false;
      continue;
    }
    if (/^(METRIC|INCH)/.test(l) || l === 'M71' || l === 'M72') {
      if (/^METRIC|M71/.test(l)) { scale = 1; if (!fmtSet) { int = 3; dec = 3; } } else { scale = 25.4; if (!fmtSet) { int = 2; dec = 4; } }
      if (/,LZ/.test(l)) zeros = 'L'; else if (/,TZ/.test(l)) zeros = 'T';
      const fm2 = /,(0+)\.(0+)/.exec(l); if (fm2) { int = fm2[1].length; dec = fm2[2].length; fmtSet = true; }
      continue;
    }
    const td = /^T(\d+)(?:F[\d.]+)?(?:S[\d.]+)?C([\d.]+)/.exec(l);
    if (td) { out.tools[+td[1]] = parseFloat(td[2]) * scale; continue; }
    const ts = /^T(\d+)$/.exec(l);
    if (ts) { tool = +ts[1]; continue; }
    if (l === 'M15') { plunge = true; continue; }
    if (l === 'M16' || l === 'M17') { plunge = false; continue; }
    if (l === 'M48' || l === '%' || l === 'M95' || /^(FMAT|VER|ICI|ATC)/.test(l)) continue;
    if (l === 'G05' || l === 'G5' || l === 'M30' || l === 'M00') { route = false; if (l !== 'G05' && l !== 'G5') plunge = false; continue; }
    const d = out.tools[tool] || 0.5;
    const g85 = /^X([+-]?[\d.]+)?Y?([+-]?[\d.]+)?G85X([+-]?[\d.]+)?Y?([+-]?[\d.]+)?/.exec(l);
    if (/G85/.test(l)) {
      const parts = l.split('G85');
      const pa = parseXY(parts[0]), pb = parseXY(parts[1]);
      const x1 = pa.x ?? x, y1 = pa.y ?? y, x2 = pb.x ?? x1, y2 = pb.y ?? y1;
      out.slots.push({ x1, y1, x2, y2, d, tool }); grow(x1, y1, d / 2); grow(x2, y2, d / 2); x = x2; y = y2; continue;
    }
    const gm = /^G0?([0-3])/.exec(l);
    let rest = l;
    if (gm) { const g = +gm[1]; if (g === 0) { route = true; interp = 0; } else { route = true; interp = g; } rest = l.slice(gm[0].length); }
    if (!/^[XY]/.test(rest)) continue;
    const q = parseXY(rest);
    const nx = q.x ?? x, ny = q.y ?? y;
    if (route) { if (plunge && interp >= 1) { out.slots.push({ x1: x, y1: y, x2: nx, y2: ny, d, tool }); grow(nx, ny, d / 2); } }
    else { out.holes.push({ x: nx, y: ny, d, tool }); grow(nx, ny, d / 2); }
    x = nx; y = ny;
  }
  function parseXY(str) {
    const xs = /X([+-]?[\d.]+)/.exec(str), ys = /Y([+-]?[\d.]+)/.exec(str);
    return { x: xs ? coord(xs[1]) : null, y: ys ? coord(ys[1]) : null };
  }
  if (!isFinite(out.bbox[0])) out.bbox = [0, 0, 0, 0];
  return out;
}

// ---------------- layer identification ----------------
// returns {type, side, label, order}
const TYPE_ORDER = { outline: 0, mech: 1, copper: 2, mask: 3, paste: 4, silk: 5, drill: 6, drawing: 7, other: 8 };
export function identifyLayer(name, x2) {
  const n = name.toLowerCase();
  const ext = (/\.([a-z0-9]+)$/.exec(n) || [])[1] || '';
  const ff = x2 && x2.FileFunction ? x2.FileFunction.map((s) => s.toLowerCase()) : null;
  const L = (type, side, label) => ({ type, side, label, order: TYPE_ORDER[type] ?? 9 });
  if (ff) {
    const k = ff[0];
    if (k === 'copper') { const side = ff[2] === 'top' ? 'top' : ff[2] === 'bot' ? 'bottom' : 'inner'; return L('copper', side, side === 'top' ? 'Top – miedź' : side === 'bottom' ? 'Bottom – miedź' : `Miedź ${ff[1].toUpperCase()}`); }
    if (k === 'soldermask') return L('mask', ff[1] === 'bot' ? 'bottom' : 'top', ff[1] === 'bot' ? 'Bottom – maska' : 'Top – maska');
    if (k === 'legend') return L('silk', ff[1] === 'bot' ? 'bottom' : 'top', ff[1] === 'bot' ? 'Bottom – opisy' : 'Top – opisy');
    if (k === 'paste') return L('paste', ff[1] === 'bot' ? 'bottom' : 'top', ff[1] === 'bot' ? 'Bottom – pasta' : 'Top – pasta');
    if (k === 'profile') return L('outline', 'all', 'Obrys płytki');
    if (k === 'plated' || k === 'nonplated') return L('drill', 'all', k === 'plated' ? 'Wiercenia metalizowane' : 'Wiercenia niemetalizowane');
    if (k === 'drillmap') return L('drawing', 'all', 'Rysunek wierceń');
    if (k === 'keepout') return L('mech', 'all', 'Keep-out');
  }
  // Altium / generic Protel extensions
  if (ext === 'gtl') return L('copper', 'top', 'Top – miedź');
  if (ext === 'gbl') return L('copper', 'bottom', 'Bottom – miedź');
  if (/^g\d+$/.test(ext)) return L('copper', 'inner', 'Miedź wewn. ' + ext.slice(1));
  if (/^gp\d+$/.test(ext)) return L('copper', 'inner', 'Plane ' + ext.slice(2));
  if (ext === 'gto') return L('silk', 'top', 'Top – opisy');
  if (ext === 'gbo') return L('silk', 'bottom', 'Bottom – opisy');
  if (ext === 'gts') return L('mask', 'top', 'Top – maska');
  if (ext === 'gbs') return L('mask', 'bottom', 'Bottom – maska');
  if (ext === 'gtp') return L('paste', 'top', 'Top – pasta');
  if (ext === 'gbp') return L('paste', 'bottom', 'Bottom – pasta');
  if (ext === 'gko') return L('outline', 'all', 'Keep-out / obrys');
  if (ext === 'mil' || ext === 'gml' || ext === 'gm' || ext === 'gbr' && /edge[._]cuts|profile|outline/.test(n)) return L('outline', 'all', 'Obrys płytki');
  if (/^gm\d+$/.test(ext)) return L('mech', 'all', 'Mechaniczna ' + ext.slice(2));
  if (/^gd\d+$/.test(ext)) return L('drawing', 'all', 'Rysunek wierceń');
  if (/^gg\d+$/.test(ext)) return L('drawing', 'all', 'Prowadnica wierceń');
  if (ext === 'gpt' || ext === 'gpb') return L('other', ext === 'gpt' ? 'top' : 'bottom', ext === 'gpt' ? 'Top – pad master' : 'Bottom – pad master');
  if (['txt', 'drl', 'drd', 'xln', 'exc', 'nc', 'tap'].includes(ext)) return L('drill', 'all', /non.?plated|npth/.test(n) ? 'Wiercenia niemetalizowane' : 'Wiercenia');
  // KiCad / Eagle names
  if (/[-_.]f[._]cu\b|\.cmp$|\.top$/.test(n)) return L('copper', 'top', 'Top – miedź');
  if (/[-_.]b[._]cu\b|\.sol$|\.bot$/.test(n)) return L('copper', 'bottom', 'Bottom – miedź');
  if (/[-_.]in\d+[._]cu\b/.test(n)) return L('copper', 'inner', 'Miedź wewn.');
  if (/[-_.]f[._]mask\b|\.stc$/.test(n)) return L('mask', 'top', 'Top – maska');
  if (/[-_.]b[._]mask\b|\.sts$/.test(n)) return L('mask', 'bottom', 'Bottom – maska');
  if (/[-_.]f[._]silk|\.plc$/.test(n)) return L('silk', 'top', 'Top – opisy');
  if (/[-_.]b[._]silk|\.pls$/.test(n)) return L('silk', 'bottom', 'Bottom – opisy');
  if (/[-_.]f[._]paste|\.crc$/.test(n)) return L('paste', 'top', 'Top – pasta');
  if (/[-_.]b[._]paste|\.crs$/.test(n)) return L('paste', 'bottom', 'Bottom – pasta');
  if (/edge[._]cuts|\.dim$|\.gko$|outline|profile/.test(n)) return L('outline', 'all', 'Obrys płytki');
  return L('other', 'all', name);
}

/** is this file likely a Gerber/drill file? (by extension or content sniff) */
export const GERBER_EXT = /\.(gtl|gbl|g\d{1,2}|gp\d{1,2}|gto|gbo|gts|gbs|gtp|gbp|gko|gm\d{1,2}|gml|gd\d{1,2}|gg\d{1,2}|gpt|gpb|gbr|ger|pho|art|cmp|sol|plc|pls|stc|sts|crc|crs|dim|drl|drd|xln)$/i;
export const DRILL_TXT = /\.txt$/i;
export function sniffKind(text) {
  const head = text.slice(0, 4000);
  if (/^\s*M48/m.test(head) || /^\s*;\s*(DRILL|FILE_FORMAT|TYPE=)/im.test(head) || /^\s*T\d+C[\d.]+/m.test(head)) return 'drill';
  if (/%FS[LTD]?[AI]?X\d\dY\d\d/.test(head) || /%MO(MM|IN)\*%/.test(head) || /G04 /.test(head)) return 'gerber';
  return null;
}
