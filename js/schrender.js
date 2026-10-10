// Schematic -> SVG markup. Model units (10 mil), Y up -> SVG y = -y
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (n) => Math.round(n * 100) / 100;
const PT = 0.9; // font pt -> em in sheet units (10 mil), calibrated on Altium layouts

function fontFamily(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('courier') || n.includes('mono') || n.includes('consol')) return "'Courier New',monospace";
  if (n.includes('times') || n.includes('serif') && !n.includes('sans')) return "'Times New Roman',Times,serif";
  return 'Arial,Helvetica,sans-serif';
}

/** Altium overbar notation: "R\S\T\" -> tspans */
function overbar(text) {
  if (!text.includes('\\')) return esc(text);
  let out = '', i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (text[i + 1] === '\\') { out += `<tspan text-decoration="overline">${esc(ch)}</tspan>`; i += 2; }
    else { out += esc(ch); i++; }
  }
  return out;
}

const ANCH = ['start', 'middle', 'end'];
const BASE = ['auto', 'central', 'hanging'];

function textEl(x, y, text, font, color, rot = 0, h = 0, v = 0, extra = '') {
  const fs = (font?.size || 10) * PT;
  const tr = rot ? ` transform="rotate(${-rot} ${f(x)} ${f(-y)})"` : '';
  const style = `font-family:${fontFamily(font?.name)};font-size:${f(fs)}px;${font?.bold ? 'font-weight:bold;' : ''}${font?.italic ? 'font-style:italic;' : ''}${font?.underline ? 'text-decoration:underline;' : ''}`;
  const lines = String(text).split('\n');
  if (lines.length === 1) {
    return `<text x="${f(x)}" y="${f(-y)}" fill="${color}" text-anchor="${ANCH[h]}" dominant-baseline="${BASE[v]}" style="${style}"${tr}${extra}>${overbar(text)}</text>`;
  }
  return `<text x="${f(x)}" y="${f(-y)}" fill="${color}" text-anchor="${ANCH[h]}" dominant-baseline="hanging" style="${style}"${tr}${extra}>${lines.map((l, i) => `<tspan x="${f(x)}" dy="${i ? f(fs * 1.15) : 0}">${overbar(l)}</tspan>`).join('')}</text>`;
}

function arcPath(cx, cy, rx, ry, sa, ea) {
  let span = ((ea - sa) % 360 + 360) % 360;
  if (span === 0) span = 360;
  if (span >= 359.99) return null;
  const a1 = (sa * Math.PI) / 180, a2 = (ea * Math.PI) / 180;
  const x1 = cx + rx * Math.cos(a1), y1 = cy + ry * Math.sin(a1);
  const x2 = cx + rx * Math.cos(a2), y2 = cy + ry * Math.sin(a2);
  return `M${f(x1)} ${f(-y1)}A${f(rx)} ${f(ry)} 0 ${span > 180 ? 1 : 0} 0 ${f(x2)} ${f(-y2)}`;
}

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function powerSymbol(p) {
  const d = DIRS[p.o & 3];
  const n = [-d[1], d[0]]; // perpendicular
  const X = (a, b) => f(p.x + d[0] * a + n[0] * b);
  const Y = (a, b) => f(-(p.y + d[1] * a + n[1] * b));
  const L = (a1, b1, a2, b2) => `M${X(a1, b1)} ${Y(a1, b1)}L${X(a2, b2)} ${Y(a2, b2)}`;
  let path = '', extra = '', tdist = 6;
  switch (p.style) {
    case 0: path = L(0, 0, 5, 0); extra = `<circle cx="${X(7, 0)}" cy="${Y(7, 0)}" r="2"/>`; tdist = 11; break; // circle
    case 1: path = L(0, 0, 5, 0) + L(5, -2.5, 9, 0) + L(9, 0, 5, 2.5) + L(5, 2.5, 5, -2.5); tdist = 11; break; // arrow
    case 3: path = L(0, 0, 5, 0) + `M${X(5, -5)} ${Y(5, -5)}Q${X(9, -2.5)} ${Y(9, -2.5)} ${X(5, 0)} ${Y(5, 0)}Q${X(1, 2.5)} ${Y(1, 2.5)} ${X(5, 5)} ${Y(5, 5)}`; tdist = 11; break; // wave
    case 4: path = L(0, 0, 4, 0) + L(4, -10, 4, 10) + L(6, -7, 6, 7) + L(8, -4, 8, 4) + L(10, -1, 10, 1); tdist = 14; break; // power ground
    case 5: path = L(0, 0, 4, 0) + L(4, -10, 4, 10) + L(4, 10, 12, 0) + L(12, 0, 4, -10); tdist = 15; break; // signal ground
    case 6: path = L(0, 0, 4, 0) + L(4, -10, 4, 10) + L(4, -10, 9, -15) + L(4, -2, 9, -7) + L(4, 6, 9, 1); tdist = 14; break; // earth
    default: path = L(0, 0, 5, 0) + L(5, -5, 5, 5); tdist = 7; break; // bar & others
  }
  let txt = '';
  if (p.show && p.name) {
    const tx = p.x + d[0] * tdist, ty = p.y + d[1] * tdist;
    const o = p.o & 3;
    const h = o === 0 ? 0 : o === 2 ? 2 : 1;
    const v = o === 1 ? 0 : o === 3 ? 2 : 1;
    txt = textEl(tx, ty, p.name, p.font, p.color, 0, h, v);
  }
  return `<path d="${path}" stroke="${p.color}" stroke-width="1" fill="none"/>${extra.replace('<circle', `<circle stroke="${p.color}" stroke-width="1" fill="none"`)}${txt}`;
}

