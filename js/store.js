// Local project storage (IndexedDB) + import filtering
import { SCH_STREAMS, parseSch } from './schparse.js';
import { PCB_STREAMS, parsePcb } from './pcbparse.js';

const DB_NAME = 'altium-viewer';
const DB_VER = 1;
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('projects', mode);
    const st = t.objectStore('projects');
    let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function listProjects() {
  const all = await tx('readonly', (st) => req(st.getAll()));
  return all.sort((a, b) => b.updated - a.updated);
}
export const getProject = (id) => tx('readonly', (st) => req(st.get(id)));
export const putProject = (p) => tx('readwrite', (st) => req(st.put(p)));
export const deleteProject = (id) => tx('readwrite', (st) => req(st.delete(id)));
export const deleteAllProjects = () => tx('readwrite', (st) => req(st.clear()));

export function projectSize(p) {
  let n = 0;
  for (const f of Object.values(p.files || {})) for (const s of Object.values(f.streams || {})) n += s.byteLength;
  return n + (p.prjText ? p.prjText.length : 0);
}

// ---------------- import ----------------

const EXCL_DIR = /^(history|project outputs.*|project logs.*|__previews|previews|\.git|backup.*)$/i;
const kindOf = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const e = m ? m[1].toLowerCase() : '';
  return e === 'prjpcb' ? 'prj' : e === 'schdoc' ? 'sch' : e === 'pcbdoc' ? 'pcb' : null;
};
const base = (p) => p.split(/[\\/]/).pop();

export function parsePrj(text) {
  const docs = [];
  let sec = '';
  for (const line of text.split(/\r?\n/)) {
    const s = /^\[(.+)\]\s*$/.exec(line);
    if (s) { sec = s[1]; continue; }
    if (/^Document\d+$/i.test(sec)) {
      const m = /^DocumentPath=(.*)$/i.exec(line);
      if (m) {
        const path = m[1].trim();
        const name = base(path);
        const k = kindOf(name);
        if (k === 'sch' || k === 'pcb') docs.push({ name, kind: k, path });
      }
    }
  }
  return docs;
}

/** Classify picked files; returns {prj, docs:[File], skipped:[{name, why}]} */
export function classify(fileList) {
  const skipped = [];
  const prjs = [];
  const docs = [];
  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    const parts = rel.split(/[\\/]/);
    const name = parts[parts.length - 1];
    if (parts.slice(0, -1).some((d) => EXCL_DIR.test(d))) { skipped.push({ name: rel, why: 'historia / wyjścia produkcyjne' }); continue; }
    if (/^~\$|^\.~|\.(bak|tmp|\$\$\$)$|^~/i.test(name)) { skipped.push({ name: rel, why: 'plik tymczasowy' }); continue; }
    const k = kindOf(name);
    if (!k) { skipped.push({ name: rel, why: 'nieobsługiwany typ' }); continue; }
    if (k === 'prj') prjs.push(f); else docs.push(f);
  }
  return { prjs, docs, skipped };
}

function extractStreams(buf, kind) {
  const cf = window.CFB.read(new Uint8Array(buf), { type: 'array' });
  const wanted = kind === 'sch' ? SCH_STREAMS : PCB_STREAMS;
  const streams = {};
  for (const p of wanted) {
    const e = window.CFB.find(cf, 'Root Entry/' + p) || window.CFB.find(cf, p);
    if (p === 'ShapeBasedRegions6/Data' && streams['Regions6/Data']) continue; // duplicate geometry
    if (e && e.content && e.content.length) streams[p] = new Uint8Array(e.content).slice();
  }
  const get = (p) => streams[p] || null;
  // validate
  if (kind === 'sch') {
    if (!streams.FileHeader) throw new Error('brak strumienia FileHeader – to nie wygląda na schemat Altium');
    const s = parseSch(get);
    return { streams, info: { components: s.components.length } };
  }
  if (!streams['Board6/Data']) throw new Error('brak danych płytki – to nie wygląda na PCB Altium');
  const p = parsePcb(get);
  return { streams, info: { components: p.components.length, nets: p.nets.length } };
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now() + Math.random().toString(36).slice(2));

