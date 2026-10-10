// 3D board view (three.js). Units: mm, origin at board centre, Z up. Board spans z = 0 (bottom) .. T (top).
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

const MM = 0.0254; // mil -> mm
const ACCENT = 0x38bdf8;

// realistic look for the board textures
const TEX_CSS = `
.ol{fill:#1d5f36;stroke:none}
g[data-l=tcu],g[data-l=bcu],g[data-l=tpour],g[data-l=bpour]{fill:#2c7d48;stroke:#2c7d48}
g[data-l=multi]{fill:#d2b04c} g[data-l=via]{fill:#2c7d48} g[data-l=hole]{fill:#0b0b0b}
g[data-l=tsilk],g[data-l=bsilk]{fill:#f4f4f0;stroke:#f4f4f0}
.tr{fill:none;stroke-linecap:round;stroke-linejoin:round}
text{stroke:none}
.pd{fill:#d2b04c;stroke:none}
`;

function arcPoints(cx, cy, r, a1, a2, ccw = true) {
  let span = ((a2 - a1) % 360 + 360) % 360; if (span === 0) span = 360;
  if (!ccw) span = span - 360;
  const n = Math.max(4, Math.ceil(Math.abs(span) / 10));
  const out = [];
  for (let i = 0; i <= n; i++) { const a = ((a1 + (span * i) / n) * Math.PI) / 180; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** board outline (Board6 vertex list, mil) -> array of [x,y] mil */
function outlinePoints(v) {
  const pts = [];
  for (const a of v) {
    if (a.kind === 1 && a.r > 0) {
      const s = [a.cx + a.r * Math.cos((a.sa * Math.PI) / 180), a.cy + a.r * Math.sin((a.sa * Math.PI) / 180)];
      const e = [a.cx + a.r * Math.cos((a.ea * Math.PI) / 180), a.cy + a.r * Math.sin((a.ea * Math.PI) / 180)];
      const ds = Math.hypot(s[0] - a.x, s[1] - a.y), de = Math.hypot(e[0] - a.x, e[1] - a.y);
      const arc = arcPoints(a.cx, a.cy, a.r, a.sa, a.ea);
      pts.push(...(ds <= de ? arc : arc.reverse()));
    } else pts.push([a.x, a.y]);
  }
  return pts;
}

function bgrToHex(c) { return ((c & 255) << 16) | (((c >> 8) & 255) << 8) | ((c >> 16) & 255); }

export class View3D {
  constructor(host, { onPick } = {}) {
    this.host = host;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x0b0e13, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'v3d-canvas';
    host.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.6));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.6); d1.position.set(-120, -160, 300); this.scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.7); d2.position.set(150, 120, -260); this.scene.add(d2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.8;
    this.controls.zoomSpeed = 1.1;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => this.render());
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.compObjs = new Map(); // comp index -> [Object3D]
    this.sel = null;
    this._bindPick();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
  }

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.render();
  }
  render() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.renderer.render(this.scene, this.camera); }); }

  clear() {
    this.root.traverse((o) => { if (o.geometry && !o.userData.sharedGeo) o.geometry.dispose(); if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); } });
    this.root.clear();
    this.compObjs.clear();
    this.sel = null;
  }

  /**
   * @param pcb parsed pcb
   * @param groups 2D render groups (pcbrender) for board textures
   * @param meshes Map modelId -> {pos, col, idx} or null
   * @param useStep use STEP meshes when available
   */
  async build(pcb, groups, meshes, useStep) {
    this.clear();
    this.pcb = pcb;
    const T = pcb.board.thickness * MM;
    this.T = T;
    const ol = outlinePoints(pcb.outline);
    let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    for (const [x, y] of ol) { bx1 = Math.min(bx1, x); by1 = Math.min(by1, y); bx2 = Math.max(bx2, x); by2 = Math.max(by2, y); }
    if (!ol.length) { bx1 = 0; by1 = 0; bx2 = 1000; by2 = 1000; }
    this.bbox = [bx1, by1, bx2, by2];
    const cx = (bx1 + bx2) / 2, cy = (by1 + by2) / 2;
    this.cx = cx; this.cy = cy;
    const X = (x) => (x - cx) * MM, Y = (y) => (y - cy) * MM;
    // board shape with holes
    const shape = new THREE.Shape(ol.map(([x, y]) => new THREE.Vector2(X(x), Y(y))));
    for (const p of pcb.pads) {
      if (p.hole * MM < 0.6) continue;
      const h = new THREE.Path(); h.absarc(X(p.x), Y(p.y), (p.hole / 2) * MM, 0, Math.PI * 2, true); shape.holes.push(h);
    }
    const board = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 16 }), new THREE.MeshStandardMaterial({ color: 0x1b5130, roughness: 0.7, metalness: 0.05 }));
    this.root.add(board);
    // textured top & bottom faces
    const w = (bx2 - bx1) * MM, h = (by2 - by1) * MM;
    const faceGeo = new THREE.ShapeGeometry(shape, 16);
    const uv = faceGeo.attributes.uv, pos = faceGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
    const [texTop, texBot] = await Promise.all([this._texture(groups, false), this._texture(groups, true)]);
    const top = new THREE.Mesh(faceGeo, new THREE.MeshStandardMaterial({ map: texTop, roughness: 0.55, metalness: 0.1 }));
    top.position.z = T + 0.005;
    const bot = new THREE.Mesh(faceGeo.clone(), new THREE.MeshStandardMaterial({ map: texBot, roughness: 0.55, metalness: 0.1, side: THREE.BackSide }));
    bot.position.z = -0.005;
    this.root.add(top, bot);
    // components
    const geoCache = new Map();
    const stepGeo = (id) => {
      if (!meshes || !meshes.has(id)) return null;
      if (geoCache.has(id)) return geoCache.get(id);
      const m = meshes.get(id);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(m.col, 3, true));
      g.setIndex(new THREE.BufferAttribute(m.idx, 1));
      g.computeVertexNormals();
      geoCache.set(id, g);
      return g;
    };
    let usedStep = 0, simple = 0;
    for (const b of pcb.bodies) {
      let obj = null;
      const bottom = b.side === 'BOTTOM';
      const g = useStep && b.type === 1 ? stepGeo(b.modelId) : null;
      if (g) {
        obj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15 }));
        obj.userData.sharedGeo = true;
        const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((b.rx * Math.PI) / 180, (b.ry * Math.PI) / 180, (b.rz * Math.PI) / 180, 'ZYX') /* Altium: X, then Y, then Z (fixed axes) */);
        const M = new THREE.Matrix4();
        if (bottom) M.makeTranslation(X(b.x), Y(b.y), -b.dz * MM).multiply(new THREE.Matrix4().makeRotationY(Math.PI)).multiply(R);
        else M.makeTranslation(X(b.x), Y(b.y), T + b.dz * MM).multiply(R);
        obj.matrixAutoUpdate = false; obj.matrix.copy(M);
        usedStep++;
      } else {
        obj = this._simpleBody(b, X, Y, T);
        if (obj) simple++;
      }
      if (!obj) continue;
      obj.userData.comp = b.comp;
      this.root.add(obj);
      if (b.comp >= 0) { if (!this.compObjs.has(b.comp)) this.compObjs.set(b.comp, []); this.compObjs.get(b.comp).push(obj); }
    }
    this.stats = { usedStep, simple };
    this.root.rotation.set(0, 0, 0); this.root.position.z = 0;
    if (!this._viewSet) { this.viewAll(false, false); this._viewSet = true; }
    this.resize();
    return this.stats;
  }

  _simpleBody(b, X, Y, T) {
    const bottom = b.side === 'BOTTOM';
    const color = b.type === 1 ? 0x3d434c : b.color != null ? bgrToHex(b.color) : 0x6b7280;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, transparent: b.opacity < 1, opacity: Math.max(0.2, b.opacity) });
    let geo, z0, hgt;
    if (b.type === 2 && b.cylR > 0) {
      hgt = (b.cylH || b.height) * MM;
      geo = new THREE.CylinderGeometry(b.cylR * MM, b.cylR * MM, hgt, 24); geo.rotateX(Math.PI / 2); geo.translate(0, 0, hgt / 2);
      const m = new THREE.Mesh(geo, mat);
      z0 = bottom ? -b.standoff * MM - hgt : T + b.standoff * MM;
      m.position.set(X(b.x), Y(b.y), z0);
      return m;
    }
    if (b.type === 3 && b.sphR > 0) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(b.sphR * MM, 20, 14), mat);
      m.position.set(X(b.x), Y(b.y), bottom ? -b.standoff * MM - b.sphR * MM : T + b.standoff * MM + b.sphR * MM);
      return m;
    }
    if (b.pts.length < 3) return null;
    // body spans from 'standoff' to 'overall height' measured from the board surface (standoff may be negative = through the board)
    hgt = Math.max((b.height - b.standoff) * MM, 0.1);
    const sh = new THREE.Shape(b.pts.map((p) => new THREE.Vector2(X(p.x), Y(p.y))));
    geo = new THREE.ExtrudeGeometry(sh, { depth: hgt, bevelEnabled: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.z = bottom ? -b.height * MM : T + b.standoff * MM;
    return m;
  }

  async _texture(groups, bottom) {
    const [x1, y1, x2, y2] = this.bbox;
    const order = bottom ? ['outline', 'bpour', 'bcu', 'multi', 'via', 'hole', 'bsilk'] : ['outline', 'tpour', 'tcu', 'multi', 'via', 'hole', 'tsilk'];
    const body = order.map((k) => `<g data-l="${k}">${(groups[k] || []).join('')}</g>`).join('');
    const hideCls = bottom ? '.pt{display:none}' : '.pb{display:none}';
    const W = x2 - x1, H = y2 - y1;
    const maxPx = Math.min(4096, this.renderer.capabilities.maxTextureSize || 4096);
    const scale = maxPx / Math.max(W, H);
    const pw = Math.round(W * scale), ph = Math.round(H * scale);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="${x1} ${-y2} ${W} ${H}"><style>${TEX_CSS}${hideCls}</style>${body}</svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas'); c.width = pw; c.height = ph;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1d5f36'; ctx.fillRect(0, 0, pw, ph);
      ctx.drawImage(img, 0, 0, pw, ph);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      return t;
    } finally { URL.revokeObjectURL(url); }
  }

  viewAll(fromBottom = false, animate = true) {
    const [x1, y1, x2, y2] = this.bbox;
    const span = Math.max(x2 - x1, y2 - y1) * MM;
    const d = span * 1.6;
    const target = new THREE.Vector3(0, 0, this.T / 2);
    const pos = new THREE.Vector3(0, -d * 0.55, fromBottom ? -d * 0.85 : d * 0.85);
    this._fly(pos, target, animate);
  }
  /** Bottom view like Altium's board flip: turn the board over around its Y axis, keep the camera above */
  setSide(bottom) {
    this.root.rotation.set(0, bottom ? Math.PI : 0, 0);
    this.root.position.z = bottom ? this.T : 0;
    this.root.updateMatrixWorld(true);
    if (this.selBox && this.sel != null) this.select(this.sel, false);
    this.viewAll(false);
  }

  _fly(pos, target, animate = true) {
    const c = this.camera, ctl = this.controls;
    if (!animate) { c.position.copy(pos); ctl.target.copy(target); ctl.update(); this.render(); return; }
    const p0 = c.position.clone(), t0 = ctl.target.clone();
    const start = performance.now();
    const step = (now) => {
      let a = Math.min(1, (now - start) / 350); a = 1 - Math.pow(1 - a, 3);
      c.position.lerpVectors(p0, pos, a); ctl.target.lerpVectors(t0, target, a); ctl.update(); this.render();
      if (a < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** highlight a component (or none); optionally bring it into view */
  select(ci, focus) {
    for (const objs of this.compObjs.values()) for (const o of objs) if (o.material && o.material.emissive) o.material.emissive.setHex(0);
    if (this.selBox) { this.root.remove(this.selBox); this.selBox = null; }
    this.sel = ci;
    if (ci == null || !this.compObjs.has(ci)) { this.render(); return; }
    const box = new THREE.Box3();
    for (const o of this.compObjs.get(ci)) {
      if (o.material && o.material.emissive) o.material.emissive.setHex(0x0b4f6c);
      o.updateMatrixWorld(true); box.expandByObject(o);
    }
    this.selBox = new THREE.Box3Helper(box.expandByScalar(0.3), ACCENT);
    this.root.add(this.selBox);
    if (focus) {
      const ctr = box.getCenter(new THREE.Vector3());
      const off = this.camera.position.clone().sub(this.controls.target);
      const want = Math.max(box.getSize(new THREE.Vector3()).length() * 4, 25);
      off.setLength(Math.min(off.length(), want));
      this._fly(ctr.clone().add(off), ctr);
    }
    this.render();
  }

  _bindPick() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { if (e.isPrimary) down = { x: e.clientX, y: e.clientY, t: performance.now(), n: 1 }; else if (down) down.n++; });
    el.addEventListener('pointerup', (e) => {
      if (!down || !e.isPrimary) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 450 || down.n > 1;
      down = null;
      if (moved) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, this.camera);
      const objs = [...this.compObjs.values()].flat();
      const hit = rc.intersectObjects(objs, false)[0];
      this.onPick && this.onPick(hit ? hit.object.userData.comp : null);
    });
  }

  dispose() { this.clear(); this.ro.disconnect(); this.renderer.dispose(); this.renderer.domElement.remove(); }
}