function portShape(p) {
  const { x, y, wdt, hgt, style } = p;
  const h2 = hgt / 2, a = Math.min(h2, wdt / 2);
  let pts;
  if (style < 4) {
    const L = style === 1 || style === 3, R = style === 2 || style === 3;
    pts = [[x + (L ? a : 0), y + h2], [x + wdt - (R ? a : 0), y + h2]];
    if (R) pts.push([x + wdt, y]);
    pts.push([x + wdt - (R ? a : 0), y - h2], [x + (L ? a : 0), y - h2]);
    if (L) pts.push([x, y]);
  } else {
    const T = style === 5 || style === 7, B = style === 6 || style === 7;
    pts = [[x - h2, y - (T ? a : 0)], [x, y], [x + h2, y - (T ? a : 0)], [x + h2, y - wdt + (B ? a : 0)], [x, y - wdt], [x - h2, y - wdt + (B ? a : 0)]];
  }
  const poly = `<polygon points="${pts.map(([px, py]) => f(px) + ',' + f(-py)).join(' ')}" fill="${p.fill}" stroke="${p.color}" stroke-width="1"/>`;
  let t;
  if (style < 4) t = textEl(x + wdt / 2, y, p.name, p.font, p.tcolor, 0, 1, 1);
  else t = textEl(x, y - wdt / 2, p.name, p.font, p.tcolor, 90, 1, 1);
  return poly + t;
}

function pinEl(p) {
  const d = DIRS[p.o];
  let s = '';
  let bx = p.x, by = p.y;
  if (p.dot) { const cx = p.x + d[0] * 2, cy = p.y + d[1] * 2; s += `<circle cx="${f(cx)}" cy="${f(-cy)}" r="2" fill="none" stroke="${p.color}" stroke-width="0.8"/>`; bx = p.x + d[0] * 4; by = p.y + d[1] * 4; }
  if (p.clock) {
    const n = [-d[1], d[0]];
    s += `<path d="M${f(p.x + n[0] * 3)} ${f(-(p.y + n[1] * 3))}L${f(p.x - d[0] * 4)} ${f(-(p.y - d[1] * 4))}L${f(p.x - n[0] * 3)} ${f(-(p.y - n[1] * 3))}" fill="none" stroke="${p.color}" stroke-width="0.6"/>`;
  }
  s += `<line x1="${f(bx)}" y1="${f(-by)}" x2="${f(p.ex)}" y2="${f(-p.ey)}" stroke="${p.color}" stroke-width="1"/>`;
  const vert = p.o === 1 || p.o === 3;
  if (p.showName && p.name) {
    const nx = p.x - d[0] * 4, ny = p.y - d[1] * 4;
    const h = p.o === 0 || p.o === 1 ? 2 : 0;
    s += textEl(nx, ny, p.name, p.nameFont, '#000000', vert ? 90 : 0, h, 1, ' class="pn"');
  }
  if (p.showDes && p.des) {
    const mx = p.x + d[0] * Math.min(p.len - 2, 6), my = p.y + d[1] * Math.min(p.len - 2, 6);
    const h = p.o === 0 || p.o === 1 ? 0 : 2;
    s += textEl(mx + (vert ? -1 : 0), my + (vert ? 0 : 1), p.des, p.font, '#000000', vert ? 90 : 0, h, 0, ' class="pd"');
  }
  return s;
}

