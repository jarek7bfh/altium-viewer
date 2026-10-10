// Altium PcbDoc parser (binary records). Coordinates in mil, Y up (Altium convention).
import { Reader, textRecords32, milVal, num, bool, parseProps, bin } from './util.js';

export const PCB_STREAMS = [
  'Board6/Data', 'Components6/Data', 'Nets6/Data', 'Tracks6/Data', 'Arcs6/Data', 'Vias6/Data',
  'Pads6/Data', 'Fills6/Data', 'Regions6/Data', 'ShapeBasedRegions6/Data', 'Texts6/Data',
  'WideStrings6/Data', 'Polygons6/Data', 'Classes6/Data',
];

// Altium layer ids
export const L = {
  TOP: 1, BOTTOM: 32, TOP_OVERLAY: 33, BOTTOM_OVERLAY: 34, TOP_PASTE: 35, BOTTOM_PASTE: 36,
  TOP_SOLDER: 37, BOTTOM_SOLDER: 38, DRILL_GUIDE: 55, KEEPOUT: 56, MECH1: 57, MECH16: 72,
  DRILL_DRAWING: 73, MULTI: 74,
};
const NONE16 = 0xffff;

export function layerName(id) {
  if (id === 1) return 'Top Layer';
  if (id > 1 && id < 32) return 'Mid Layer ' + (id - 1);
  if (id === 32) return 'Bottom Layer';
  const m = { 33: 'Top Overlay', 34: 'Bottom Overlay', 35: 'Top Paste', 36: 'Bottom Paste', 37: 'Top Solder', 38: 'Bottom Solder', 55: 'Drill Guide', 56: 'Keep-Out', 73: 'Drill Drawing', 74: 'Multi-Layer' };
  if (m[id]) return m[id];
  if (id >= 39 && id <= 54) return 'Internal Plane ' + (id - 38);
  if (id >= 57 && id <= 72) return 'Mechanical ' + (id - 56);
  return 'Layer ' + id;
}

function records(u8, fn) {
  const out = [];
  if (!u8 || !u8.length) return out;
  const r = new Reader(u8);
  let guard = 0;
  while (r.p < u8.length && guard++ < 2e6) {
    const start = r.p;
    try {
      const o = fn(r);
      if (o) out.push(o);
    } catch (e) {
      console.warn('pcb record parse error at', start, e);
      break;
    }
    if (r.p <= start) break;
  }
  return out;
}

function parseTrack(r) {
  r.u8_(); // type 4
  r.sub();
  const layer = r.u8_();
  const f1 = r.u8_(); const f2 = r.u8_();
  const net = r.u16(); const poly = r.u16(); const comp = r.u16();
  r.skip(4);
  const x1 = r.unit(), y1 = r.unit(), x2 = r.unit(), y2 = r.unit();
  const w = r.unit();
  r.endSub();
  return { layer, net: net === NONE16 ? -1 : net, poly: poly === NONE16 ? -1 : poly, comp: comp === NONE16 ? -1 : comp, x1, y1, x2, y2, w, keepout: f2 === 2, polyOutline: (f1 & 2) !== 0 };
}

function parseArc(r) {
  r.u8_(); // type 1
  r.sub();
  const layer = r.u8_();
  const f1 = r.u8_(); const f2 = r.u8_();
  const net = r.u16(); const poly = r.u16(); const comp = r.u16();
  r.skip(4);
  const cx = r.unit(), cy = r.unit();
  const rad = r.unit();
  const sa = r.f64(), ea = r.f64();
  const w = r.unit();
  r.endSub();
  return { layer, net: net === NONE16 ? -1 : net, poly: poly === NONE16 ? -1 : poly, comp: comp === NONE16 ? -1 : comp, cx, cy, r: rad, sa, ea, w, keepout: f2 === 2 };
}

function parseVia(r) {
  r.u8_(); // type 3
  r.sub();
  r.skip(1);
  r.u8_(); r.u8_();
  const net = r.u16();
  r.skip(8);
  const x = r.unit(), y = r.unit();
  const d = r.unit(), hole = r.unit();
  const ls = r.u8_(), le = r.u8_();
  r.endSub();
  return { net: net === NONE16 ? -1 : net, x, y, d, hole, ls, le };
}

