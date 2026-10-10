// PCB -> SVG markup (units: mil, SVG y = -y)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (n) => Math.round(n * 100) / 100;

export const PCB_LAYERS = [
  { id: 'mech', name: 'Mechaniczne', on: true },
  { id: 'bpour', name: 'Bottom – wylewki', on: true },
  { id: 'bcu', name: 'Bottom – miedź', on: true },
  { id: 'inner', name: 'Warstwy wewnętrzne', on: true },
  { id: 'tpour', name: 'Top – wylewki', on: true },
  { id: 'tcu', name: 'Top – miedź', on: true },
  { id: 'multi', name: 'Pady przewlekane', on: true },
  { id: 'via', name: 'Przelotki', on: true },
  { id: 'hole', name: 'Otwory', on: true },
  { id: 'keepout', name: 'Keep-out', on: false },
  { id: 'bsilk', name: 'Bottom – opisy', on: true },
  { id: 'tsilk', name: 'Top – opisy', on: true },
  { id: 'outline', name: 'Obrys płytki', on: true },
];

export function groupForLayer(l, isPour) {
  if (l === 1) return isPour ? 'tpour' : 'tcu';
  if (l === 32) return isPour ? 'bpour' : 'bcu';
  if (l > 1 && l < 32) return 'inner';
  if (l >= 39 && l <= 54) return 'inner';
  if (l === 33) return 'tsilk';
  if (l === 34) return 'bsilk';
  if (l === 56) return 'keepout';
  if (l >= 57 && l <= 72) return 'mech';
  if (l === 74) return 'multi';
  return null; // paste/solder/drill etc. not drawn
}

function arcD(cx, cy, r, sa, ea) {
  let span = ((ea - sa) % 360 + 360) % 360;
  if (span === 0) span = 360;
  if (span >= 359.99) return { circle: true };
  const a1 = (sa * Math.PI) / 180, a2 = (ea * Math.PI) / 180;
  return { d: `M${f(cx + r * Math.cos(a1))} ${f(-(cy + r * Math.sin(a1)))}A${f(r)} ${f(r)} 0 ${span > 180 ? 1 : 0} 0 ${f(cx + r * Math.cos(a2))} ${f(-(cy + r * Math.sin(a2)))}` };
}

export function outlinePath(v) {
  if (!v.length) return '';
  let d = '';
  const P = (x, y) => `${f(x)} ${f(-y)}`;
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    if (a.kind === 1 && a.r > 0) {
      const s = { x: a.cx + a.r * Math.cos((a.sa * Math.PI) / 180), y: a.cy + a.r * Math.sin((a.sa * Math.PI) / 180) };
      const e = { x: a.cx + a.r * Math.cos((a.ea * Math.PI) / 180), y: a.cy + a.r * Math.sin((a.ea * Math.PI) / 180) };
      let span = ((a.ea - a.sa) % 360 + 360) % 360;
      const ds = Math.hypot(s.x - a.x, s.y - a.y), de = Math.hypot(e.x - a.x, e.y - a.y);
      const large = span > 180 ? 1 : 0;
      if (ds <= de) d += (d ? 'L' : 'M') + P(s.x, s.y) + `A${f(a.r)} ${f(a.r)} 0 ${large} 0 ` + P(e.x, e.y);
      else d += (d ? 'L' : 'M') + P(e.x, e.y) + `A${f(a.r)} ${f(a.r)} 0 ${large} 1 ` + P(s.x, s.y);
    } else {
      d += (d ? 'L' : 'M') + P(a.x, a.y);
    }
  }
  return d + 'Z';
}

function padSize(pd, side) {
  if (side === 'bot') return { s: pd.bot, shape: pd.botShape, alt: pd.altBot, cr: pd.crBot };
  return { s: pd.top, shape: pd.topShape, alt: pd.altTop, cr: pd.crTop };
}

export function padGeom(pd, side) {
  const { s, shape, alt, cr } = padSize(pd, side);
  const [sx, sy] = s;
  const x = pd.x, y = pd.y;
  const tr = pd.rot ? ` transform="rotate(${f(-pd.rot)} ${f(x)} ${f(-y)})"` : '';
  const mn = Math.min(sx, sy);
  if (shape === 1 && Math.abs(sx - sy) < 0.01) return `<circle cx="${f(x)}" cy="${f(-y)}" r="${f(sx / 2)}"`;
  if (shape === 3) {
    const c = mn * 0.25, hx = sx / 2, hy = sy / 2;
    const pts = [[-hx + c, hy], [hx - c, hy], [hx, hy - c], [hx, -hy + c], [hx - c, -hy], [-hx + c, -hy], [-hx, -hy + c], [-hx, hy - c]];
    return `<polygon points="${pts.map(([a, b]) => f(x + a) + ',' + f(-(y + b))).join(' ')}"${tr}`;
  }
  let rx = 0;
  if (shape === 1) rx = mn / 2;
  else if (alt === 9) rx = (cr / 100) * (mn / 2);
  return `<rect x="${f(x - sx / 2)}" y="${f(-y - sy / 2)}" width="${f(sx)}" height="${f(sy)}"${rx ? ` rx="${f(rx)}"` : ''}${tr}`;
}