export function renderSch(sch, link, si) {
  const out = [];
  const W = sch.sheet.w, H = sch.sheet.h, m = sch.sheet.margin || 20;
  // sheet
  out.push(`<g class="sheet"><rect x="0" y="${-H}" width="${W}" height="${H}" fill="${sch.sheet.area}" stroke="#000" stroke-width="1"/>`);
  if (sch.sheet.border) {
    out.push(`<rect x="${m}" y="${-H + m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="none" stroke="#000" stroke-width="1"/>`);
    const xz = sch.sheet.xz || 4, yz = sch.sheet.yz || 4;
    for (let i = 0; i < xz; i++) {
      const x = m + ((W - 2 * m) * (i + 0.5)) / xz;
      for (const yy of [-H + m / 2, -m / 2]) out.push(`<text x="${f(x)}" y="${f(yy)}" class="zone">${i + 1}</text>`);
      if (i) { const xl = m + ((W - 2 * m) * i) / xz; out.push(`<path d="M${f(xl)} ${-H}v${m}M${f(xl)} 0v${-m}" stroke="#000" stroke-width="0.6"/>`); }
    }
    for (let i = 0; i < yz; i++) {
      const y = -(H - m - ((H - 2 * m) * (i + 0.5)) / yz);
      const ch = String.fromCharCode(65 + i);
      for (const xx of [m / 2, W - m / 2]) out.push(`<text x="${f(xx)}" y="${f(y)}" class="zone">${ch}</text>`);
      if (i) { const yl = -(H - m - ((H - 2 * m) * i) / yz); out.push(`<path d="M0 ${f(yl)}h${m}M${W} ${f(yl)}h${-m}" stroke="#000" stroke-width="0.6"/>`); }
    }
  }
  out.push('</g>');

  // group by component
  const byComp = new Map();
  const loose = [];
  for (const p of sch.prims) {
    if (p.comp >= 0) { if (!byComp.has(p.comp)) byComp.set(p.comp, []); byComp.get(p.comp).push(p); }
    else loose.push(p);
  }
  const pinsByComp = new Map();
  for (const p of sch.pins) { if (p.comp < 0 || p.hidden) continue; if (!pinsByComp.has(p.comp)) pinsByComp.set(p.comp, []); pinsByComp.get(p.comp).push(p); }

  const prim = (p, extraAttr = '') => {
    const lw = f(p.w ?? 1);
    switch (p.t) {
      case 'poly': {
        const pts = p.pts.map(([x, y]) => f(x) + ',' + f(-y)).join(' ');
        const tag = p.closed ? 'polygon' : 'polyline';
        const dash = p.dash === 1 ? ' stroke-dasharray="4 3"' : p.dash === 2 ? ' stroke-dasharray="1 2"' : '';
        return `<${tag} points="${pts}" stroke="${p.color}" stroke-width="${lw}" fill="${p.fill || 'none'}" stroke-linejoin="round" stroke-linecap="round"${dash}${extraAttr}/>`;
      }
      case 'bezier': {
        const v = p.pts; if (v.length < 4) return '';
        let d = `M${f(v[0][0])} ${f(-v[0][1])}`;
        for (let i = 1; i + 2 < v.length; i += 3) d += `C${f(v[i][0])} ${f(-v[i][1])} ${f(v[i + 1][0])} ${f(-v[i + 1][1])} ${f(v[i + 2][0])} ${f(-v[i + 2][1])}`;
        return `<path d="${d}" stroke="${p.color}" stroke-width="${lw}" fill="none"/>`;
      }
      case 'rect': {
        const x = Math.min(p.x1, p.x2), y = Math.max(p.y1, p.y2), w = Math.abs(p.x2 - p.x1), h = Math.abs(p.y2 - p.y1);
        return `<rect x="${f(x)}" y="${f(-y)}" width="${f(w)}" height="${f(h)}"${p.rx ? ` rx="${f(p.rx)}" ry="${f(p.ry)}"` : ''} stroke="${p.color}" stroke-width="${lw}" fill="${p.fill || 'none'}"${p.dash ? ' stroke-dasharray="4 3"' : ''}/>`;
      }
      case 'ellipse': return `<ellipse cx="${f(p.cx)}" cy="${f(-p.cy)}" rx="${f(p.rx)}" ry="${f(p.ry)}" stroke="${p.color}" stroke-width="${lw}" fill="${p.fill || 'none'}"/>`;
      case 'arc': {
        const d = arcPath(p.cx, p.cy, p.rx, p.ry, p.sa, p.ea);
        if (!d) return `<ellipse cx="${f(p.cx)}" cy="${f(-p.cy)}" rx="${f(p.rx)}" ry="${f(p.ry)}" stroke="${p.color}" stroke-width="${lw}" fill="none"/>`;
        return `<path d="${d}" stroke="${p.color}" stroke-width="${lw}" fill="none"/>`;
      }
      case 'text': return textEl(p.x, p.y, p.text, p.font, p.color, p.rot, p.h, p.v, extraAttr);
      case 'frame': {
        const x = Math.min(p.x1, p.x2), y = Math.max(p.y1, p.y2), w = Math.abs(p.x2 - p.x1), h = Math.abs(p.y2 - p.y1);
        let s = '';
        if (p.fill || p.border) s += `<rect x="${f(x)}" y="${f(-y)}" width="${f(w)}" height="${f(h)}" fill="${p.fill || 'none'}" stroke="${p.border ? p.bcolor : 'none'}" stroke-width="1"/>`;
        s += textEl(x + 2, y - 2, p.text, p.font, p.color, 0, 0, 2);
        return s;
      }
      case 'junction': return `<circle cx="${f(p.x)}" cy="${f(-p.y)}" r="2" fill="${p.color}"${extraAttr}/>`;
      case 'power': return `<g${extraAttr}>${powerSymbol(p)}</g>`;
      case 'port': return `<g${extraAttr}>${portShape(p)}</g>`;
      case 'noerc': return `<path d="M${f(p.x - 3)} ${f(-p.y - 3)}l6 6m0 -6l-6 6" stroke="${p.color}" stroke-width="1"/>`;
      case 'directive': {
        const d = DIRS[p.o & 3];
        const ex = p.x + d[0] * 6, ey = p.y + d[1] * 6;
        return `<g class="dir"><line x1="${f(p.x)}" y1="${f(-p.y)}" x2="${f(ex)}" y2="${f(-ey)}" stroke="${p.color}" stroke-width="1"/><circle cx="${f(ex)}" cy="${f(-ey)}" r="1.5" fill="${p.color}"/>${textEl(ex + (d[0] >= 0 ? 2 : -2), ey + 2, p.name, { size: 7, name: 'Arial' }, p.color, 0, d[0] >= 0 ? 0 : 2, 0)}</g>`;
      }
    }
    return '';
  };

  // wires etc (loose) first, then components on top
  const wn = link?.wireNet?.[si];
  const ln = link?.labelNet?.[si];
  out.push('<g class="loose">');
  for (const p of loose) {
    let attr = '';
    if (p.kind === 'wire' && wn) attr = ` data-n="${wn[p.wire]}" class="wire"`;
    else if ((p.kind === 'netlabel' || p.kind === 'power' || p.kind === 'port') && ln) {
      const li = p.kind === 'netlabel' ? p.labelIdx : sch.labels.findIndex((l) => l.x === p.x && l.y === p.y && l.name === p.name);
      if (li >= 0) attr = ` data-n="${ln[li]}" class="lbl"`;
    } else if (p.kind === 'junction') attr = ' class="jn"';
    out.push(prim(p, attr));
  }
  out.push('</g><g class="comps">');
  const pn = link?.pinNet?.[si];
  for (const c of sch.components) {
    const ps = byComp.get(c.ci) || [];
    out.push(`<g class="comp" data-c="${c.ci}">`);
    for (const p of ps) if (p.kind === 'body') out.push(prim(p));
    for (const pin of pinsByComp.get(c.ci) || []) out.push(`<g class="pin" data-pin="${pin.pi}"${pn ? ` data-n="${pn[pin.pi]}"` : ''}>${pinEl(pin)}</g>`);
    for (const p of ps) if (p.kind !== 'body') out.push(prim(p));
    out.push('</g>');
  }
  out.push('</g>');
  // junctions on top of everything
  return { svg: out.join(''), bbox: [0, 0, W, H] };
}
