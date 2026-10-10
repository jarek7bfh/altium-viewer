// Zoomable SVG pane with touch gestures. Works in "svg coords" (x, y down);
// model coords are mapped by the owner via toModel/fromModel (flip + y inversion).
const NS = 'http://www.w3.org/2000/svg';

export class Pane {
  constructor(host, { bg = '#000', onTap = null, minW = 5, maxW = 1e6 } = {}) {
    this.host = host;
    this.onTap = onTap;
    this.flipX = false;
    this.minW = minW; this.maxW = maxW;
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'pane-svg');
    this.svg.style.background = bg;
    this.root = document.createElementNS(NS, 'g');
    this.base = document.createElementNS(NS, 'g');
    this.base.setAttribute('class', 'base');
    this.ov = document.createElementNS(NS, 'g');
    this.ov.setAttribute('class', 'ov');
    this.root.append(this.base, this.ov);
    this.svg.append(this.root);
    host.append(this.svg);
    this.view = { x: 0, y: 0, w: 100, h: 100 };
    this.ptrs = new Map();
    this.g = null; // active gesture
    this.lastTap = 0; this._lastTapPos = [0, 0];
    this._bind();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(host);
  }

  get pxW() { return this.host.clientWidth || 1; }
  get pxH() { return this.host.clientHeight || 1; }
  get k() { return this.view.w / this.pxW; } // svg units per px

  setFlip(f) {
    if (f === this.flipX) { this.root.setAttribute('transform', f ? 'scale(-1 1)' : ''); return; }
    const c = this.view.x + this.view.w / 2;
    this.flipX = f;
    this.root.setAttribute('transform', f ? 'scale(-1 1)' : '');
    this.view.x = -c - this.view.w / 2;
    this._apply();
  }
  /** model (y up) -> svg coords */
  m2s(x, y) { return [this.flipX ? -x : x, -y]; }
  s2m(x, y) { return [this.flipX ? -x : x, -y]; }
  modelBoxToSvg([x1, y1, x2, y2]) {
    const a = this.m2s(x1, y1), b = this.m2s(x2, y2);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }

  _resize() {
    const ar = this.pxH / this.pxW;
    if (this._lastAr && Math.abs(this._lastAr - ar) < 1e-6 && this._lastW === this.pxW) return;
    // keep center & scale
    const cx = this.view.x + this.view.w / 2, cy = this.view.y + this.view.h / 2;
    let k = this._lastW ? this.view.w / this._lastW : null;
    if (!k || !isFinite(k)) { if (this._fitBox) { this._lastW = this.pxW; this._lastAr = ar; this.fitSvg(this._fitBox); return; } k = this.k; }
    this.view.w = k * this.pxW; this.view.h = k * this.pxH;
    this.view.x = cx - this.view.w / 2; this.view.y = cy - this.view.h / 2;
    this._lastW = this.pxW; this._lastAr = ar;
    this._apply();
  }

  _apply() {
    const v = this.view;
    this.view.h = v.w * (this.pxH / this.pxW);
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${this.view.h}`);
    this.svg.style.setProperty('--px', this.k);
    if (this.onView) this.onView();
  }

  /** fit box in svg coords */
  fitSvg([x1, y1, x2, y2], pad = 0.05) {
    this._fitBox = [x1, y1, x2, y2];
    const w = Math.max(x2 - x1, 1e-3), h = Math.max(y2 - y1, 1e-3);
    const ar = this.pxH / this.pxW;
    let vw = w * (1 + 2 * pad), vh = h * (1 + 2 * pad);
    if (vh / vw > ar) vw = vh / ar;
    vw = Math.min(Math.max(vw, this.minW), this.maxW);
    this.view = { x: (x1 + x2) / 2 - vw / 2, y: (y1 + y2) / 2 - (vw * ar) / 2, w: vw, h: vw * ar };
    this._apply();
  }
  fitModel(box, pad) { this.fitSvg(this.modelBoxToSvg(box), pad); }

  /** make model box visible: no-op if visible & readable, pan if it fits, else fit (not closer than minW) */
  reveal(box, minW = 0) {
    const [x1, y1, x2, y2] = this.modelBoxToSvg(box);
    const v = this.view;
    const ar = this.pxH / this.pxW;
    const bw = x2 - x1, bh = y2 - y1;
    const inside = x1 >= v.x && x2 <= v.x + v.w && y1 >= v.y && y2 <= v.y + v.h;
    const tiny = Math.max(bw / v.w, bh / v.h) < 0.04 && v.w > minW * 1.5;
    if (inside && !tiny) return;
    if (!tiny && bw <= v.w * 0.9 && bh <= v.h * 0.9) {
      this.animateTo({ x: (x1 + x2) / 2 - v.w / 2, y: (y1 + y2) / 2 - v.h / 2, w: v.w });
      return;
    }
    const w = Math.max(bw * 1.4, (bh * 1.4) / ar, minW);
    this.animateTo({ x: (x1 + x2) / 2 - w / 2, y: (y1 + y2) / 2 - (w * ar) / 2, w });
  }

  animateTo(t, ms = 260) {
    const s = { ...this.view };
    const t0 = performance.now();
    cancelAnimationFrame(this._raf);
    const step = (now) => {
      let a = Math.min(1, (now - t0) / ms);
      a = 1 - Math.pow(1 - a, 3);
      this.view.x = s.x + (t.x - s.x) * a; this.view.y = s.y + (t.y - s.y) * a; this.view.w = s.w + (t.w - s.w) * a;
      this._apply();
      if (a < 1) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  zoomAt(px, py, factor) {
    const v = this.view;
    const k = this.k;
    const sx = v.x + px * k, sy = v.y + py * k;
    let nw = Math.min(Math.max(v.w / factor, this.minW), this.maxW);
    const nk = nw / this.pxW;
    this.view = { x: sx - px * nk, y: sy - py * nk, w: nw, h: 0 };
    this._apply();
  }

  // measure against the untransformed host (the svg itself is CSS-scaled during a gesture)
  _local(e) { const r = this.host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  _bind() {
    const el = this.svg;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      cancelAnimationFrame(this._raf);
      this.ptrs.set(e.pointerId, this._local(e));
      this._startGesture(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.ptrs.has(e.pointerId)) return;
      this.ptrs.set(e.pointerId, this._local(e));
      this._moveGesture();
    });
    const end = (e) => {
      if (!this.ptrs.has(e.pointerId)) return;
      const wasTap = this.g && !this.g.moved && this.ptrs.size === 1 && this.g.n === 1 && performance.now() - this.g.t0 < 500;
      const pos = this.ptrs.get(e.pointerId);
      this.ptrs.delete(e.pointerId);
      if (this.ptrs.size === 0) { this._commit(); this.g = null; }
      else this._startGesture();
      if (wasTap && e.type === 'pointerup') this._tap(pos[0], pos[1], e.pointerType);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = this._local(e);
      this.zoomAt(px, py, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _startGesture() {
    if (this.g && this.g.moved) this._commit();
    const pts = [...this.ptrs.values()];
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    const d = pts.length > 1 ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) : 0;
    this.g = { c0: c, d0: d, n: Math.max(pts.length, this.g?.n || 0), moved: this.g?.moved || false, t0: this.g?.t0 || performance.now(), s: 1, tx: 0, ty: 0 };
  }

  _moveGesture() {
    const g = this.g; if (!g) return;
    const pts = [...this.ptrs.values()];
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    let s = 1;
    if (pts.length > 1 && g.d0 > 0) s = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) / g.d0;
    const dx = c[0] - g.c0[0], dy = c[1] - g.c0[1];
    if (!g.moved && Math.hypot(dx, dy) < 8 && Math.abs(s - 1) < 0.03) return;
    g.moved = true;
    // clamp scale
    const nw = this.view.w / s;
    if (nw < this.minW) s = this.view.w / this.minW;
    if (nw > this.maxW) s = this.view.w / this.maxW;
    // p' = (p - c0) * s + c
    g.s = s; g.tx = c[0] - g.c0[0] * s; g.ty = c[1] - g.c0[1] * s;
    this.svg.style.transformOrigin = '0 0';
    this.svg.style.transform = `translate(${g.tx}px,${g.ty}px) scale(${s})`;
  }

  _commit() {
    const g = this.g;
    if (!g || !g.moved || (g.s === 1 && !g.tx && !g.ty)) { this.svg.style.transform = ''; return; }
    const k = this.k;
    const v = this.view;
    const nx = v.x + (-g.tx / g.s) * k;
    const ny = v.y + (-g.ty / g.s) * k;
    this.view = { x: nx, y: ny, w: v.w / g.s, h: 0 };
    this.svg.style.transform = '';
    g.s = 1; g.tx = 0; g.ty = 0;
    this._apply();
    this._startGesture();
  }

  _tap(px, py, type) {
    const now = performance.now();
    const k = this.k;
    const sx = this.view.x + px * k, sy = this.view.y + py * k;
    const [mx, my] = this.s2m(sx, sy);
    const dbl = now - this.lastTap < 300 && Math.hypot(px - this._lastTapPos[0], py - this._lastTapPos[1]) < 30;
    this.lastTap = now; this._lastTapPos = [px, py];
    if (dbl) { clearTimeout(this._tapT); this.zoomAt(px, py, 2); return; }
    const tol = (type === 'mouse' ? 6 : 14) * k;
    clearTimeout(this._tapT);
    const r = this.host.getBoundingClientRect();
    const client = { cx: r.left + px, cy: r.top + py, type };
    this._tapT = setTimeout(() => this.onTap && this.onTap(mx, my, tol, client), type === 'mouse' ? 0 : 220);
  }

  clearOverlay() { this.ov.replaceChildren(); this.base.classList.remove('dim'); }
}