function textEl(t, comps) {
  if (!t.text) return '';
  const c = t.comp >= 0 ? comps[t.comp] : null;
  if (c && t.isDesignator && !c.nameOn) return '';
  if (c && t.isComment && !c.commentOn) return '';
  const ttf = t.fontType === 1;
  const fs = ttf ? t.h : t.h * 1.3;
  const fam = ttf ? `'${(t.font || 'Arial').replace(/'/g, '')}',Arial,sans-serif` : "'Arial Narrow','Roboto Condensed',Arial,sans-serif";
  const tr = `translate(${f(t.x)} ${f(-t.y)})${t.mirrored ? ' scale(-1 1)' : ''}${t.rot ? ` rotate(${f(-t.rot)})` : ''}`;
  const lines = String(t.text).split(/\r?\n/);
  const w = ttf && t.bold ? 'bold' : 'normal';
  const body = lines.length === 1 ? esc(t.text) : lines.map((l, i) => `<tspan x="0" dy="${i ? f(fs * 1.1) : f(-fs * 1.1 * (lines.length - 1))}">${esc(l)}</tspan>`).join('');
  return `<text transform="${tr}" font-size="${f(fs)}" font-family="${fam}" font-weight="${w}"${ttf && t.italic ? ' font-style="italic"' : ''}${c ? ` data-c="${t.comp}"` : ''}>${body}</text>`;
}