function parsePad(r) {
  r.u8_(); // type 2
  r.sub();
  const name = r.pstr();
  r.endSub();
  r.sub(); r.endSub();
  r.sub(); r.endSub();
  r.sub(); r.endSub();
  const n5 = r.sub();
  const layer = r.u8_();
  r.u8_(); r.u8_();
  const net = r.u16();
  r.skip(2);
  const comp = r.u16();
  r.skip(4);
  const x = r.unit(), y = r.unit();
  const top = [r.unit(), r.unit()];
  const mid = [r.unit(), r.unit()];
  const bot = [r.unit(), r.unit()];
  const hole = r.unit();
  const topShape = r.u8_(), midShape = r.u8_(), botShape = r.u8_();
  const rot = r.f64();
  const plated = r.u8_() !== 0;
  r.skip(1);
  const mode = r.u8_();
  r.endSub();
  const n6 = r.sub();
  let holeShape = 0, slot = 0, slotRot = 0, altTop = 0, altBot = 0, crTop = 0, crBot = 0;
  if (n6 >= 596) {
    r.skip(29 * 4 * 2); // inner sizes
    r.skip(29); // inner shapes
    r.skip(1);
    holeShape = r.u8_();
    slot = r.unit();
    slotRot = r.f64();
    r.skip(32 * 4 * 2); // hole offsets
    r.skip(1);
    const alt = []; for (let i = 0; i < 32; i++) alt.push(r.u8_());
    const cr = []; for (let i = 0; i < 32; i++) cr.push(r.u8_());
    altTop = alt[0]; altBot = alt[31]; crTop = cr[0]; crBot = cr[31];
  }
  r.endSub();
  return {
    name, layer, net: net === NONE16 ? -1 : net, comp: comp === NONE16 ? -1 : comp, x, y,
    top, mid, bot, hole, topShape, midShape, botShape, rot, plated, mode,
    holeShape, slot, slotRot, altTop, altBot, crTop, crBot,
  };
}

function parseFill(r) {
  r.u8_(); // 6
  r.sub();
  const layer = r.u8_();
  r.u8_(); const f2 = r.u8_();
  const net = r.u16();
  r.skip(2);
  const comp = r.u16();
  r.skip(4);
  const x1 = r.unit(), y1 = r.unit(), x2 = r.unit(), y2 = r.unit();
  const rot = r.f64();
  r.endSub();
  return { layer, net: net === NONE16 ? -1 : net, comp: comp === NONE16 ? -1 : comp, x1, y1, x2, y2, rot, keepout: f2 === 2 };
}

function readPropsBlock(r) {
  const n = r.u32();
  let end = r.p + n;
  let e2 = end; while (e2 > r.p && r.u8[e2 - 1] === 0) e2--;
  const p = parseProps(bin(r.u8, r.p, e2));
  r.p = end;
  return p;
}

function parseRegion(r, extended) {
  r.u8_(); // 11
  r.sub();
  const layer = r.u8_();
  r.u8_(); const f2 = r.u8_();
  const net = r.u16(); const poly = r.u16(); const comp = r.u16();
  r.skip(5);
  const holeCount = r.u16();
  r.skip(2);
  const props = readPropsBlock(r);
  let nv = r.u32();
  const pts = [];
  if (extended) {
    nv++;
    for (let i = 0; i < nv; i++) {
      const isRound = r.u8_() !== 0;
      const x = r.unit(), y = r.unit();
      const cx = r.unit(), cy = r.unit();
      const rad = r.unit();
      const a1 = r.f64(), a2 = r.f64();
      pts.push(isRound ? { x, y, round: true, cx, cy, r: rad, a1, a2 } : { x, y });
    }
  } else {
    for (let i = 0; i < nv; i++) {
      const x = r.f64() / 10000, y = r.f64() / 10000;
      pts.push({ x, y });
    }
  }
  const holes = [];
  if (!extended || true) {
    for (let h = 0; h < holeCount && r.remaining() > 4; h++) {
      const hn = r.u32();
      const hp = [];
      for (let i = 0; i < hn; i++) hp.push({ x: r.f64() / 10000, y: r.f64() / 10000 });
      holes.push(hp);
    }
  }
  r.endSub();
  const kind = num(props.KIND, 0);
  return {
    layer, net: net === NONE16 ? -1 : net, poly: poly === NONE16 ? -1 : poly, comp: comp === NONE16 ? -1 : comp,
    kind, cutout: bool(props.ISBOARDCUTOUT), keepout: f2 === 2 || bool(props.KEEPOUT), pts, holes,
    subpoly: num(props.SUBPOLYINDEX, -1), shapeBased: extended,
  };
}

function parseText(r, wide) {
  r.u8_(); // 5
  const n1 = r.sub();
  const layer = r.u8_();
  r.skip(6);
  const comp = r.u16();
  r.skip(4);
  const x = r.unit(), y = r.unit();
  const h = r.unit();
  r.u16(); // stroke font
  const rot = r.f64();
  const mirrored = r.u8_() !== 0;
  const sw = r.unit();
  let isComment = false, isDesignator = false, fontType = 0, bold = false, italic = false, font = '', inverted = false;
  let wideIdx = -1, justify = 0, useBox = false, boxW = 0, boxH = 0;
  if (n1 >= 123) {
    isComment = r.u8_() !== 0;
    isDesignator = r.u8_() !== 0;
    r.skip(1);
    fontType = r.u8_();
    bold = r.u8_() !== 0;
    italic = r.u8_() !== 0;
    const fb = r.u8.subarray(r.p, r.p + 64); r.skip(64);
    font = '';
    for (let i = 0; i + 1 < 64; i += 2) { const c = fb[i] | (fb[i + 1] << 8); if (!c) break; font += String.fromCharCode(c); }
    inverted = r.u8_() !== 0;
    // remaining fields: margins, widestring index, justification... (best-effort)
    const base = r.subStart;
    if (n1 >= 119) {
      const dv = r.dv;
      // widestring index at offset 115 within subrecord (observed in AD10+)
      const wi = dv.getUint32(base + 115, true);
      if (wide && wide[wi] != null) wideIdx = wi;
    }
  }
  r.endSub();
  r.sub();
  let text = r.remaining() > 0 ? r.pstr() : '';
  r.endSub();
  if (wideIdx >= 0) text = wide[wideIdx];
  return { layer, comp: comp === NONE16 ? -1 : comp, x, y, h, rot, mirrored, sw, isComment, isDesignator, fontType, bold, italic, font, inverted, text };
}

