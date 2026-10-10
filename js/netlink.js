// Schematic connectivity + schematic <-> PCB linking
class UF {
  constructor() { this.p = new Map(); }
  find(a) {
    let p = this.p.get(a);
    if (p === undefined) { this.p.set(a, a); return a; }
    if (p === a) return a;
    const r = this.find(p); this.p.set(a, r); return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

const EPS = 0.02;
function onSeg(px, py, [x1, y1], [x2, y2]) {
  if (px < Math.min(x1, x2) - EPS || px > Math.max(x1, x2) + EPS || py < Math.min(y1, y2) - EPS || py > Math.max(y1, y2) + EPS) return false;
  const cr = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  return Math.abs(cr) / len < EPS;
}

/**
 * @param {Array} schs parsed schematic sheets
 * @param {object|null} pcb parsed pcb
 */
export function linkProject(schs, pcb) {
  const uf = new UF();
  const byName = new Map(); // global label names
  schs.forEach((sch, s) => {
    const W = (i) => `${s}:W${i}`;
    const segs = [];
    sch.wires.forEach((w, wi) => {
      for (let k = 0; k + 1 < w.pts.length; k++) segs.push([wi, w.pts[k], w.pts[k + 1]]);
      uf.find(W(wi));
    });
    const hot = [];
    sch.wires.forEach((w, wi) => {
      hot.push([w.pts[0][0], w.pts[0][1], W(wi)]);
      const l = w.pts[w.pts.length - 1];
      hot.push([l[0], l[1], W(wi)]);
    });
    sch.pins.forEach((p) => { if (!p.hidden) hot.push([p.ex, p.ey, `${s}:P${p.pi}`]); uf.find(`${s}:P${p.pi}`); });
    sch.labels.forEach((l, li) => { hot.push([l.x, l.y, `${s}:L${li}`]); uf.find(`${s}:L${li}`); });
    sch.junctions.forEach(([x, y], ji) => hot.push([x, y, `${s}:J${ji}`]));
    // hot point on wire segment
    for (const [x, y, id] of hot) {
      for (const [wi, a, b] of segs) if (onSeg(x, y, a, b)) uf.union(id, W(wi));
    }
    // coincident hot points (pin-to-pin, label on pin end, etc.)
    const at = new Map();
    for (const [x, y, id] of hot) {
      const k = Math.round(x * 50) + ',' + Math.round(y * 50);
      const e = at.get(k);
      if (e) uf.union(id, e); else at.set(k, id);
    }
    // names
    sch.labels.forEach((l, li) => {
      const key = 'N:' + l.name.toUpperCase();
      uf.union(`${s}:L${li}`, key);
      byName.set(key, l.name);
    });
    // hidden power pins join net by pin name
    sch.pins.forEach((p) => {
      if (p.hidden && p.name) { const key = 'N:' + p.name.toUpperCase(); uf.union(`${s}:P${p.pi}`, key); byName.set(key, p.name); }
    });
  });

  // build nets
  const nets = [];
  const rootToNet = new Map();
  const netOf = (root) => {
    let n = rootToNet.get(root);
    if (n == null) { n = nets.length; rootToNet.set(root, n); nets.push({ id: n, names: new Set(), pins: [], wires: [], labels: [], pcb: -1, name: '' }); }
    return nets[n];
  };
  const pinNet = schs.map((sch) => new Int32Array(sch.pins.length).fill(-1));
  const wireNet = schs.map((sch) => new Int32Array(sch.wires.length).fill(-1));
  const labelNet = schs.map((sch) => new Int32Array(sch.labels.length).fill(-1));
  schs.forEach((sch, s) => {
    sch.pins.forEach((p) => {
      if (p.comp < 0) return;
      const n = netOf(uf.find(`${s}:P${p.pi}`)); n.pins.push([s, p.pi]); pinNet[s][p.pi] = n.id;
    });
    sch.wires.forEach((w, wi) => { const n = netOf(uf.find(`${s}:W${wi}`)); n.wires.push([s, wi]); wireNet[s][wi] = n.id; });
    sch.labels.forEach((l, li) => { const n = netOf(uf.find(`${s}:L${li}`)); n.labels.push([s, li]); n.names.add(l.name); labelNet[s][li] = n.id; });
  });
  for (const [key, name] of byName) { const r = uf.find(key); if (rootToNet.has(r)) nets[rootToNet.get(r)].names.add(name); }

  // PCB linking
  const pcbNetToSch = pcb ? pcb.nets.map(() => []) : [];
  const padKey = new Map();
  if (pcb) {
    pcb.pads.forEach((pd) => {
      if (pd.comp < 0 || pd.net < 0) return;
      const c = pcb.components[pd.comp];
      padKey.set(c.des + '|' + pd.name, pd.net);
    });
  }
  const compDes = (s, pi) => { const p = schs[s].pins[pi]; return schs[s].components[p.comp].des; };
  for (const n of nets) {
    if (pcb) {
      const votes = new Map();
      for (const [s, pi] of n.pins) {
        const k = compDes(s, pi) + '|' + schs[s].pins[pi].des;
        const pn = padKey.get(k);
        if (pn != null) votes.set(pn, (votes.get(pn) || 0) + 1);
      }
      let best = -1, bc = 0;
      for (const [k, v] of votes) if (v > bc) { bc = v; best = k; }
      n.pcb = best;
      if (best >= 0) pcbNetToSch[best].push(n.id);
    }
    const names = [...n.names];
    n.name = names.find((x) => n.pcb >= 0 && pcb.nets[n.pcb] === x) || names[0] || (n.pcb >= 0 ? pcb.nets[n.pcb] : '');
    if (!n.name && n.pins.length) { const [s, pi] = n.pins[0]; n.name = `Net${compDes(s, pi)}_${schs[s].pins[pi].des}`; }
    n.names = names;
  }

  // component links by designator
  const schCompsByDes = new Map();
  schs.forEach((sch, s) => sch.components.forEach((c) => {
    if (!c.des) return;
    if (!schCompsByDes.has(c.des)) schCompsByDes.set(c.des, []);
    schCompsByDes.get(c.des).push([s, c.ci]);
  }));
  const pcbCompByDes = new Map();
  if (pcb) pcb.components.forEach((c) => pcbCompByDes.set(c.des, c.i));

  // mismatch report
  const issues = [];
  if (pcb) {
    for (const des of schCompsByDes.keys()) if (!pcbCompByDes.has(des)) issues.push({ kind: 'comp-missing-pcb', des });
    for (const des of pcbCompByDes.keys()) if (!schCompsByDes.has(des)) issues.push({ kind: 'comp-missing-sch', des });
    for (const n of nets) {
      if (n.pins.length < 1) continue;
      const pcbNets = new Set();
      for (const [s, pi] of n.pins) {
        const pn = padKey.get(compDes(s, pi) + '|' + schs[s].pins[pi].des);
        if (pn != null) pcbNets.add(pn);
      }
      if (pcbNets.size > 1) issues.push({ kind: 'net-split', net: n.id, name: n.name, pcbNets: [...pcbNets].map((i) => pcb.nets[i]) });
    }
  }

  return { nets, pinNet, wireNet, labelNet, pcbNetToSch, schCompsByDes, pcbCompByDes, issues };
}