export function renderPcb(pcb) {
  const G = {};
  for (const L of PCB_LAYERS) G[L.id] = [];
  const nattr = (n, c) => (n >= 0 ? ` data-n="${n}"` : '') + (c >= 0 ? ` data-c="${c}"` : '');

  // board outline
  const od = outlinePath(pcb.outline);
  let bbox = null;
  const grow = (x1, y1, x2, y2) => { if (!bbox) bbox = [x1, y1, x2, y2]; else { bbox[0] = Math.min(bbox[0], x1); bbox[1] = Math.min(bbox[1], y1); bbox[2] = Math.max(bbox[2], x2); bbox[3] = Math.max(bbox[3], y2); } };
  for (const v of pcb.outline) grow(v.x, v.y, v.x, v.y);
  G.outline.push(`<path d="${od}" class="ol"/>`);

  // regions (use Regions6 - plain polygons with holes)
  const regs = pcb.regions.length ? pcb.regions : pcb.sregions;
  for (const r of regs) {
    if (r.cutout || r.kind !== 0 && r.kind !== 4) continue;
    const isPour = r.poly >= 0;
    const g = r.keepout ? 'keepout' : groupForLayer(r.layer, isPour);
    if (!g) continue;
    let d = 'M' + r.pts.map((p) => f(p.x) + ' ' + f(-p.y)).join('L') + 'Z';
    for (const h of r.holes) if (h.length) d += 'M' + h.map((p) => f(p.x) + ' ' + f(-p.y)).join('L') + 'Z';
    G[g].push(`<path d="${d}" fill-rule="evenodd" class="rg"${nattr(r.net, r.comp)}/>`);
  }
  // fills
  for (const fl of pcb.fills) {
    const g = fl.keepout ? 'keepout' : groupForLayer(fl.layer, false);
    if (!g) continue;
    const cx = (fl.x1 + fl.x2) / 2, cy = (fl.y1 + fl.y2) / 2;
    const tr = fl.rot ? ` transform="rotate(${f(-fl.rot)} ${f(cx)} ${f(-cy)})"` : '';
    G[g].push(`<rect x="${f(Math.min(fl.x1, fl.x2))}" y="${f(-Math.max(fl.y1, fl.y2))}" width="${f(Math.abs(fl.x2 - fl.x1))}" height="${f(Math.abs(fl.y2 - fl.y1))}" class="fl"${tr}${nattr(fl.net, fl.comp)}/>`);
  }
  // tracks
  for (const t of pcb.tracks) {
    const g = t.keepout ? 'keepout' : groupForLayer(t.layer, t.poly >= 0);
    if (!g) continue;
    G[g].push(`<line x1="${f(t.x1)}" y1="${f(-t.y1)}" x2="${f(t.x2)}" y2="${f(-t.y2)}" stroke-width="${f(Math.max(t.w, 0.5))}" class="tr"${nattr(t.net, t.comp)}/>`);
    if (g === 'mech' || g === 'outline') grow(Math.min(t.x1, t.x2), Math.min(t.y1, t.y2), Math.max(t.x1, t.x2), Math.max(t.y1, t.y2));
  }
  for (const a of pcb.arcs) {
    const g = a.keepout ? 'keepout' : groupForLayer(a.layer, a.poly >= 0);
    if (!g) continue;
    const ad = arcD(a.cx, a.cy, a.r, a.sa, a.ea);
    if (ad.circle) G[g].push(`<circle cx="${f(a.cx)}" cy="${f(-a.cy)}" r="${f(a.r)}" stroke-width="${f(Math.max(a.w, 0.5))}" class="tr"${nattr(a.net, a.comp)}/>`);
    else G[g].push(`<path d="${ad.d}" stroke-width="${f(Math.max(a.w, 0.5))}" class="tr"${nattr(a.net, a.comp)}/>`);
  }
  // pads
  const compBox = new Map();
  const cgrow = (ci, x1, y1, x2, y2) => {
    if (ci < 0) return;
    const b = compBox.get(ci);
    if (!b) compBox.set(ci, [x1, y1, x2, y2]);
    else { b[0] = Math.min(b[0], x1); b[1] = Math.min(b[1], y1); b[2] = Math.max(b[2], x2); b[3] = Math.max(b[3], y2); }
  };
  pcb.pads.forEach((pd, i) => {
    const a = nattr(pd.net, pd.comp) + ` data-pad="${i}"`;
    const r = Math.max(...pd.top, ...pd.bot) / 2;
    cgrow(pd.comp, pd.x - r, pd.y - r, pd.x + r, pd.y + r);
    if (pd.layer === 74) {
      G.multi.push(`${padGeom(pd, 'top')} class="pd pt"${a}/>`);
      G.multi.push(`${padGeom(pd, 'bot')} class="pd pb"${a}/>`);
    } else {
      const g = groupForLayer(pd.layer, false);
      if (!g) return;
      G[g].push(`${padGeom(pd, 'top')} class="pd"${a}/>`);
    }
    if (pd.hole > 0) {
      if (pd.holeShape === 2 && pd.slot > pd.hole) {
        const L = pd.slot, W = pd.hole;
        G.hole.push(`<rect x="${f(pd.x - L / 2)}" y="${f(-pd.y - W / 2)}" width="${f(L)}" height="${f(W)}" rx="${f(W / 2)}" transform="rotate(${f(-(pd.rot + pd.slotRot))} ${f(pd.x)} ${f(-pd.y)})" class="ho${pd.plated ? '' : ' np'}"/>`);
      } else G.hole.push(`<circle cx="${f(pd.x)}" cy="${f(-pd.y)}" r="${f(pd.hole / 2)}" class="ho${pd.plated ? '' : ' np'}"/>`);
    }
  });
  pcb.vias.forEach((v) => {
    G.via.push(`<circle cx="${f(v.x)}" cy="${f(-v.y)}" r="${f(v.d / 2)}" class="vi"${nattr(v.net, -1)}/>`);
    G.hole.push(`<circle cx="${f(v.x)}" cy="${f(-v.y)}" r="${f(v.hole / 2)}" class="ho"/>`);
  });
  // overlay prims contribute to comp boxes
  for (const t of pcb.tracks) if ((t.layer === 33 || t.layer === 34) && t.comp >= 0) cgrow(t.comp, Math.min(t.x1, t.x2), Math.min(t.y1, t.y2), Math.max(t.x1, t.x2), Math.max(t.y1, t.y2));
  for (const a of pcb.arcs) if ((a.layer === 33 || a.layer === 34) && a.comp >= 0) cgrow(a.comp, a.cx - a.r, a.cy - a.r, a.cx + a.r, a.cy + a.r);
  // texts
  for (const t of pcb.texts) {
    const g = groupForLayer(t.layer, false);
    if (!g) continue;
    G[g].push(textEl(t, pcb.components));
  }
  if (!bbox) for (const b of compBox.values()) grow(...b);
  return { groups: G, bbox: bbox || [0, 0, 1000, 1000], compBox };
}
