import { parseGerber, parseExcellon, identifyLayer, sniffKind } from "./gerber.js";
// Gerber set -> SVG markup (mm, svg y = -y)
const f = (n) => Math.round(n * 10000) / 10000;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const LAYER_COLORS = {
  'copper:top': '#d23a3a', 'copper:bottom': '#3d6fd6', 'copper:inner': '#3fae6a',
  'silk:top': '#f1e15a', 'silk:bottom': '#c2a640', 'mask:top': '#a855f7', 'mask:bottom': '#d08cf5',
  'paste:top': '#9aa3ad', 'paste:bottom': '#7d8792', outline: '#e5e7eb', mech: '#b27cf7', drill: '#e6e6e6', drawing: '#8bd3c7', other: '#a3a3a3',
};
export function layerColor(L) { return LAYER_COLORS[L.type + ':' + L.side] || LAYER_COLORS[L.type] || '#a3a3a3'; }
export function defaultOn(L) { return !(L.type === 'mask' || L.type === 'paste' || L.type === 'drawing' || L.type === 'other' || L.type === 'mech'); }

let uid = 0;

/** render items of one parsed Gerber into markup; `paint` = 'fill' colour group context; nets: Map name->idx */
function itemsMarkup(items, apId, nets, comps) {
  let s = '';
  for (const it of items) {
    const tr = it.ox || it.oy ? ` transform="translate(${f(it.ox || 0)} ${f(-(it.oy || 0))})"` : '';
    let a = '';
    if (it.net != null && it.net !== '' && it.net !== 'N/C') a += ` data-n="${nets.get(it.net)}"`;
    if (it.comp) a += ` data-c="${comps.get(it.comp)}"`;
    if (it.pin) a += ` data-p="${esc(it.pin)}"`;
    if (it.t === 'L') {
      if (Math.abs(it.x1 - it.x2) < 1e-9 && Math.abs(it.y1 - it.y2) < 1e-9) s += `<circle class="dot" cx="${f(it.x1)}" cy="${f(-it.y1)}" r="${f(it.w / 2)}"${tr}${a}/>`;
      else s += `<line class="s" x1="${f(it.x1)}" y1="${f(-it.y1)}" x2="${f(it.x2)}" y2="${f(-it.y2)}" stroke-width="${f(Math.max(it.w, 0.01))}"${tr}${a}/>`;
    } else if (it.t === 'A') s += `<path class="s" d="${it.d}" stroke-width="${f(Math.max(it.w, 0.01))}"${tr}${a}/>`;
    else if (it.t === 'F') s += `<use href="#${apId(it.ap)}" x="${f(it.x + (it.ox || 0))}" y="${f(-(it.y + (it.oy || 0)))}"${a}/>`;
    else if (it.t === 'R') s += `<path d="${it.d}"${tr}${a}/>`;
  }
  return s;
}