function parseOutline(p, prefix = '') {
  // Board6 / Polygons6 vertex list: KIND{i},VX{i},VY{i},CX{i},CY{i},SA{i},EA{i},R{i}
  const v = [];
  for (let i = 0; ; i++) {
    const vx = p[prefix + 'VX' + i];
    if (vx == null) break;
    v.push({
      kind: num(p[prefix + 'KIND' + i]), x: milVal(vx), y: milVal(p[prefix + 'VY' + i]),
      cx: milVal(p[prefix + 'CX' + i]), cy: milVal(p[prefix + 'CY' + i]),
      sa: num(p[prefix + 'SA' + i]), ea: num(p[prefix + 'EA' + i]), r: milVal(p[prefix + 'R' + i]),
    });
  }
  return v;
}

/**
 * @param {(path:string)=>Uint8Array|null} get stream getter
 */
export function parsePcb(get) {
  const boardP = textRecords32(get('Board6/Data'))[0] || {};
  const outline = parseOutline(boardP);
  const stack = [];
  for (let i = 0; i < 200; i++) {
    const nm = boardP['V9_STACK_LAYER' + i + '_NAME'];
    if (nm == null) break;
    stack.push(nm);
  }
  const nets = textRecords32(get('Nets6/Data')).map((p) => p.NAME || '');
  const components = textRecords32(get('Components6/Data')).map((p, i) => ({
    i,
    des: p.SOURCEDESIGNATOR || '',
    uid: (p.SOURCEUNIQUEID || '').replace(/^\\/, ''),
    lib: p.SOURCELIBREFERENCE || '',
    pattern: p.PATTERN || '',
    layer: (p.LAYER || 'TOP').toUpperCase() === 'BOTTOM' ? 'BOTTOM' : 'TOP',
    x: milVal(p.X), y: milVal(p.Y), rot: num(p.ROTATION),
    nameOn: bool(p.NAMEON), commentOn: bool(p.COMMENTON),
    desc: p.SOURCEDESCRIPTION || '',
    height: milVal(p.HEIGHT),
  }));
  // wide strings: [u32 index][u32 byteLen][UTF-16LE, null-terminated]...
  let wide = null;
  const wsd = get('WideStrings6/Data');
  if (wsd && wsd.length) {
    wide = {};
    const dv = new DataView(wsd.buffer, wsd.byteOffset, wsd.byteLength);
    let p = 0;
    while (p + 8 <= wsd.length) {
      const idx = dv.getUint32(p, true); const n = dv.getUint32(p + 4, true); p += 8;
      let s = '';
      for (let i = 0; i + 1 < n; i += 2) { const c = dv.getUint16(p + i, true); if (!c) break; s += String.fromCharCode(c); }
      wide[idx] = s; p += n;
    }
  }
  const tracks = records(get('Tracks6/Data'), parseTrack);
  const arcs = records(get('Arcs6/Data'), parseArc);
  const vias = records(get('Vias6/Data'), parseVia);
  const pads = records(get('Pads6/Data'), parsePad);
  const fills = records(get('Fills6/Data'), parseFill);
  const regions = records(get('Regions6/Data'), (r) => parseRegion(r, false));
  const sregions = records(get('ShapeBasedRegions6/Data'), (r) => parseRegion(r, true));
  const texts = records(get('Texts6/Data'), (r) => parseText(r, wide));
  const polygons = textRecords32(get('Polygons6/Data')).map((p) => ({
    layer: p.LAYER, net: p.NET != null ? num(p.NET, -1) : -1, hatch: p.HATCHSTYLE, outline: parseOutline(p), name: p.NAME || '',
  }));
  const classes = textRecords32(get('Classes6/Data')).map((p) => {
    const m = []; for (let i = 0; p['M' + i] != null; i++) m.push(p['M' + i]);
    return { name: p.NAME, kind: num(p.KIND), members: m, superclass: bool(p.SUPERCLASS) };
  });

  // comment text per component (from texts with isComment)
  for (const t of texts) {
    if (t.comp >= 0 && components[t.comp]) {
      if (t.isComment) components[t.comp].comment = t.text;
      if (t.isDesignator) components[t.comp].desText = t.text;
    }
  }

  return { outline, stack, nets, components, tracks, arcs, vias, pads, fills, regions, sregions, texts, polygons, classes, board: { originX: milVal(boardP.ORIGINX), originY: milVal(boardP.ORIGINY) } };
}