/**
 * Build/merge a project from picked files.
 * @param {FileList|File[]} files
 * @param {object|null} target existing project to update (or null -> auto match)
 * @param {Array} existing all existing projects (for auto-match)
 */
export async function importFiles(files, target, existing) {
  const { prjs, docs, skipped } = classify([...files]);
  if (prjs.length > 1) for (const p of prjs.slice(1)) skipped.push({ name: p.name, why: 'wybierz jeden projekt naraz' });
  const prjFile = prjs[0] || null;
  let prjText = null, prjDocs = null;
  if (prjFile) { prjText = await prjFile.text(); prjDocs = parsePrj(prjText); }

  // decide target project
  let proj = target || null;
  if (!proj && prjFile) proj = existing.find((p) => p.prjName && p.prjName.toLowerCase() === prjFile.name.toLowerCase()) || null;
  if (!proj && !prjFile && docs.length) {
    const names = docs.map((d) => d.name.toLowerCase());
    proj = existing.find((p) => names.every((n) => p.files[n] || (p.docs || []).some((d) => d.name.toLowerCase() === n))) || null;
  }
  const isUpdate = !!proj;
  if (!proj) {
    const nm = prjFile ? prjFile.name.replace(/\.prjpcb$/i, '') : (docs[0]?.name || 'Projekt').replace(/\.(schdoc|pcbdoc)$/i, '');
    proj = { id: uuid(), kind: prjFile ? 'project' : 'single', name: nm, prjName: prjFile ? prjFile.name : null, docs: null, files: {}, prjText: null, created: Date.now(), updated: Date.now() };
  } else {
    proj = { ...proj, files: { ...proj.files } };
  }
  if (prjFile) { proj.prjText = prjText; proj.docs = prjDocs; proj.prjName = prjFile.name; }

  // keep only docs referenced by the project (if we know them)
  const allowed = proj.docs ? new Set(proj.docs.map((d) => d.name.toLowerCase())) : null;
  const chosen = new Map();
  for (const f of docs) {
    const key = f.name.toLowerCase();
    if (allowed && !allowed.has(key)) { skipped.push({ name: f.webkitRelativePath || f.name, why: 'nie należy do projektu' }); continue; }
    const prev = chosen.get(key);
    if (prev) { // duplicate name: keep newest
      if ((f.lastModified || 0) > (prev.lastModified || 0)) { skipped.push({ name: prev.name, why: 'starsza kopia' }); chosen.set(key, f); }
      else skipped.push({ name: f.name, why: 'starsza kopia' });
    } else chosen.set(key, f);
  }
  const imported = [];
  const errors = [];
  for (const [key, f] of chosen) {
    const kind = kindOf(f.name);
    try {
      const { streams, info } = extractStreams(await f.arrayBuffer(), kind);
      proj.files[key] = { name: f.name, kind, origSize: f.size, lastModified: f.lastModified || Date.now(), streams, info, imported: Date.now() };
      imported.push(f.name);
    } catch (e) {
      errors.push({ name: f.name, why: String(e.message || e) });
    }
  }
  // drop stored files no longer referenced by project
  if (allowed) for (const k of Object.keys(proj.files)) if (!allowed.has(k)) delete proj.files[k];
  proj.updated = Date.now();
  return { proj, imported, skipped, errors, isUpdate, prjOnly: !!prjFile && !chosen.size, picked: [...files].map((f) => f.name), hasContent: Object.keys(proj.files).length > 0 };
}

async function readDoc(f, kind) {
  const { streams, info } = extractStreams(await f.arrayBuffer(), kind);
  return { name: f.name, kind, origSize: f.size, lastModified: f.lastModified || Date.now(), streams, info, imported: Date.now() };
}

// ---------------- folder browsing ----------------
const isTemp = (name) => /^~\$|^\.~|\.(bak|tmp|\$\$\$)$|^~/i.test(name);
const normPath = (p) => {
  const out = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg.toLowerCase());
  }
  return out.join('/');
};

