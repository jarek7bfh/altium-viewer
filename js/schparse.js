// Altium SchDoc parser -> normalized primitives (units: 10 mil, Y up)
import { parseProps, bin, num, bool, color } from './util.js';

export const SCH_STREAMS = ['FileHeader'];

const SHEET_SIZES = [
  [1150, 760], [1550, 1110], [2230, 1570], [3150, 2230], [4460, 3150], [950, 750], [1500, 950], [2000, 1500],
  [3200, 2000], [4200, 3200], [1100, 850], [1400, 850], [1700, 1100], [990, 790], [1540, 990], [2060, 1560],
  [3260, 2060], [4280, 3280],
];
const LW = [0.4, 1, 3, 5];

function records(u8) {
  const out = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = 0;
  while (i + 4 <= u8.length) {
    const n = dv.getUint16(i, true);
    const type = u8[i + 3];
    i += 4;
    if (type === 0) {
      let e = i + n; while (e > i && u8[e - 1] === 0) e--;
      out.push(parseProps(bin(u8, i, e)));
    } else {
      out.push({ RECORD: 'BINARY', _bin: u8.subarray(i, i + n) });
    }
    i += n;
  }
  return out;
}

const P = (p, k) => num(p[k + '.X']) + num(p[k + '.X_FRAC']) / 100000;
const Q = (p, k) => num(p[k + '.Y']) + num(p[k + '.Y_FRAC']) / 100000;
const loc = (p) => [P(p, 'LOCATION'), Q(p, 'LOCATION')];
const corner = (p) => [P(p, 'CORNER'), Q(p, 'CORNER')];
function vertices(p) {
  const n = num(p.LOCATIONCOUNT);
  const out = [];
  for (let i = 1; i <= n; i++) out.push([num(p['X' + i]) + num(p['X' + i + '_FRAC']) / 1e5, num(p['Y' + i]) + num(p['Y' + i + '_FRAC']) / 1e5]);
  return out;
}

