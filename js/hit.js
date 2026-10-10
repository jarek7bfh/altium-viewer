// Hit testing in model coordinates
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function inPoly(px, py, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
const inBox = (x, y, b, m = 0) => x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m;
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);

/** returns {comp, net} where either may be -1 */
export function hitSch(sch, link, si, x, y, tol, mode) {
  let pin = null, pd = Infinity;
  for (const p of sch.pins) {
    if (p.comp < 0 || p.hidden) continue;
    const d = segDist(x, y, p.x, p.y, p.ex, p.ey);
    if (d < tol && d < pd) { pd = d; pin = p; }
  }
  let wireNet = -1, wd = Infinity;
  sch.wires.forEach((w, wi) => {
    for (let k = 0; k + 1 < w.pts.length; k++) {
      const d = segDist(x, y, w.pts[k][0], w.pts[k][1], w.pts[k + 1][0], w.pts[k + 1][1]);
      if (d < tol && d < wd) { wd = d; wireNet = link.wireNet[si][wi]; }
    }
  });
  let labelNet = -1;
  sch.labels.forEach((l, li) => {
    const w = Math.max(l.name.length * 6, 8);
    if (x >= l.x - tol && x <= l.x + w + tol && y >= l.y - tol && y <= l.y + 10 + tol) labelNet = link.labelNet[si][li];
    else if (Math.hypot(x - l.x, y - l.y) < tol * 1.5) labelNet = link.labelNet[si][li];
  });
  let comp = -1, ca = Infinity;
  for (const c of sch.components) {
    if (!c.bbox) continue;
    if (inBox(x, y, c.bbox, tol * 0.3)) { const a = area(c.bbox); if (a < ca) { ca = a; comp = c.ci; } }
  }
  const pinNet = pin ? link.pinNet[si][pin.pi] : -1;
  const net = pinNet >= 0 ? pinNet : wireNet >= 0 ? wireNet : labelNet;
  if (mode === 'net') {
    if (net >= 0) return { net, comp: -1 };
    return { comp, net: -1 };
  }
  if (comp >= 0) return { comp, net: -1 };
  if (pin) return { comp: pin.comp, net: -1 };
  return { comp: -1, net };
}

export function hitPcb(pcb, vis, flip, compBox, x, y, tol, mode) {
  const side = flip ? 'BOTTOM' : 'TOP';
  const cuVis = (l) => (l === 1 ? vis.tcu : l === 32 ? vis.bcu : l === 74 ? vis.multi : false);
  // pads
  let pad = null, pdist = Infinity;
  for (const p of pcb.pads) {
    if (!cuVis(p.layer)) continue;
    const s = p.layer === 74 ? (flip ? p.bot : p.top) : p.top;
    const a = (-p.rot * Math.PI) / 180;
    const dx = x - p.x, dy = y - p.y;
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    const ex = Math.max(0, Math.abs(lx) - s[0] / 2), ey = Math.max(0, Math.abs(ly) - s[1] / 2);
    const d = Math.hypot(ex, ey);
    // prefer pads on visible side
    const pen = p.layer === 74 || (p.layer === 1) !== flip ? 0 : tol * 0.5;
    if (d + pen < tol && d + pen < pdist) { pdist = d + pen; pad = p; }
  }
  let net = -1, nd = Infinity;
  if (vis.via) for (const v of pcb.vias) {
    const d = Math.max(0, Math.hypot(x - v.x, y - v.y) - v.d / 2);
    if (d < tol && d < nd) { nd = d; net = v.net; }
  }
  const trVis = (l) => (l === 1 ? vis.tcu : l === 32 ? vis.bcu : false);
  for (const t of pcb.tracks) {
    if (t.net < 0 || !trVis(t.layer) || t.poly >= 0) continue;
    const d = Math.max(0, segDist(x, y, t.x1, t.y1, t.x2, t.y2) - t.w / 2);
    const pen = (t.layer === 1) !== flip ? 0 : tol * 0.3;
    if (d + pen < tol && d + pen < nd) { nd = d + pen; net = t.net; }
  }
  for (const a of pcb.arcs) {
    if (a.net < 0 || !trVis(a.layer) || a.poly >= 0) continue;
    const r = Math.hypot(x - a.cx, y - a.cy);
    let ang = (Math.atan2(y - a.cy, x - a.cx) * 180) / Math.PI; ang = (ang + 360) % 360;
    const sa = ((a.sa % 360) + 360) % 360; let span = ((a.ea - a.sa) % 360 + 360) % 360; if (!span) span = 360;
    const rel = (ang - sa + 360) % 360;
    if (rel > span) continue;
    const d = Math.max(0, Math.abs(r - a.r) - a.w / 2);
    if (d < tol && d < nd) { nd = d; net = a.net; }
  }
  // components
  let comp = -1, ca = Infinity;
  for (const [ci, b] of compBox) {
    if (!inBox(x, y, b, tol * 0.2)) continue;
    const c = pcb.components[ci];
    const a = area(b) * (c.layer === side ? 1 : 4);
    if (a < ca) { ca = a; comp = ci; }
  }
  // pours (lowest priority)
  let pourNet = -1;
  if (net < 0 && !pad) {
    const regs = pcb.regions.length ? pcb.regions : pcb.sregions;
    const order = flip ? [32, 1] : [1, 32];
    for (const L of order) {
      if (pourNet >= 0) break;
      const visL = L === 1 ? vis.tpour || vis.tcu : vis.bpour || vis.bcu;
      if (!visL) continue;
      for (const r of regs) {
        if (r.layer !== L || r.net < 0 || r.kind !== 0) continue;
        if (inPoly(x, y, r.pts) && !r.holes.some((h) => inPoly(x, y, h))) { pourNet = r.net; break; }
      }
    }
  }
  if (mode === 'net') {
    if (pad && pad.net >= 0) return { net: pad.net, comp: -1 };
    if (net >= 0) return { net, comp: -1 };
    if (comp >= 0) return { comp, net: -1 };
    return { net: pourNet, comp: -1 };
  }
  if (pad && pad.comp >= 0) return { comp: pad.comp, net: -1 };
  if (comp >= 0 && net < 0) return { comp, net: -1 };
  if (net >= 0) return { net, comp: -1 };
  if (comp >= 0) return { comp, net: -1 };
  return { net: pourNet, comp: -1 };
}
