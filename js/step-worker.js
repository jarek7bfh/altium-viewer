// Web Worker: STEP (zlib-compressed, as embedded in PcbDoc) -> compact triangle mesh.
// Uses OpenCascade (occt-import-js, WebAssembly). Runs off the main thread.
const VENDOR = new URL('../vendor/', self.location.href).href;
importScripts(VENDOR + 'occt-import-js.js');

let occtP = null;
const PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.002, angularDeflection: 0.5 };

async function inflate(u8) {
  // Altium stores models zlib-wrapped -> 'deflate' in the Compression Streams API
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

function pack(result) {
  let nv = 0, ni = 0;
  for (const m of result.meshes) { nv += m.attributes.position.array.length / 3; ni += m.index.array.length; }
  const pos = new Float32Array(nv * 3);
  const col = new Uint8Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const m of result.meshes) {
    const p = m.attributes.position.array, ix = m.index.array;
    const n = p.length / 3;
    pos.set(p, vo * 3);
    const base = m.color || [0.75, 0.75, 0.75];
    const c = [base[0] * 255, base[1] * 255, base[2] * 255];
    for (let i = 0; i < n; i++) { col[(vo + i) * 3] = c[0]; col[(vo + i) * 3 + 1] = c[1]; col[(vo + i) * 3 + 2] = c[2]; }
    // per-face colours (brep faces) override the mesh colour
    if (m.brep_faces) for (const f of m.brep_faces) {
      if (!f.color) continue;
      const fc = [f.color[0] * 255, f.color[1] * 255, f.color[2] * 255];
      for (let t = f.first; t <= f.last; t++) for (let k = 0; k < 3; k++) {
        const v = ix[t * 3 + k] + vo;
        col[v * 3] = fc[0]; col[v * 3 + 1] = fc[1]; col[v * 3 + 2] = fc[2];
      }
    }
    for (let i = 0; i < ix.length; i++) idx[io + i] = ix[i] + vo;
    vo += n; io += ix.length;
  }
  return { pos, col, idx };
}

onmessage = async (ev) => {
  const { id, data } = ev.data;
  try {
    if (!occtP) occtP = occtimportjs({ locateFile: (f) => VENDOR + f });
    const occt = await occtP;
    const raw = await inflate(data);
    const r = occt.ReadStepFile(raw, PARAMS);
    if (!r || !r.success || !r.meshes.length) throw new Error('nie udało się odczytać STEP');
    const mesh = pack(r);
    postMessage({ id, ok: true, mesh }, [mesh.pos.buffer, mesh.col.buffer, mesh.idx.buffer]);
  } catch (e) {
    postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