/** Normalize text rotation: orientation 0..3 & justification 0..8 -> {rot:0|90, h:0..2, v:0..2} */
function textPlacement(orient, just) {
  let h = just % 3, v = Math.floor(just / 3); // h:0 left 1 center 2 right ; v:0 bottom 1 middle 2 top
  let rot = 0;
  if (orient === 1) rot = 90;
  else if (orient === 2) { h = 2 - h; v = 2 - v; }
  else if (orient === 3) { rot = 90; h = 2 - h; v = 2 - v; }
  return { rot, h, v };
}

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export function parseSch(get) {
  const R = records(get('FileHeader'));
  const objs = R.slice(1); // index = OwnerIndex
  const sheetP = objs.find((p) => p.RECORD === '31') || {};
  const fonts = {};
  const fc = num(sheetP.FONTIDCOUNT, 0);
  for (let i = 1; i <= fc; i++) {
    fonts[i] = {
      size: num(sheetP['SIZE' + i], 10), name: sheetP['FONTNAME' + i] || 'Times New Roman',
      bold: bool(sheetP['BOLD' + i]), italic: bool(sheetP['ITALIC' + i]), rot: num(sheetP['ROTATION' + i]),
      underline: bool(sheetP['UNDERLINE' + i]),
    };
  }
  let w, h;
  if (bool(sheetP.USECUSTOMSHEET)) { w = num(sheetP.CUSTOMX, 1150); h = num(sheetP.CUSTOMY, 760); }
  else { [w, h] = SHEET_SIZES[num(sheetP.SHEETSTYLE, 0)] || SHEET_SIZES[0]; }
  if (num(sheetP.WORKSPACEORIENTATION) === 1) [w, h] = [h, w];
  const sheet = {
    w, h, area: color(sheetP.AREACOLOR, '#fffcf8'), fonts, border: bool(sheetP.BORDERON) || sheetP.BORDERON == null,
    systemFont: num(sheetP.SYSTEMFONT, 1), margin: num(sheetP.CUSTOMMARGINWIDTH, 20),
    xz: num(sheetP.CUSTOMXZONES, 4), yz: num(sheetP.CUSTOMYZONES, 4),
  };

  // sheet-level parameters (for =Title etc.)
  const sheetParams = {};
  objs.forEach((p) => { if (p.RECORD === '41' && p.OWNERINDEX == null && p.NAME) sheetParams[p.NAME.toUpperCase()] = p.TEXT; });

  // components
  const components = [];
  const compByIdx = new Map();
  objs.forEach((p, i) => {
    if (p.RECORD !== '1') return;
    const c = {
      ci: components.length, idx: i, uid: p.UNIQUEID || '', lib: p.LIBREFERENCE || p.DESIGNITEMID || '',
      desc: p.COMPONENTDESCRIPTION || '', part: num(p.CURRENTPARTID, 1), partCount: Math.max(1, num(p.PARTCOUNT, 2) - 1),
      mode: num(p.DISPLAYMODE, 0), des: '', comment: '', params: {}, footprint: '', bbox: null,
    };
    components.push(c);
    compByIdx.set(i, c);
  });
  // gather params / designators / footprints
  objs.forEach((p) => {
    const oi = p.OWNERINDEX != null ? num(p.OWNERINDEX) : -1;
    const c = compByIdx.get(oi);
    if (!c) return;
    if (p.RECORD === '34') c.des = p.TEXT || '';
    if (p.RECORD === '41' && p.NAME) c.params[p.NAME] = p.TEXT ?? '';
  });
  // footprint: implementation list (44) -> 45 with MODELTYPE=PCBLIB & ISCURRENT
  objs.forEach((p, i) => {
    if (p.RECORD === '45' && (p.MODELTYPE || '').toUpperCase() === 'PCBLIB') {
      const list = objs[num(p.OWNERINDEX, -1)];
      if (!list) return;
      const c = compByIdx.get(num(list.OWNERINDEX, -1));
      if (c && (bool(p.ISCURRENT) || !c.footprint)) c.footprint = p.MODELNAME || '';
    }
  });
  const resolve = (txt, c) => {
    if (txt == null) return '';
    if (txt.startsWith('=')) {
      const key = txt.slice(1);
      if (c) {
        const f = Object.keys(c.params).find((k) => k.toUpperCase() === key.toUpperCase());
        if (f) return resolve(c.params[f], null);
      }
      const sp = sheetParams[key.toUpperCase()];
      if (sp != null) return sp;
      return '';
    }
    return txt;
  };
  for (const c of components) {
    const k = Object.keys(c.params).find((k) => k.toUpperCase() === 'COMMENT');
    c.comment = resolve(k ? c.params[k] : '', c) || c.lib;
    for (const key in c.params) c.params[key] = resolve(c.params[key], c);
  }

  const prims = [];
  const pins = [];
  const wires = [];
  const labels = []; // net labels / power / ports: {name, x, y, kind}
  const junctions = [];
  const noerc = [];

  const visible = (p) => {
    const oi = p.OWNERINDEX != null ? num(p.OWNERINDEX) : -1;
    const c = compByIdx.get(oi);
    if (!c) return { ok: true, c: null };
    const opid = num(p.OWNERPARTID, -1);
    if (opid !== -1 && opid !== c.part) return { ok: false };
    const dm = num(p.OWNERPARTDISPLAYMODE, 0);
    if (dm !== c.mode) return { ok: false };
    return { ok: true, c };
  };
  const font = (id) => fonts[id] || fonts[1] || { size: 10, name: 'Times New Roman' };

  objs.forEach((p, i) => {
    const t = p.RECORD;
    if (t === '1' || t === '31' || t === '44' || t === '45' || t === '46' || t === '48' || t === 'BINARY') return;
    const vis = visible(p);
    if (!vis.ok) return;
    const c = vis.c;
    const ci = c ? c.ci : -1;
    const col = (k = 'COLOR', d = '#000080') => color(p[k], d);
    const lw = LW[num(p.LINEWIDTH, 0)] ?? 1;
    const fill = (d) => (bool(p.ISSOLID) ? color(p.AREACOLOR, d) : null);
    switch (t) {
      case '2': { // pin
        const pc = num(p.PINCONGLOMERATE);
        const o = pc & 3;
        const hidden = (pc & 4) !== 0;
        const len = num(p.PINLENGTH) + num(p.PINLENGTH_FRAC) / 1e5;
        const [x, y] = loc(p);
        const d = DIRS[o];
        const pin = {
          pi: pins.length, comp: ci, name: p.NAME || '', des: p.DESIGNATOR || '', x, y, ex: x + d[0] * len, ey: y + d[1] * len,
          o, len, hidden, showName: (pc & 8) !== 0, showDes: (pc & 16) !== 0, color: col('COLOR', '#000000'),
          dot: num(p.SYMBOL_OUTEREDGE) === 1, clock: num(p.SYMBOL_INNEREDGE) === 3, electrical: num(p.ELECTRICAL),
          font: font(num(p.DESIGNATOR_CUSTOMFONTID, 0) || sheet.systemFont),
          nameFont: font(num(p.NAME_CUSTOMFONTID, 0) || sheet.systemFont),
        };
        pins.push(pin);
        break;
      }
      case '4': case '34': case '41': { // label / designator / parameter
        if (bool(p.ISHIDDEN)) return;
        if (t === '41' && !c && p.OWNERINDEX == null && !p['LOCATION.X']) return;
        const text = resolve(p.TEXT, c);
        if (!text || text === '*') return;
        const [x, y] = loc(p);
        const pl = textPlacement(num(p.ORIENTATION), num(p.JUSTIFICATION));
        prims.push({ t: 'text', comp: ci, kind: t === '34' ? 'des' : t === '41' ? 'param' : 'text', x, y, text, font: font(num(p.FONTID, 1)), color: col('COLOR', '#000080'), ...pl });
        break;
      }
      case '5': { // bezier
        const v = vertices(p);
        prims.push({ t: 'bezier', comp: ci, kind: 'body', pts: v, w: lw, color: col() });
        break;
      }
      case '6': prims.push({ t: 'poly', comp: ci, kind: 'body', pts: vertices(p), w: lw, color: col(), dash: num(p.LINESTYLE) || num(p.LINESTYLEEXT) }); break;
      case '7': prims.push({ t: 'poly', comp: ci, kind: 'body', pts: vertices(p), closed: true, w: lw, color: col(), fill: fill('#ffffb0') }); break;
      case '8': {
        const [x, y] = loc(p);
        const rx = num(p.RADIUS) + num(p.RADIUS_FRAC) / 1e5;
        const ry = p.SECONDARYRADIUS != null ? num(p.SECONDARYRADIUS) + num(p.SECONDARYRADIUS_FRAC) / 1e5 : rx;
        prims.push({ t: 'ellipse', comp: ci, kind: 'body', cx: x, cy: y, rx, ry, w: lw, color: col(), fill: fill('#ffffb0') });
        break;
      }
      case '10': case '14': {
        const [x1, y1] = loc(p); const [x2, y2] = corner(p);
        prims.push({ t: 'rect', comp: ci, kind: 'body', x1, y1, x2, y2, rx: t === '10' ? num(p.CORNERXRADIUS) : 0, ry: t === '10' ? num(p.CORNERYRADIUS) : 0, w: lw, color: col(), fill: bool(p.TRANSPARENT) ? null : fill('#ffffb0') });
        break;
      }
      case '11': case '12': {
        const [x, y] = loc(p);
        const rx = num(p.RADIUS) + num(p.RADIUS_FRAC) / 1e5;
        const ry = t === '11' ? num(p.SECONDARYRADIUS) + num(p.SECONDARYRADIUS_FRAC) / 1e5 : rx;
        prims.push({ t: 'arc', comp: ci, kind: 'body', cx: x, cy: y, rx, ry, sa: num(p.STARTANGLE), ea: p.ENDANGLE != null ? num(p.ENDANGLE) : 360, w: lw, color: col() });
        break;
      }
      case '13': {
        const a = loc(p), b = corner(p);
        prims.push({ t: 'poly', comp: ci, kind: 'body', pts: [a, b], w: lw, color: col(), dash: num(p.LINESTYLE) });
        break;
      }
      case '15': { // sheet symbol
        const [x, y] = loc(p);
        prims.push({ t: 'rect', comp: -1, kind: 'body', x1: x, y1: y, x2: x + num(p.XSIZE), y2: y - num(p.YSIZE), w: lw, color: col(), fill: fill('#ffffb0') });
        break;
      }
      case '17': { // power port
        const [x, y] = loc(p);
        const name = p.TEXT || '';
        labels.push({ name, x, y, kind: 'power' });
        prims.push({ t: 'power', comp: -1, kind: 'power', x, y, o: num(p.ORIENTATION), style: num(p.STYLE), name, show: bool(p.SHOWNETNAME), color: col('COLOR', '#000080'), font: font(num(p.FONTID, 1)) });
        break;
      }
      case '18': { // port
        const [x, y] = loc(p);
        const wdt = num(p.WIDTH), hgt = num(p.HEIGHT, 10);
        const style = num(p.STYLE);
        const vert = style >= 4;
        const name = p.NAME || '';
        const ends = vert ? [[x, y], [x, y - wdt]] : [[x, y], [x + wdt, y]];
        for (const [ex, ey] of ends) labels.push({ name, x: ex, y: ey, kind: 'port' });
        prims.push({ t: 'port', comp: -1, kind: 'port', x, y, wdt, hgt, style, name, io: num(p.IOTYPE), align: num(p.ALIGNMENT), color: col('COLOR', '#800000'), fill: color(p.AREACOLOR, '#ffffb0'), tcolor: color(p.TEXTCOLOR, '#000080'), font: font(num(p.FONTID, 1)) });
        break;
      }
      case '22': { const [x, y] = loc(p); prims.push({ t: 'noerc', comp: -1, kind: 'mark', x, y, color: col('COLOR', '#ff0000') }); break; }
      case '43': { // parameter set / directive
        const [x, y] = loc(p);
        prims.push({ t: 'directive', comp: -1, kind: 'mark', x, y, o: num(p.ORIENTATION), name: p.NAME || '', color: col('COLOR', '#ff0000'), font: font(1) });
        break;
      }
      case '25': { // net label
        const [x, y] = loc(p);
        const name = p.TEXT || '';
        labels.push({ name, x, y, kind: 'label' });
        const pl = textPlacement(num(p.ORIENTATION), num(p.JUSTIFICATION));
        prims.push({ t: 'text', comp: -1, kind: 'netlabel', x, y, text: name, font: font(num(p.FONTID, 1)), color: col('COLOR', '#000080'), ...pl, labelIdx: labels.length - 1 });
        break;
      }
      case '26': prims.push({ t: 'poly', comp: -1, kind: 'bus', pts: vertices(p), w: 3, color: col('COLOR', '#000080') }); break;
      case '27': {
        const pts = vertices(p);
        wires.push({ wi: wires.length, pts });
        prims.push({ t: 'poly', comp: -1, kind: 'wire', pts, w: LW[num(p.LINEWIDTH, 1)] ?? 1, color: col('COLOR', '#000080'), wire: wires.length - 1 });
        break;
      }
      case '28': case '209': { // text frame / note
        const a = loc(p), b = corner(p);
        prims.push({ t: 'frame', comp: ci, kind: 'text', x1: a[0], y1: a[1], x2: b[0], y2: b[1], text: (p.TEXT || '').replace(/~1/g, '\n'), font: font(num(p.FONTID, 1)), color: color(p.TEXTCOLOR, '#000000'), border: bool(p.SHOWBORDER), bcolor: col('COLOR', '#000000'), fill: bool(p.ISSOLID) ? color(p.AREACOLOR, '#ffffff') : null, align: num(p.ALIGNMENT) });
        break;
      }
      case '29': { const [x, y] = loc(p); junctions.push([x, y]); prims.push({ t: 'junction', comp: -1, kind: 'junction', x, y, color: col('COLOR', '#000080') }); break; }
      case '30': { // image -> placeholder box
        const a = loc(p), b = corner(p);
        prims.push({ t: 'rect', comp: ci, kind: 'body', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: 0.4, color: '#999999', fill: null, dash: 1 });
        break;
      }
      case '32': case '33': {
        if (bool(p.ISHIDDEN)) return;
        const [x, y] = loc(p);
        const pl = textPlacement(num(p.ORIENTATION), 0);
        prims.push({ t: 'text', comp: -1, kind: 'text', x, y, text: p.TEXT || '', font: font(num(p.FONTID, 1)), color: col('COLOR', '#000000'), ...pl });
        break;
      }
      case '37': { const a = loc(p), b = corner(p); prims.push({ t: 'poly', comp: -1, kind: 'bus', pts: [a, b], w: 1, color: col('COLOR', '#000080') }); break; }
      default: break;
    }
  });

  // component bboxes from body prims + pins
  const grow = (c, x, y) => { if (!c.bbox) c.bbox = [x, y, x, y]; else { c.bbox[0] = Math.min(c.bbox[0], x); c.bbox[1] = Math.min(c.bbox[1], y); c.bbox[2] = Math.max(c.bbox[2], x); c.bbox[3] = Math.max(c.bbox[3], y); } };
  for (const pr of prims) {
    if (pr.comp < 0 || pr.kind !== 'body') continue;
    const c = components[pr.comp];
    if (pr.pts) pr.pts.forEach(([x, y]) => grow(c, x, y));
    else if (pr.t === 'rect') { grow(c, pr.x1, pr.y1); grow(c, pr.x2, pr.y2); }
    else if (pr.t === 'ellipse' || pr.t === 'arc') { grow(c, pr.cx - pr.rx, pr.cy - pr.ry); grow(c, pr.cx + pr.rx, pr.cy + pr.ry); }
  }
  for (const pin of pins) if (pin.comp >= 0 && !pin.hidden) { grow(components[pin.comp], pin.x, pin.y); grow(components[pin.comp], pin.ex, pin.ey); }

  return { sheet, components, prims, pins, wires, labels, junctions, sheetParams };
}