/** Scan files from a folder pick: only .PrjPcb/.SchDoc/.PcbDoc outside history/outputs folders. */
export function scanFolder(fileList) {
  const seen = new Set();
  const entries = [];
  let root = '';
  let ignored = 0;
  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    const parts = rel.split(/[\\/]/);
    if (!root && parts.length > 1) root = parts[0];
    const name = parts[parts.length - 1];
    const k = kindOf(name);
    if (!k || isTemp(name)) { ignored++; continue; }
    if (parts.slice(1, -1).some((d) => EXCL_DIR.test(d))) { ignored++; continue; }
    const key = normPath(rel);
    if (seen.has(key)) continue; // provider may list items twice
    seen.add(key);
    entries.push({ file: f, rel, key, dir: parts.slice(0, -1).join('/'), sub: parts.slice(1, -1).join('/'), name, kind: k, size: f.size, mtime: f.lastModified || 0 });
  }
  const by = (k) => entries.filter((e) => e.kind === k).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  return { root: root || 'Folder', prjs: by('prj'), schs: by('sch'), pcbs: by('pcb'), entries, total: fileList.length, ignored };
}

/** Find files referenced by a project inside the scanned folder. */
export async function resolveProject(prjEntry, scan) {
  const text = await prjEntry.file.text();
  const docs = parsePrj(text);
  const docsInScan = scan.entries.filter((e) => e.kind !== 'prj');
  const prjDir = prjEntry.dir;
  for (const d of docs) {
    const want = normPath(prjDir + '/' + d.path);
    let hit = docsInScan.find((e) => e.key === want);
    if (!hit) hit = docsInScan.find((e) => e.dir === prjDir && e.name.toLowerCase() === d.name.toLowerCase());
    if (!hit) hit = docsInScan.filter((e) => e.name.toLowerCase() === d.name.toLowerCase()).sort((a, b) => a.key.split('/').length - b.key.split('/').length)[0];
    d.entry = hit || null;
  }
  return { text, docs };
}

/** Import a project picked from a folder: reads only the documents listed in .PrjPcb */
export async function importProjectFromFolder(prjEntry, scan, existing, onProgress) {
  const { text, docs } = await resolveProject(prjEntry, scan);
  let proj = existing.find((p) => p.prjName && p.prjName.toLowerCase() === prjEntry.name.toLowerCase());
  const isUpdate = !!proj;
  proj = proj ? { ...proj, files: {} } : { id: uuid(), created: Date.now(), files: {} };
  Object.assign(proj, { kind: 'project', name: prjEntry.name.replace(/\.prjpcb$/i, ''), prjName: prjEntry.name, prjText: text, docs: docs.map(({ name, kind, path }) => ({ name, kind, path })), updated: Date.now() });
  const imported = [], errors = [], missing = [];
  let i = 0;
  for (const d of docs) {
    i++;
    if (!d.entry) { missing.push(d.name); continue; }
    onProgress && onProgress(`${d.name} (${i}/${docs.length})`);
    try { proj.files[d.name.toLowerCase()] = await readDoc(d.entry.file, d.kind); imported.push(d.name); }
    catch (e) { errors.push({ name: d.name, why: String(e.message || e) }); }
  }
  return { proj, imported, errors, missing, isUpdate, hasContent: imported.length > 0 };
}

/** Unsaved preview of loose documents */
export async function buildPreview(files, onProgress) {
  const proj = { id: null, kind: 'single', temp: true, name: '', docs: null, prjName: null, files: {}, created: Date.now(), updated: Date.now() };
  const errors = [];
  for (const f of files) {
    const k = kindOf(f.name);
    if (k !== 'sch' && k !== 'pcb') continue;
    onProgress && onProgress(f.name);
    try { proj.files[f.name.toLowerCase()] = await readDoc(f, k); } catch (e) { errors.push({ name: f.name, why: String(e.message || e) }); }
  }
  const names = Object.values(proj.files).map((f) => f.name);
  proj.name = names.length === 1 ? names[0] : names.map((n) => n.replace(/\.(schdoc|pcbdoc)$/i, '')).join(' + ');
  return { proj, errors };
}
export function newId() { return uuid(); }

export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { /* ignore */ }
}

export { kindOf };