/** returns {defs, body} for a Gerber layer; colours come from CSS on the enclosing group */
export function gerberLayerSvg(g, key, nets, comps) {
  const pre = 'g' + key + '_' + uid++;
  const apId = (id) => `${pre}a${id}`;
  let defs = '';
  for (const [id, ap] of Object.entries(g.aps)) {
    if (ap.parts) {
      const on = ap.parts.filter((p) => p.on);
      const off = ap.parts.filter((p) => !p.on);
      if (!off.length) defs += `<g id="${apId(id)}">${on.map((p) => `<path d="${p.d}"${p.evenodd ? ' fill-rule="evenodd"' : ''}/>`).join('')}</g>`;
      else {
        const r = Math.max(ap.r, 0.1) * 1.2;
        defs += `<mask id="${apId(id)}m" maskUnits="userSpaceOnUse" x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}"><rect x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" fill="#fff"/>${off.map((p) => `<path d="${p.d}" fill="#000"/>`).join('')}</mask>`;
        defs += `<g id="${apId(id)}"><g mask="url(#${apId(id)}m)">${on.map((p) => `<path d="${p.d}"${p.evenodd ? ' fill-rule="evenodd"' : ''}/>`).join('')}</g></g>`;
      }
    } else defs += `<path id="${apId(id)}" d="${ap.d || 'M0 0'}" fill-rule="evenodd"/>`;
  }
  // polarity blocks: content = ((B1 - B2) + B3) - B4 ...
  const [x1, y1, x2, y2] = g.bbox;
  const pad = 1;
  let content = '';
  for (const b of g.blocks) {
    if (!b.items.length) continue;
    const m = itemsMarkup(b.items, apId, nets, comps);
    if (b.dark) content += `<g>${m}</g>`;
    else {
      const id = `${pre}c${uid++}`;
      defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="${f(x1 - pad)}" y="${f(-y2 - pad)}" width="${f(x2 - x1 + 2 * pad)}" height="${f(y2 - y1 + 2 * pad)}"><rect x="${f(x1 - pad)}" y="${f(-y2 - pad)}" width="${f(x2 - x1 + 2 * pad)}" height="${f(y2 - y1 + 2 * pad)}" fill="#fff"/><g class="mk">${m}</g></mask>`;
      content = `<g mask="url(#${id})">${content}</g>`;
    }
  }
  return { defs, body: content };
}

export function drillSvg(d) {
  let s = '';
  for (const h of d.holes) s += `<circle cx="${f(h.x)}" cy="${f(-h.y)}" r="${f(h.d / 2)}"/>`;
  for (const sl of d.slots) s += `<line class="s" x1="${f(sl.x1)}" y1="${f(-sl.y1)}" x2="${f(sl.x2)}" y2="${f(-sl.y2)}" stroke-width="${f(sl.d)}"/>`;
  return s;
}

export function outlinePath(g) { const o = outlineInfo(g); return o ? o.d : null; }
/** chain outline strokes into closed loops -> {d (evenodd), area of the largest loop} or null */
export function outlineInfo(g) {
  const segs = [];
  for (const b of g.blocks) for (const it of b.items) {
    if (it.t === 'L' && (Math.abs(it.x1 - it.x2) > 1e-6 || Math.abs(it.y1 - it.y2) > 1e-6)) segs.push({ a: [it.x1, it.y1], b: [it.x2, it.y2], d: (rev) => `L${f(rev ? it.x1 : it.x2)} ${f(-(rev ? it.y1 : it.y2))}` });
    else if (it.t === 'A') {
      const arcPart = it.d.slice(it.d.indexOf('A'));
      segs.push({ a: [it.x1, it.y1], b: [it.x2, it.y2], d: (rev) => rev ? reverseArc(it) : arcPart });
    }
  }
  if (!segs.length) return null;
  const tol = 0.02;
  const near = (p, q) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol;
  const used = new Array(segs.length).fill(false);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const start = segs[i].a; let end = segs[i].b;
    let d = `M${f(start[0])} ${f(-start[1])}` + segs[i].d(false);
    const pts = [start, end];
    let guard = 0, closed = near(start, end);
    while (!closed && guard++ < segs.length) {
      let found = false;
      for (let k = 0; k < segs.length; k++) {
        if (used[k]) continue;
        if (near(segs[k].a, end)) { used[k] = true; d += segs[k].d(false); end = segs[k].b; found = true; }
        else if (near(segs[k].b, end)) { used[k] = true; d += segs[k].d(true); end = segs[k].a; found = true; }
        if (found) { pts.push(end); break; }
      }
      if (!found) break;
      closed = near(start, end);
    }
    if (closed && pts.length >= 3) {
      let area = 0; for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
      loops.push({ d: d + 'Z', area: Math.abs(area / 2) });
    }
  }
  if (!loops.length) return null;
  loops.sort((a, b) => b.area - a.area);
  return { d: loops.map((l) => l.d).join(''), area: loops[0].area };
}
function reverseArc(it) {
  const r = it.r;
  let a0 = Math.atan2(it.y1 - it.cy, it.x1 - it.cx), a1 = Math.atan2(it.y2 - it.cy, it.x2 - it.cx);
  let span = it.cw ? a0 - a1 : a1 - a0; while (span <= 0) span += 2 * Math.PI;
  const sweep = it.cw ? 0 : 1; // reversed direction
  return `A${f(r)} ${f(r)} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${f(it.x1)} ${f(-it.y1)}`;
}

// ---------------- whole set ----------------

/** files: [{name, text}] -> set */
export function buildGerberSet(files) {
  const layers = [];
  const nets = new Map(), comps = new Map();
  const netNames = [], compNames = [];
  for (const fl of files) {
    const kind = sniffKind(fl.text);
    if (!kind) continue;
    let parsed;
    try { parsed = kind === 'drill' ? parseExcellon(fl.text) : parseGerber(fl.text); } catch (e) { console.warn('gerber', fl.name, e); continue; }
    let L = identifyLayer(fl.name, parsed.attrs);
    if (kind === 'drill' && L.type !== 'drill') L = { ...L, type: 'drill', side: 'all', label: 'Wiercenia', order: 6 };
    if (kind === 'drill' && parsed.plated === false) L.label = 'Wiercenia niemetalizowane';
    if (kind === 'gerber') for (const b of parsed.blocks) for (const it of b.items) {
      if (it.net != null && it.net !== '' && it.net !== 'N/C' && !nets.has(it.net)) { nets.set(it.net, netNames.length); netNames.push(it.net); }
      if (it.comp && !comps.has(it.comp)) { comps.set(it.comp, compNames.length); compNames.push(it.comp); }
    }
    layers.push({ id: layers.length, name: fl.name, kind, parsed, L, color: layerColor(L) });
  }
  // board outline: explicit outline layer, else the mechanical layer with the largest closed loop
  let outl = null, outD = null;
  for (const l of layers.filter((l) => l.kind === 'gerber' && l.L.type === 'outline')) { const o = outlineInfo(l.parsed); if (o) { outl = l; outD = o.d; break; } }
  if (!outl) {
    let best = 0;
    for (const l of layers.filter((l) => l.kind === 'gerber' && l.L.type === 'mech')) { const o = outlineInfo(l.parsed); if (o && o.area > best) { best = o.area; outl = l; outD = o.d; } }
  }
  let bbox = null;
  const use = outl ? [outl] : layers.filter((l) => l.kind === 'gerber');
  for (const l of use) {
    const b = l.parsed.bbox; if (!(b[2] > b[0])) continue;
    bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b.slice();
  }
  layers.sort((a, b) => a.L.order - b.L.order || a.name.localeCompare(b.name));
  return { layers, nets, comps, netNames, compNames, bbox: bbox || [0, 0, 100, 100], outline: outD, outlineLayer: outl ? outl.id : -1, hasX2: netNames.length > 0 || compNames.length > 0 };
}

/** order of layers for drawing in the layer view (bottom-most first) */
export function layerOrder(set, flip) {
  const rank = (L) => {
    const sideRank = L.side === 'bottom' ? 0 : L.side === 'inner' ? 1 : L.side === 'top' ? 2 : 3;
    const typeRank = { copper: 0, mask: 1, paste: 2, silk: 3, drill: 4, outline: 5, mech: 6, drawing: 7, other: 8 }[L.type] ?? 9;
    const s = flip ? (sideRank === 0 ? 2 : sideRank === 2 ? 0 : sideRank) : sideRank;
    return s * 10 + typeRank;
  };
  return set.layers.slice().sort((a, b) => rank(a.L) - rank(b.L));
}

/** layer view: one <g data-gl=id> per layer */
export function renderLayers(set, flip) {
  let defs = '', body = '';
  for (const l of layerOrder(set, flip)) {
    if (l.kind === 'drill') { body += `<g data-gl="${l.id}" class="gl drill">${drillSvg(l.parsed)}</g>`; continue; }
    const r = gerberLayerSvg(l.parsed, l.id, set.nets, set.comps);
    defs += r.defs;
    body += `<g data-gl="${l.id}" class="gl t-${l.L.type}" style="--c:${l.color}">${r.body}</g>`;
  }
  return `<defs>${defs}</defs>${body}`;
}

/** realistic view of one side */
export function renderBoard(set, side) {
  const pick = (type) => set.layers.filter((l) => l.L.type === type && l.L.side === side);
  const drills = set.layers.filter((l) => l.kind === 'drill');
  const [x1, y1, x2, y2] = set.bbox;
  const pad = 2;
  const R = `x="${f(x1 - pad)}" y="${f(-y2 - pad)}" width="${f(x2 - x1 + 2 * pad)}" height="${f(y2 - y1 + 2 * pad)}"`;
  const id = 'rb' + uid++;
  let defs = '';
  const boardD = set.outline;
  if (boardD) defs += `<clipPath id="${id}clip"><path d="${boardD}" fill-rule="evenodd"/></clipPath>`;
  const layerMarkup = (layers) => layers.map((l) => { const r = gerberLayerSvg(l.parsed, l.id + '_' + side, set.nets, set.comps); defs += r.defs; return r.body; }).join('');
  const copper = layerMarkup(pick('copper'));
  const masks = pick('mask');
  const maskOpen = masks.length ? layerMarkup(masks) : '';
  const silk = layerMarkup(pick('silk'));
  // soldermask openings (mask layer: dark = opening)
  if (masks.length) {
    defs += `<mask id="${id}open" maskUnits="userSpaceOnUse" ${R}><rect ${R} fill="#000"/><g class="mkw">${maskOpen}</g></mask>`;
    defs += `<mask id="${id}cover" maskUnits="userSpaceOnUse" ${R}><rect ${R} fill="#fff"/><g class="mk">${maskOpen}</g></mask>`;
  }
  let s = `<defs>${defs}</defs><g class="board"${boardD ? ` clip-path="url(#${id}clip)"` : ''}>`;
  s += `<rect ${R} class="b-mask"/>`;
  s += `<g class="b-cu-under">${copper}</g>`;
  if (masks.length) {
    s += `<g mask="url(#${id}open)"><rect ${R} class="b-fr4"/><g class="b-cu-open">${copper}</g></g>`;
    s += `<g class="b-silk" mask="url(#${id}cover)">${silk}</g>`;
  } else s += `<g class="b-silk">${silk}</g>`;
  s += `<g class="b-drill">${drills.map((l) => drillSvg(l.parsed)).join('')}</g>`;
  s += `</g>`;
  if (boardD) s += `<path d="${boardD}" class="b-edge"/>`;
  return s;
}
