import { parseSch } from './schparse.js';
import { parsePcb, layerName } from './pcbparse.js';
import { linkProject } from './netlink.js';
import { renderSch } from './schrender.js';
import { renderPcb, PCB_LAYERS } from './pcbrender.js';
import { Pane } from './pane.js';
import { hitSch, hitPcb } from './hit.js';
import { listProjects, getProject, putProject, deleteProject, deleteAllProjects, projectSize, importFiles, requestPersist, scanFolder, resolveProject, importProjectFromFolder, buildPreview, newId } from './store.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' kB' : (n / 1048576).toFixed(1).replace('.', ',') + ' MB');
const fmtDate = (t) => new Date(t).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const LS = {
  get(k, d) { try { const v = localStorage.getItem('av.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('av.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};
const NS = 'http://www.w3.org/2000/svg';
export const APP_VERSION = '9';

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function message(title, html) {
  $('#m-title').textContent = title; $('#m-body').innerHTML = html;
  const d = $('#dlg-msg'); d.showModal();
  return new Promise((res) => { $('#m-ok').onclick = () => { d.close(); res(); }; });
}

// ============================ HOME ============================
let projects = [];
let pickTarget = null;

// Android back button: from any sub-screen it goes straight to the project list
function markSub() { try { if (!(history.state && history.state.sub)) history.pushState({ sub: 1 }, ''); } catch (e) { /* ignore */ } }
function goHome() { closePops(); try { if (history.state && history.state.sub) { history.back(); return; } } catch (e) { /* ignore */ } showHome(); }
window.addEventListener('popstate', () => { closePops(); if ($('#home').classList.contains('hidden')) showHome(); });

async function showHome() {
  $('#viewer').classList.add('hidden');
  $('#browse').classList.add('hidden');
  $('#home').classList.remove('hidden');
  projects = await listProjects();
  const list = $('#plist');
  list.innerHTML = '';
  let total = 0;
  for (const p of projects) {
    const size = projectSize(p); total += size;
    const names = new Set(Object.keys(p.files));
    const docs = p.docs || Object.values(p.files).map((f) => ({ name: f.name, kind: f.kind }));
    const chips = docs.map((d) => {
      const f = p.files[d.name.toLowerCase()];
      return f ? `<span class="fchip">${esc(f.name)}<i>${fmtDate(f.lastModified).split(',')[0]}${f.meshes ? ' · 3D' : Object.keys(f.streams || {}).some((k) => /^Models\/\d+$/.test(k)) ? ' · STEP' : ''}</i></span>` : `<span class="fchip miss" title="Nie wczytano">${esc(d.name)}</span>`;
    }).join('');
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <button class="open"><h3>${esc(p.name)}</h3><div class="meta">${p.prjName ? '' : 'Pojedyncze pliki · '}${names.size} ${names.size === 1 ? 'dokument' : names.size >= 2 && names.size <= 4 ? 'dokumenty' : 'dokumentów'} · ${fmtSize(size)} · zaktualizowano ${fmtDate(p.updated)}</div></button>
      <div class="cact">
        <button class="ib upd" title="Aktualizuj z plików" aria-label="Aktualizuj"><svg><use href="#i-refresh"/></svg></button>
        <button class="ib del" title="Usuń z tabletu" aria-label="Usuń"><svg><use href="#i-trash"/></svg></button>
      </div>
      <div class="files">${chips}</div>`;
    $('.open', el).onclick = () => openProject(p.id);
    $('.upd', el).onclick = () => { pickTarget = p; if (p.kind !== 'single' && p.prjName && DIR_OK) pickDir(); else $('#picker').click(); };
    $('.del', el).onclick = () => confirmDelete(`Usunąć projekt z tabletu?`, `„${p.name}” (${fmtSize(size)}) zostanie usunięty z pamięci tego tabletu. Pliki w Nextcloudzie pozostaną bez zmian.`, async () => { await deleteProject(p.id); toast('Usunięto „' + p.name + '”'); showHome(); });
    list.append(el);
  }
  $('#empty').classList.toggle('hidden', projects.length > 0);
  $('#del-all').classList.toggle('hidden', projects.length < 2);
  $('#usage').textContent = projects.length ? `Na tablecie: ${fmtSize(total)} w ${projects.length} ${projects.length === 1 ? 'projekcie' : 'projektach'}` : '';
}

function confirmDelete(title, text, action) {
  const d = $('#dlg-delete');
  $('#d-title').textContent = title; $('#d-text').textContent = text;
  const hold = $('#d-hold');
  let timer = null;
  const reset = () => { clearTimeout(timer); hold.classList.remove('go'); };
  hold.onpointerdown = (e) => {
    e.preventDefault(); hold.setPointerCapture(e.pointerId);
    hold.classList.add('go');
    timer = setTimeout(async () => { reset(); d.close(); await action(); }, 1200);
  };
  hold.onpointerup = hold.onpointercancel = hold.onpointerleave = reset;
  hold.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); };
  hold.oncontextmenu = (e) => e.preventDefault();
  $('#d-cancel').onclick = () => { reset(); d.close(); };
  d.showModal();
}

const DIR_OK = 'webkitdirectory' in document.createElement('input') && !/iPhone|iPad/.test(navigator.userAgent);
if (!DIR_OK) { $('#add-dir').classList.add('hidden'); $('#hint-dir').classList.add('hidden'); $('#hint-files').classList.remove('hidden'); $('#add').classList.add('primary'); }
$('#add').onclick = () => { pickTarget = null; $('#picker').click(); };

let wdTimer = null;
// The waiting screen is shown BEFORE the system picker opens, so it is already there when Android returns
// to the page while it is still listing the folder. 'change' or 'cancel' hides it.
function pickDir() {
  const w = $('#waitdir');
  clearInterval(wdTimer);
  const t1 = Date.now();
  $('#wd-sec').textContent = '0'; w.classList.remove('hidden');
  wdTimer = setInterval(() => { $('#wd-sec').textContent = Math.round((Date.now() - t1) / 1000); }, 500);
  $('#picker-dir').click();
}
function hideWait() { clearInterval(wdTimer); $('#waitdir').classList.add('hidden'); }
$('#wd-cancel').onclick = hideWait;
$('#picker-dir').addEventListener('cancel', hideWait);
$('#add-dir').onclick = () => { pickTarget = null; pickDir(); };
$('#picker-dir').onchange = async (e) => {
  hideWait();
  const files = [...e.target.files];
  e.target.value = '';
  const target = pickTarget; pickTarget = null;
  if (files.length) await openFolder(files, target);
};

function setLoading(on, text = 'Wczytywanie…', host = document.body) {
  const ld = $('#loading');
  if (on) { host.append(ld); $('#ld-text').textContent = text; ld.classList.remove('hidden'); }
  else ld.classList.add('hidden');
}

// ---------------- folder browser ----------------
let SCAN = null;
async function openFolder(files, target) {
  SCAN = scanFolder(files);
  // update of an existing project: re-import its .PrjPcb directly
  if (target && target.prjName) {
    const pe = SCAN.prjs.find((e) => e.name.toLowerCase() === target.prjName.toLowerCase());
    if (pe) { await importFromFolder(pe); return; }
    toast(`W tym folderze nie ma pliku ${target.prjName}`, 4000);
  }
  showBrowse();
}

const icon = (k) => `<svg class="bi"><use href="#${k === 'prj' ? 'i-folder' : k === 'sch' ? 'i-net' : 'i-chip'}"/></svg>`;
async function showBrowse() {
  $('#home').classList.add('hidden'); $('#viewer').classList.add('hidden'); $('#browse').classList.remove('hidden');
  markSub();
  $('#b-name').textContent = SCAN.root;
  const L = $('#b-list');
  const row = (e, extra = '', meta = '') => `<button class="brow ${e.kind}" data-key="${esc(e.key)}">${icon(e.kind)}<span class="bn">${esc(e.name)}</span><span class="bx">${fmtSize(e.size)}<br>${fmtDate(e.mtime).split(',')[0]}</span><span class="bm">${meta || (e.sub ? esc(e.sub) : '&nbsp;')}</span>${extra}</button>`;
  if (!SCAN.prjs.length && !SCAN.schs.length && !SCAN.pcbs.length) {
    L.innerHTML = `<div class="bempty"><p>W tym folderze nie ma plików .PrjPcb, .SchDoc ani .PcbDoc.</p><p class="small">Foldery History, Project Outputs, Project Logs i __Previews są pomijane.</p></div>`;
    return;
  }
  let html = SCAN.ignored ? `<p class="bsum">Pominięto ${SCAN.ignored} z ${SCAN.total} plików (historia, wyjścia produkcyjne, podglądy, inne typy). Aplikacja ich nie czyta.</p>` : '';
  if (SCAN.prjs.length) html += `<div class="bsec">Projekty <i>– wczytuje tylko pliki z projektu</i></div>` + SCAN.prjs.map((e) => row(e, `<span class="docs" data-docs="${esc(e.key)}"><span class="tag">sprawdzam pliki…</span></span>`)).join('');
  if (SCAN.schs.length) html += `<div class="bsec">Schematy <i>– podgląd pojedynczego pliku</i></div>` + SCAN.schs.map((e) => row(e)).join('');
  if (SCAN.pcbs.length) html += `<div class="bsec">Płytki PCB <i>– podgląd pojedynczego pliku</i></div>` + SCAN.pcbs.map((e) => row(e)).join('');
  L.innerHTML = html;
  L.scrollTop = 0;
  const byKey = new Map(SCAN.entries.map((e) => [e.key, e]));
  $$('.brow', L).forEach((b) => (b.onclick = () => {
    const e = byKey.get(b.dataset.key);
    if (e.kind === 'prj') importFromFolder(e); else previewFiles([e.file]);
  }));
  // resolve projects (reads only the small .PrjPcb files)
  const used = new Map();
  for (const e of SCAN.prjs) {
    const box = L.querySelector(`[data-docs="${CSS.escape(e.key)}"]`);
    try {
      const { docs } = await resolveProject(e, SCAN);
      const found = docs.filter((d) => d.entry).length;
      for (const d of docs) if (d.entry) used.set(d.entry.key, (used.get(d.entry.key) || []).concat(e.name.replace(/\.prjpcb$/i, '')));
      if (box) box.innerHTML = `<span class="${found === docs.length ? 'ok' : 'bad'}">${found}/${docs.length}</span>` + docs.map((d) => `<span class="tag${d.entry ? ' cur' : ''}" title="${d.entry ? esc(d.entry.rel) : 'brak w folderze'}">${esc(d.name)}</span>`).join('');
    } catch (err) { if (box) box.innerHTML = '<span class="bad">nie udało się odczytać projektu</span>'; }
  }
  // mark docs used by projects
  for (const [key, prjNames] of used) {
    const b = L.querySelector(`.brow[data-key="${CSS.escape(key)}"] .bm`);
    if (b) b.innerHTML = `<span class="ok">w projekcie ${esc(prjNames.join(', '))}</span>${byKey.get(key).sub ? ' · ' + esc(byKey.get(key).sub) : ''}`;
  }
}
$('#b-back').onclick = () => goHome();
$('#b-repick').onclick = () => { pickTarget = null; pickDir(); };

async function importFromFolder(prjEntry) {
  setLoading(true, 'Wczytywanie projektu…');
  let r;
  try { r = await importProjectFromFolder(prjEntry, SCAN, projects, (t) => { $('#ld-text').textContent = 'Wczytywanie ' + t; }); }
  catch (e) { setLoading(false); await message('Nie udało się wczytać', `<p>${esc(e.message || e)}</p>`); return; }
  setLoading(false);
  if (r.hasContent) {
    await putProject(r.proj); requestPersist(); projects = await listProjects();
    setLoading(true, 'Przygotowuję modele 3D…');
    await ensureModels(r.proj, (t) => { $('#ld-text').textContent = t; });
    setLoading(false);
  }
  if (!r.hasContent) {
    let html = '';
    if (r.missing.length) html += `<p>Projekt wymienia pliki, których nie ma w tym folderze:</p><ul>${r.missing.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
    if (r.errors.length) html += `<p>Błędy odczytu:</p><ul>${r.errors.map((e) => `<li>${esc(e.name)} – ${esc(e.why)}</li>`).join('')}</ul>`;
    await message('Nic nie wczytano', html || '<p>Projekt nie zawiera schematów ani płytek.</p>');
    return;
  }
  let t = `${r.isUpdate ? 'Zaktualizowano' : 'Zapisano'} „${r.proj.name}” (${r.imported.length} ${r.imported.length === 1 ? 'plik' : r.imported.length < 5 ? 'pliki' : 'plików'})`;
  if (r.missing.length) t += ` · brak w folderze: ${r.missing.join(', ')}`;
  if (r.errors.length) t += ` · błąd odczytu: ${r.errors.map((e) => e.name).join(', ')}`;
  toast(t, r.missing.length || r.errors.length ? 6000 : 3000);
  await openProj(r.proj);
}

async function previewFiles(files) {
  setLoading(true, 'Wczytywanie…');
  let r;
  try { r = await buildPreview(files); } catch (e) { r = { proj: { files: {} }, errors: [{ name: '', why: String(e.message || e) }] }; }
  if (Object.keys(r.proj.files).length) await ensureModels(r.proj, (t) => { $('#ld-text').textContent = t; });
  setLoading(false);
  if (!Object.keys(r.proj.files).length) { await message('Nie udało się otworzyć', `<ul>${r.errors.map((e) => `<li>${esc(e.name)} ${esc(e.why)}</li>`).join('')}</ul>`); return; }
  if (r.errors.length) toast('Nie udało się odczytać: ' + r.errors.map((e) => e.name).join(', '), 5000);
  await openProj(r.proj);
}
$('#del-all').onclick = () => confirmDelete('Usunąć wszystkie projekty?', `Wszystkie projekty (${projects.length}) zostaną usunięte z pamięci tego tabletu. Pliki w Nextcloudzie pozostaną bez zmian.`, async () => { await deleteAllProjects(); toast('Usunięto wszystkie projekty'); showHome(); });
$('#picker').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const target = pickTarget; pickTarget = null;
  if (!files.length) return;
  const hasPrj = files.some((f) => /\.prjpcb$/i.test(f.name));
  if (!hasPrj && target && !target.prjName) { // update single-file entry
    setLoading(true);
    const r = await buildPreview(files);
    setLoading(false);
    if (Object.keys(r.proj.files).length) { const np = { ...target, files: r.proj.files, updated: Date.now() }; await putProject(np); setLoading(true, 'Przygotowuję modele 3D…'); await ensureModels(np, (t) => { $('#ld-text').textContent = t; }); setLoading(false); toast('Zaktualizowano „' + target.name + '”'); showHome(); }
    else await message('Nic nie wczytano', '<p>Wybierz plik .SchDoc lub .PcbDoc.</p>');
    return;
  }
  if (!hasPrj && !target) {
    if (files.some((f) => /\.(schdoc|pcbdoc)$/i.test(f.name))) { await previewFiles(files); return; }
  }
  await doImport(files, target);
};

async function doImport(files, target) {
  const ld = $('#loading'); $('#viewer').classList.add('hidden'); $('#home').classList.remove('hidden');
  document.body.append(ld); ld.classList.remove('hidden');
  let r;
  try { r = await importFiles(files, target, projects); }
  catch (e) { ld.classList.add('hidden'); await message('Nie udało się wczytać', `<p>${esc(e.message || e)}</p>`); return; }
  ld.classList.add('hidden');
  if ((r.hasContent && (r.imported.length || r.isUpdate)) || r.prjOnly) {
    await putProject(r.proj);
    requestPersist();
    if (r.hasContent) { ld.classList.remove('hidden'); $('#ld-text').textContent = 'Przygotowuję modele 3D…'; await ensureModels(r.proj, (t) => { $('#ld-text').textContent = t; }); ld.classList.add('hidden'); }
  }
  const TIP = '<p class="small">Wskazówka: w oknie wyboru plików <b>przytrzymaj</b> pierwszy plik – wtedy możesz zaznaczyć kilka naraz i zatwierdzić przyciskiem „Wybierz”.</p>';
  if (r.prjOnly) {
    const miss = (r.proj.docs || []).filter((d) => !r.proj.files[d.name.toLowerCase()]);
    await showHome();
    await message('Brakuje plików projektu', `<p>Zapisano projekt <b>${esc(r.proj.name)}</b>, ale do podglądu potrzebne są jeszcze ${miss.length === 1 ? 'plik' : 'pliki'}:</p><ul>${miss.map((d) => `<li>${esc(d.name)}</li>`).join('')}</ul><p>Stuknij ⟳ przy projekcie i zaznacz je (możesz zaznaczyć też ponownie plik .PrjPcb).</p>${TIP}`);
    return;
  }
  const groups = {};
  for (const s of r.skipped) (groups[s.why] = groups[s.why] || []).push(s.name);
  let html = '';
  if (r.imported.length) html += `<p>${r.isUpdate ? 'Zaktualizowano' : 'Dodano'} projekt <b>${esc(r.proj.name)}</b>:</p><ul>${r.imported.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  else if (!r.errors.length) html += `<p>Wśród wybranych plików nie ma schematu (.SchDoc) ani płytki (.PcbDoc).</p><p class="small">Wybrano: ${r.picked.map(esc).join(', ') || '—'}</p>${TIP}`;
  if (r.errors.length) html += `<p>Błędy:</p><ul>${r.errors.map((e) => `<li>${esc(e.name)} – ${esc(e.why)}</li>`).join('')}</ul>`;
  const sk = Object.entries(groups);
  if (sk.length) html += `<p class="small">Pominięto ${r.skipped.length} ${r.skipped.length === 1 ? 'plik' : 'plików'}: ${sk.map(([why, n]) => `${esc(why)} (${n.length})`).join(', ')}.</p>`;
  if (r.proj.docs) {
    const miss = r.proj.docs.filter((d) => !r.proj.files[d.name.toLowerCase()]);
    if (miss.length && r.hasContent) html += `<p class="small">Projekt odwołuje się też do: ${miss.map((d) => esc(d.name)).join(', ')} – możesz je dodać później przyciskiem aktualizacji.</p>`;
  }
  await showHome();
  await message(r.imported.length ? 'Gotowe' : 'Nic nie wczytano', html);
}

// ============================ VIEWER ============================
const V = {
  proj: null, schs: [], pcbs: [], pcbIdx: 0, si: 0, link: null,
  layout: LS.get('layout', 'both'), mode: LS.get('mode', 'comp'), flip: false,
  vis: Object.fromEntries(PCB_LAYERS.map((l) => [l.id, LS.get('layers', {})[l.id] ?? l.on])),
  sel: null, schPane: null, pcbPane: null, pcbR: null, schR: [],
  is3d: false, v3d: null,
};

function getter(file) { return (p) => file.streams[p] || null; }

async function openProject(id) {
  const proj = await getProject(id);
  if (!proj) return;
  if (!Object.keys(proj.files).length) {
    const miss = (proj.docs || []).map((d) => `<li>${esc(d.name)}</li>`).join('');
    await message('Projekt nie ma jeszcze plików', `<p>Dodaj schemat i płytkę przyciskiem ⟳ przy projekcie.</p>${miss ? `<p>Potrzebne pliki:</p><ul>${miss}</ul>` : ''}<p class="small">W oknie wyboru plików przytrzymaj pierwszy plik, aby zaznaczyć kilka naraz.</p>`);
    return;
  }
  await openProj(proj);
}

async function openProj(proj) {
  $('#home').classList.add('hidden'); $('#browse').classList.add('hidden');
  $('#viewer').classList.remove('hidden');
  markSub();
  $('#v-save').classList.toggle('hidden', !proj.temp);
  $('#v-home').classList.toggle('hidden', !(proj.temp && SCAN));
  const ld = $('#loading'); $('#viewer').append(ld); $('#ld-text').textContent = 'Wczytywanie…'; ld.classList.remove('hidden');
  await new Promise((r) => setTimeout(r, 30));
  V.proj = proj; V.sel = null;
  const order = (proj.docs || []).map((d) => d.name.toLowerCase());
  const files = Object.entries(proj.files).sort((a, b) => {
    const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || natCmp(a[0], b[0]);
  }).map(([, f]) => f);
  V.schs = []; V.pcbs = [];
  const errs = [];
  for (const f of files) {
    try {
      if (f.kind === 'sch') V.schs.push({ name: f.name, data: parseSch(getter(f)) });
      else V.pcbs.push({ name: f.name, data: parsePcb(getter(f)), file: f });
    } catch (e) { console.error(e); errs.push(f.name); }
  }
  // choose pcb: remembered, else the one with most components matching schematic designators
  const desSet = new Set(V.schs.flatMap((s) => s.data.components.map((c) => c.des)));
  const remembered = proj.id ? LS.get('pcb.' + proj.id, null) : null;
  let best = 0, bestScore = -1;
  V.pcbs.forEach((p, i) => {
    let sc = p.data.components.filter((c) => desSet.has(c.des)).length;
    if (p.name === remembered) sc = 1e9;
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  V.pcbIdx = best; V.si = 0;
  $('#v-name').textContent = proj.name;
  const sel = $('#v-pcb');
  sel.classList.toggle('hidden', V.pcbs.length < 2);
  sel.innerHTML = V.pcbs.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  sel.value = String(V.pcbIdx);
  buildViews();
  ld.classList.add('hidden');
  if (errs.length) toast('Nie udało się odczytać: ' + errs.join(', '), 5000);
}

function buildViews() {
  const pcb = V.pcbs[V.pcbIdx]?.data || null;
  V.link = linkProject(V.schs.map((s) => s.data), pcb);
  // schematic pane
  if (!V.schPane) V.schPane = new Pane($('#p-sch .phost'), { bg: 'transparent', onTap: onSchTap, minW: 30, maxW: 20000 });
  if (!V.pcbPane) V.pcbPane = new Pane($('#p-pcb .phost'), { bg: 'transparent', onTap: onPcbTap, minW: 20, maxW: 200000 });
  V.schR = V.schs.map((s, i) => renderSch(s.data, V.link, i));
  $('#p-sch .pempty').classList.toggle('hidden', V.schs.length > 0);
  $('#p-pcb .pempty').classList.toggle('hidden', !!pcb);
  // sheet tabs
  const tabs = $('#sheet-tabs');
  tabs.innerHTML = V.schs.length > 1 ? V.schs.map((s, i) => `<button class="chip" data-si="${i}">${esc(s.name.replace(/\.schdoc$/i, ''))}</button>`).join('') : '';
  $$('button', tabs).forEach((b) => (b.onclick = () => { showSheet(+b.dataset.si, true); applySel(null); }));
  if (V.schs.length) showSheet(Math.min(V.si, V.schs.length - 1), true);
  // pcb
  if (pcb) {
    V.pcbR = renderPcb(pcb);
    drawPcb(true);
  } else { V.pcbR = null; V.pcbPane.base.innerHTML = ''; }
  // issues
  const n = V.link.issues.length;
  $('#v-issues').classList.toggle('hidden', !n);
  $('#v-issues-n').textContent = n || '';
  setLayout(V.schs.length && pcb ? V.layout : V.schs.length ? 'sch' : 'pcb', true);
  setMode(V.mode);
  updateLayersUI();
  buildSearchIndex();
  applySel(null);
  $('#b3d').classList.toggle('hidden', !pcb);
  if (V.is3d && pcb) build3D(); else if (!pcb) set3D(false);
}

function showSheet(si, fit) {
  V.si = si;
  const r = V.schR[si];
  V.schPane.base.innerHTML = r.svg;
  V.schPane.ov.replaceChildren();
  $$('#sheet-tabs .chip').forEach((b) => b.classList.toggle('on', +b.dataset.si === si));
  if (fit) requestAnimationFrame(() => V.schPane.fitModel([r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]], 0.01));
}

const ORDER_TOP = ['outline', 'mech', 'bsilk', 'bpour', 'bcu', 'inner', 'tpour', 'tcu', 'multi', 'via', 'hole', 'keepout', 'tsilk'];
const ORDER_BOT = ['outline', 'mech', 'tsilk', 'tpour', 'tcu', 'inner', 'bpour', 'bcu', 'multi', 'via', 'hole', 'keepout', 'bsilk'];

function drawPcb(fit) {
  const P = V.pcbPane, R = V.pcbR;
  const order = V.flip ? ORDER_BOT : ORDER_TOP;
  P.base.innerHTML = order.map((k) => `<g data-l="${k}">${R.groups[k].join('')}</g>`).join('');
  P.ov.replaceChildren();
  P.setFlip(V.flip);
  P.root.classList.toggle('flip', V.flip);
  applyVis();
  if (fit) requestAnimationFrame(() => P.fitModel(R.bbox, 0.04));
}

function applyVis() {
  const svg = V.pcbPane.svg;
  for (const l of PCB_LAYERS) svg.classList.toggle('hide-' + l.id, !V.vis[l.id]);
}

function setLayout(l, silent) {
  const pcb = !!V.pcbR, sch = V.schs.length > 0;
  if (!pcb) l = 'sch'; if (!sch) l = 'pcb';
  $('#panes').dataset.layout = l;
  $$('#v-layout button').forEach((b) => { b.classList.toggle('on', b.dataset.v === l); b.disabled = !(pcb && sch); });
  $('#v-layers').classList.toggle('hidden', !pcb);
  if (!silent) { V.layout = l; LS.set('layout', l); }
}
function setMode(m) {
  V.mode = m; LS.set('mode', m);
  $$('#v-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
}
$$('#v-layout button').forEach((b) => (b.onclick = () => setLayout(b.dataset.v)));
$$('#v-mode button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
$('#v-back').onclick = () => { closePops(); if (V.proj?.temp && SCAN) showBrowse(); else goHome(); };
$('#v-home').onclick = () => goHome();
$('#v-pcb').onchange = (e) => { V.pcbIdx = +e.target.value; if (V.proj.id) LS.set('pcb.' + V.proj.id, V.pcbs[V.pcbIdx].name); buildViews(); };
$('#v-save').onclick = async () => {
  const p = { ...V.proj, id: newId(), temp: undefined, updated: Date.now() };
  delete p.temp;
  await putProject(p); requestPersist();
  V.proj = p; projects = await listProjects();
  $('#v-save').classList.add('hidden');
  toast('Zapisano „' + p.name + '” na tablecie');
};
$('[data-fit=sch]').onclick = () => { const r = V.schR[V.si]; if (r) V.schPane.fitModel(r.bbox, 0.01); };
$('[data-fit=pcb]').onclick = () => { if (V.is3d && V.v3d) V.v3d.viewAll(false); else if (V.pcbR) V.pcbPane.fitModel(V.pcbR.bbox, 0.04); };
$('#flip').onclick = () => setFlip(!V.flip);
function setFlip(f) {
  V.flip = f;
  $('#flip').classList.toggle('on', f);
  $('#flip span').textContent = f ? 'Bottom' : 'Top';
  drawPcb(false);
  if (V.is3d && V.v3d) V.v3d.setSide(f);
  applySel(V.sel, 'none');
  updateLayersUI();
}

// ---------------- 3D ----------------
let View3DMod = null;
const hasModelStreams = (f) => f && Object.keys(f.streams || {}).some((k) => /^Models\/\d+$/.test(k));
function curPcb() { return V.pcbs[V.pcbIdx] || null; }
function msg3d(text) { const m = $('#p-pcb .v3dmsg'); if (text == null) m.classList.add('hidden'); else { $('span', m).textContent = text; m.classList.remove('hidden'); } }
async function set3D(on) {
  V.is3d = on;
  $('#b3d').classList.toggle('on', on);
  $('#p-pcb').classList.toggle('mode3d', on);
  if (on) await build3D();
}
async function build3D() {
  const e = curPcb(); if (!e) return;
  try {
    // models saved but not converted yet (e.g. conversion could not run during import) -> convert now
    if (hasModelStreams(e.file)) {
      const r = await convertModels(e.file, e.data, (i, n) => msg3d(`Przygotowuję modele 3D: ${i}/${n}`));
      if (r && !V.proj.temp && V.proj.id) { try { await putProject(V.proj); } catch (err) { console.warn(err); } }
    }
    msg3d('Budowanie widoku 3D…');
    if (!View3DMod) View3DMod = await import('./view3d.js');
    if (!V.v3d) V.v3d = new View3DMod.View3D($('#p-pcb .v3dhost'), { onPick: on3DPick });
    const meshes = e.file && e.file.meshes ? new Map(Object.entries(e.file.meshes)) : null;
    await V.v3d.build(e.data, V.pcbR.groups, meshes, true);
    if (V.flip) V.v3d.setSide(true);
    sync3D(false);
  } catch (err) {
    console.error(err);
    toast('Nie udało się zbudować widoku 3D: ' + (err.message || err), 6000);
  } finally { msg3d(null); }
}
function on3DPick(ci) {
  const pcb = curPcb()?.data; if (!pcb) return;
  closePops();
  if (ci == null || ci < 0) applySel(null, '3d'); else applySel({ type: 'comp', des: pcb.components[ci].des }, '3d');
}
function sync3D(focus) {
  if (!V.is3d || !V.v3d) return;
  const ci = V.sel && V.sel.type === 'comp' ? V.link.pcbCompByDes.get(V.sel.des) : null;
  V.v3d.select(ci == null ? null : ci, focus);
}

/** Convert the STEP models embedded in one PCB file to meshes (in place). null = nothing done / not possible here. */
async function convertModels(f, pcbData, progress) {
  if (!hasModelStreams(f)) return null;
  const ids = [...new Set(pcbData.bodies.filter((b) => b.type === 1 && b.modelId).map((b) => b.modelId))];
  const byId = new Map(pcbData.models.map((m) => [m.id, m]));
  const jobs = ids.map((id) => ({ id, m: byId.get(id) })).filter((j) => j.m && f.streams['Models/' + j.m.index]);
  const dropRaw = () => { for (const k of Object.keys(f.streams)) if (/^Models\/\d+$/.test(k)) delete f.streams[k]; };
  if (!jobs.length) { dropRaw(); return null; }
  let worker;
  try { worker = new Worker(new URL('js/step-worker.js', document.baseURI)); } catch (err) { return null; }
  const meshes = {}; let fails = 0;
  try {
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      progress && progress(i + 1, jobs.length, j.m.name);
      const res = await new Promise((resolve) => {
        const to = setTimeout(() => resolve({ ok: false, error: 'przekroczony czas' }), i === 0 ? 120000 : 60000);
        worker.onmessage = (ev) => { clearTimeout(to); resolve(ev.data); };
        worker.onerror = (ev) => { clearTimeout(to); resolve({ ok: false, error: ev.message || 'błąd workera', fatal: true }); };
        worker.postMessage({ id: j.id, data: f.streams['Models/' + j.m.index] });
      });
      if (res.ok) meshes[j.id] = res.mesh;
      else { fails++; console.warn('STEP', j.m.name, res.error); if (i === 0 && (res.fatal || /fetch|wasm|WebAssembly|importScripts|Failed/i.test(res.error || ''))) throw new Error(res.error); }
    }
  } catch (err) { worker.terminate(); console.warn('STEP conversion unavailable:', err); return null; }
  worker.terminate();
  if (!Object.keys(meshes).length) return null;
  f.meshes = { ...(f.meshes || {}), ...meshes };
  dropRaw(); // raw STEP no longer needed – only the meshes are kept
  return { done: Object.keys(meshes).length, fails };
}
/** Convert models of all PCB files of a project; saves the project when it is stored on the tablet */
async function ensureModels(proj, onText) {
  let changed = false;
  for (const f of Object.values(proj.files || {})) {
    if (f.kind !== 'pcb' || !hasModelStreams(f)) continue;
    let data; try { data = parsePcb(getter(f)); } catch (e) { continue; }
    const r = await convertModels(f, data, (i, n) => onText && onText(`Przygotowuję modele 3D: ${i}/${n}`));
    if (r) changed = true;
  }
  if (changed && !proj.temp && proj.id) { try { await putProject(proj); projects = await listProjects(); } catch (e) { console.warn(e); } }
}
$('#b3d').onclick = () => set3D(!V.is3d);

// ---------------- selection ----------------
// sel: {type:'comp', des} | {type:'net', sch:Set<int>, pcb:int}
function schNetSel(id) { const n = V.link.nets[id]; return { type: 'net', sch: new Set(id >= 0 ? [id] : []), pcb: n ? n.pcb : -1 }; }
function pcbNetSel(pn) { return { type: 'net', sch: new Set(V.link.pcbNetToSch[pn] || []), pcb: pn }; }

function onSchTap(x, y, tol) {
  closePops();
  const s = V.schs[V.si]; if (!s) return;
  const h = hitSch(s.data, V.link, V.si, x, y, tol, V.mode);
  if (h.comp >= 0) applySel({ type: 'comp', des: s.data.components[h.comp].des }, 'sch');
  else if (h.net >= 0) applySel(schNetSel(h.net), 'sch');
  else applySel(null, 'sch');
}
function onPcbTap(x, y, tol) {
  closePops();
  const pcb = V.pcbs[V.pcbIdx]?.data; if (!pcb) return;
  const h = hitPcb(pcb, V.vis, V.flip, V.pcbR.compBox, x, y, tol, V.mode);
  if (h.comp >= 0) applySel({ type: 'comp', des: pcb.components[h.comp].des }, 'pcb');
  else if (h.net >= 0) applySel(pcbNetSel(h.net), 'pcb');
  else applySel(null, 'pcb');
}

function sheetHas(si, sel) {
  const s = V.schs[si].data;
  if (sel.type === 'comp') return s.components.some((c) => c.des === sel.des);
  return V.link.wireNet[si].some((n) => sel.sch.has(n)) || V.link.pinNet[si].some((n) => sel.sch.has(n)) || V.link.labelNet[si].some((n) => sel.sch.has(n));
}

function growBox(b, x1, y1, x2 = x1, y2 = y1) {
  if (!b) return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  b[0] = Math.min(b[0], x1, x2); b[1] = Math.min(b[1], y1, y2); b[2] = Math.max(b[2], x1, x2); b[3] = Math.max(b[3], y1, y2); return b;
}

function applySel(sel, origin = 'none') {
  V.sel = sel;
  // switch sheet if needed
  if (sel && V.schs.length > 1 && !sheetHas(V.si, sel)) {
    const si = V.schs.findIndex((_, i) => sheetHas(i, sel));
    if (si >= 0) { showSheet(si, false); if (origin === 'sch') origin = 'none'; }
  }
  const sb = V.schs.length ? highlightSch(sel) : null;
  const pb = V.pcbR ? highlightPcb(sel) : null;
  if (sel) {
    if (sb && origin !== 'sch' && $('#panes').dataset.layout !== 'pcb') V.schPane.reveal(sb, 420);
    if (pb && origin !== 'pcb' && $('#panes').dataset.layout !== 'sch') V.pcbPane.reveal(pb, 900);
  }
  sync3D(!!sel && origin !== '3d');
  renderInfo(sel);
}

function highlightSch(sel) {
  const P = V.schPane;
  P.ov.replaceChildren();
  P.base.classList.toggle('dim', !!sel);
  if (!sel) return null;
  const s = V.schs[V.si].data;
  let box = null;
  if (sel.type === 'comp') {
    for (const c of s.components) {
      if (c.des !== sel.des) continue;
      const g = P.base.querySelector(`.comp[data-c="${c.ci}"]`);
      if (g) P.ov.append(g.cloneNode(true));
      if (c.bbox) {
        box = growBox(box, ...c.bbox);
        const r = document.createElementNS(NS, 'rect');
        const m = 3;
        r.setAttribute('x', c.bbox[0] - m); r.setAttribute('y', -c.bbox[3] - m);
        r.setAttribute('width', c.bbox[2] - c.bbox[0] + 2 * m); r.setAttribute('height', c.bbox[3] - c.bbox[1] + 2 * m);
        r.setAttribute('rx', 2); r.setAttribute('class', 'selbox');
        P.ov.prepend(r);
      }
    }
  } else {
    for (const el of P.base.querySelectorAll('[data-n]')) {
      if (!sel.sch.has(+el.dataset.n)) continue;
      const c = el.cloneNode(true); c.classList.add('hl'); P.ov.append(c);
    }
    const L = V.link;
    s.wires.forEach((w, wi) => { if (sel.sch.has(L.wireNet[V.si][wi])) for (const [x, y] of w.pts) box = growBox(box, x, y); });
    s.pins.forEach((p) => { if (sel.sch.has(L.pinNet[V.si][p.pi])) box = growBox(box, p.x, p.y, p.ex, p.ey); });
    s.labels.forEach((l, li) => { if (sel.sch.has(L.labelNet[V.si][li])) box = growBox(box, l.x, l.y); });
    // junctions on selected wires
    for (const [jx, jy] of s.junctions) {
      const on = s.wires.some((w, wi) => sel.sch.has(L.wireNet[V.si][wi]) && w.pts.some(([x, y]) => Math.abs(x - jx) < 0.05 && Math.abs(y - jy) < 0.05));
      if (on) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', jx); c.setAttribute('cy', -jy); c.setAttribute('r', 2.6); c.setAttribute('fill', 'var(--hl)'); P.ov.append(c); }
    }
  }
  return box;
}

function highlightPcb(sel) {
  const P = V.pcbPane;
  P.ov.replaceChildren();
  P.base.classList.toggle('dim', !!sel);
  if (!sel) return null;
  const pcb = V.pcbs[V.pcbIdx].data;
  const order = V.flip ? ORDER_BOT : ORDER_TOP;
  const groups = {};
  for (const k of order) { const g = document.createElementNS(NS, 'g'); g.setAttribute('data-l', k); P.ov.append(g); groups[k] = g; }
  let box = null;
  let q;
  if (sel.type === 'comp') {
    const ci = V.link.pcbCompByDes.get(sel.des);
    if (ci == null) return null;
    q = `[data-c="${ci}"]`;
    box = V.pcbR.compBox.get(ci)?.slice() || null;
  } else {
    if (sel.pcb < 0) return null;
    q = `[data-n="${sel.pcb}"]`;
    for (const p of pcb.pads) if (p.net === sel.pcb) { const r = Math.max(...p.top) / 2; box = growBox(box, p.x - r, p.y - r, p.x + r, p.y + r); }
    for (const t of pcb.tracks) if (t.net === sel.pcb && t.poly < 0) box = growBox(box, t.x1, t.y1, t.x2, t.y2);
    for (const v of pcb.vias) if (v.net === sel.pcb) box = growBox(box, v.x, v.y);
  }
  for (const el of P.base.querySelectorAll(q)) {
    const l = el.closest('[data-l]')?.dataset.l;
    if (!l || !groups[l]) continue;
    groups[l].append(el.cloneNode(true));
  }
  if (sel.type === 'comp' && box) {
    const r = document.createElementNS(NS, 'rect');
    const m = 6;
    r.setAttribute('x', box[0] - m); r.setAttribute('y', -box[3] - m);
    r.setAttribute('width', box[2] - box[0] + 2 * m); r.setAttribute('height', box[3] - box[1] + 2 * m);
    r.setAttribute('class', 'selbox');
    P.ov.append(r);
  }
  return box;
}

// ---------------- info panel ----------------
let INFO_COLLAPSED = true; // panel starts minimised; user's choice is kept for the session
const HIDE_PARAMS = /^(comment|designator|currenttime|currentdate|time|date|ki_|libref|component kind|componentlink)/i;
function renderInfo(sel) {
  const box = $('#info');
  if (!sel) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.classList.toggle('collapsed', INFO_COLLAPSED);
  const body = $('#i-body');
  const L = V.link;
  const pcb = V.pcbs[V.pcbIdx]?.data;
  if (sel.type === 'comp') {
    const parts = [];
    V.schs.forEach((s, si) => s.data.components.forEach((c) => { if (c.des === sel.des) parts.push([si, c]); }));
    const sc = parts[0]?.[1];
    const pci = L.pcbCompByDes.get(sel.des);
    const pc = pci != null && pcb ? pcb.components[pci] : null;
    $('#i-kind').textContent = 'Element';
    $('#i-title').textContent = sel.des;
    $('#i-sub').textContent = sc?.comment || pc?.comment || '';
    const rows = [];
    const desc = sc?.desc || pc?.desc || sc?.lib || pc?.lib;
    if (desc) rows.push(['Opis', desc]);
    const fp = pc?.pattern || sc?.footprint;
    if (fp) rows.push(['Footprint', fp]);
    if (pc) rows.push(['Strona', pc.layer === 'TOP' ? 'Top' : 'Bottom'], ['Pozycja', `${((pc.x - pcb.board.originX) * 0.0254).toFixed(2).replace('.', ',')} ; ${((pc.y - pcb.board.originY) * 0.0254).toFixed(2).replace('.', ',')} mm · ${+pc.rot.toFixed(1)}°`]);
    else if (V.pcbs.length) rows.push(['Strona', 'brak na płytce']);
    // pins
    const pins = [];
    for (const [si, c] of parts) for (const p of V.schs[si].data.pins) if (p.comp === c.ci) pins.push({ des: p.des, name: p.name, net: L.pinNet[si][p.pi] });
    if (!pins.length && pc && pcb) pcb.pads.forEach((p) => { if (p.comp === pci) pins.push({ des: p.name, name: '', pnet: p.net }); });
    pins.sort((a, b) => natCmp(a.des, b.des));
    const seen = new Set();
    const chips = pins.filter((p) => { const k = p.des + '|' + p.name; if (seen.has(k)) return false; seen.add(k); return true; }).map((p) => {
      const nn = p.net != null && p.net >= 0 ? L.nets[p.net] : null;
      const single = nn && nn.pins.length <= 1 && nn.pcb < 0;
      const netName = nn ? (single ? '—' : nn.name) : p.pnet >= 0 ? pcb.nets[p.pnet] : '—';
      const data = nn && !single ? `data-sn="${p.net}"` : p.pnet >= 0 ? `data-pn="${p.pnet}"` : '';
      return `<button class="pchip" ${data}><b>${esc(p.des)}</b>${p.name && p.name !== p.des ? `<i>${esc(p.name.replace(/\\/g, ''))}</i>` : ''}<span>${esc(netName)}</span></button>`;
    }).join('');
    body.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` + (chips ? `<div class="sect">Piny → sieci</div><div class="chips">${chips}</div>` : '');
  } else {
    const ids = [...sel.sch];
    const n0 = ids.length ? L.nets[ids[0]] : null;
    const name = n0?.name || (sel.pcb >= 0 && pcb ? pcb.nets[sel.pcb] : '?');
    $('#i-kind').textContent = 'Sieć';
    $('#i-title').textContent = name;
    const pins = [];
    for (const id of ids) for (const [si, pi] of L.nets[id].pins) { const p = V.schs[si].data.pins[pi]; const c = V.schs[si].data.components[p.comp]; pins.push({ des: c.des, pin: p.des, name: p.name }); }
    if (!pins.length && sel.pcb >= 0 && pcb) pcb.pads.forEach((p) => { if (p.net === sel.pcb && p.comp >= 0) pins.push({ des: pcb.components[p.comp].des, pin: p.name, name: '' }); });
    pins.sort((a, b) => natCmp(a.des, b.des) || natCmp(a.pin, b.pin));
    $('#i-sub').textContent = `${pins.length} ${pins.length === 1 ? 'pin' : pins.length < 5 ? 'piny' : 'pinów'}`;
    const rows = [];
    const aliases = new Set(ids.flatMap((id) => L.nets[id].names).filter((x) => x !== name));
    if (sel.pcb >= 0 && pcb && pcb.nets[sel.pcb] !== name) aliases.add(pcb.nets[sel.pcb]);
    if (aliases.size) rows.push(['Inne nazwy', [...aliases].join(', ')]);
    if (sel.pcb >= 0 && pcb) {
      let len = 0; const layers = new Set(); let vias = 0;
      for (const t of pcb.tracks) if (t.net === sel.pcb && t.poly < 0) { len += Math.hypot(t.x2 - t.x1, t.y2 - t.y1); layers.add(t.layer); }
      for (const a of pcb.arcs) if (a.net === sel.pcb && a.poly < 0) { let sp = ((a.ea - a.sa) % 360 + 360) % 360 || 360; len += (a.r * Math.PI * sp) / 180; layers.add(a.layer); }
      for (const v of pcb.vias) if (v.net === sel.pcb) vias++;
      const pours = (pcb.regions.length ? pcb.regions : pcb.sregions).some((r) => r.net === sel.pcb && r.poly >= 0);
      rows.push(['Ścieżki', `${(len * 0.0254).toFixed(1).replace('.', ',')} mm${layers.size ? ' · ' + [...layers].map(layerName).join(', ') : ''}`]);
      rows.push(['Przelotki', String(vias)]);
      if (pours) rows.push(['Wylewka', 'tak']);
    } else if (V.pcbs.length) rows.push(['PCB', 'sieć nie występuje na płytce']);
    const chips = pins.map((p) => `<button class="pchip" data-des="${esc(p.des)}"><b>${esc(p.des)}.${esc(p.pin)}</b>${p.name && p.name !== p.pin ? `<i>${esc(p.name.replace(/\\/g, ''))}</i>` : ''}</button>`).join('');
    body.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` + (chips ? `<div class="sect">Piny</div><div class="chips">${chips}</div>` : '');
  }
  $$('[data-sn]', body).forEach((b) => (b.onclick = () => applySel(schNetSel(+b.dataset.sn), 'none')));
  $$('[data-pn]', body).forEach((b) => (b.onclick = () => applySel(pcbNetSel(+b.dataset.pn), 'none')));
  $$('[data-des]', body).forEach((b) => (b.onclick = () => applySel({ type: 'comp', des: b.dataset.des }, 'none')));
}
$('#info-close').onclick = () => applySel(null);
const toggleInfo = () => { INFO_COLLAPSED = !INFO_COLLAPSED; $('#info').classList.toggle('collapsed', INFO_COLLAPSED); };
$('#i-collapse').onclick = toggleInfo;
$('.ititle').onclick = toggleInfo;

function showIssues() {
  const pcb = V.pcbs[V.pcbIdx]?.data;
  const items = V.link.issues.map((i) => {
    if (i.kind === 'comp-missing-pcb') return `<li><b>${esc(i.des)}</b> jest na schemacie, ale nie ma go na płytce</li>`;
    if (i.kind === 'comp-missing-sch') return `<li><b>${esc(i.des)}</b> jest na płytce, ale nie ma go na schemacie</li>`;
    if (i.kind === 'net-split') return `<li>Sieć <b>${esc(i.name)}</b> na płytce rozdzielona na: ${i.pcbNets.map(esc).join(', ')}</li>`;
    return '';
  }).join('');
  message('Rozbieżności schemat ↔ PCB', `<p class="small">Porównanie schematu z płytką ${esc(V.pcbs[V.pcbIdx]?.name || '')}. Zwykle oznacza to, że zmian ze schematu nie przeniesiono na PCB (ECO).</p><ul>${items}</ul>`);
}
$('#v-issues').onclick = showIssues;

// ---------------- search ----------------
let SIDX = [];
function buildSearchIndex() {
  const comps = new Map();
  V.schs.forEach((s) => s.data.components.forEach((c) => { if (c.des && !comps.has(c.des)) comps.set(c.des, c.comment); }));
  const pcb = V.pcbs[V.pcbIdx]?.data;
  if (pcb) pcb.components.forEach((c) => { if (!comps.has(c.des)) comps.set(c.des, c.comment || c.pattern); });
  SIDX = [...comps].map(([des, sub]) => ({ t: 'comp', key: des, sub: sub || '', des })).sort((a, b) => natCmp(a.key, b.key));
  const netNames = new Set();
  V.link.nets.forEach((n) => { if (n.pins.length < 2 && n.pcb < 0) return; netNames.add(n.name); SIDX.push({ t: 'net', key: n.name, sub: `${n.pins.length} pin.`, id: n.id }); });
  if (pcb) pcb.nets.forEach((nm, i) => { if (!V.link.pcbNetToSch[i].length && !netNames.has(nm)) SIDX.push({ t: 'pnet', key: nm, sub: 'tylko PCB', id: i }); });
}
function runSearch() {
  const q = $('#q').value.trim().toUpperCase();
  const res = $('#q-res');
  let items = SIDX;
  if (q) {
    items = SIDX.map((it) => {
      const k = it.key.toUpperCase();
      const s = (it.sub || '').toUpperCase();
      const sc = k === q ? 0 : k.startsWith(q) ? 1 : k.includes(q) ? 2 : s.includes(q) ? 3 : 9;
      return [sc, it];
    }).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || natCmp(a[1].key, b[1].key)).map(([, it]) => it);
  }
  items = items.slice(0, 60);
  res.innerHTML = items.map((it, i) => `<li data-i="${i}"><svg><use href="#${it.t === 'comp' ? 'i-chip' : 'i-net'}"/></svg><b>${esc(it.key)}</b><span>${esc(it.sub)}</span></li>`).join('') || '<li class="note">Brak wyników</li>';
  $$('li[data-i]', res).forEach((li) => (li.onclick = () => pick(items[+li.dataset.i])));
  res._items = items;
}
function pick(it) {
  closePops();
  let sel;
  if (it.t === 'comp') sel = { type: 'comp', des: it.des };
  else if (it.t === 'net') sel = schNetSel(it.id);
  else sel = pcbNetSel(it.id);
  applySel(sel, 'search');
}
$('#v-search').onclick = () => {
  const p = $('#search-pop');
  const open = p.classList.contains('hidden');
  closePops();
  if (open) { p.classList.remove('hidden'); $('#v-search').classList.add('on'); $('#q').value = ''; runSearch(); setTimeout(() => $('#q').focus(), 30); }
};
$('#q').oninput = runSearch;
$('#q').onkeydown = (e) => { if (e.key === 'Enter') { const it = $('#q-res')._items?.[0]; if (it) pick(it); } if (e.key === 'Escape') closePops(); };

// ---------------- layers ----------------
const LCOL = { mech: '#b27cf7', bpour: '#3d6fd6', bcu: '#3d6fd6', inner: '#3fae6a', tpour: '#d23a3a', tcu: '#d23a3a', multi: '#c9b26a', via: '#a9b0bb', hole: '#444', keepout: '#f0f', bsilk: '#c2a640', tsilk: '#f1e15a', outline: '#d7dbe2' };
function updateLayersUI() {
  const p = $('#layers-pop');
  const rows = PCB_LAYERS.slice().reverse().map((l) => `<div class="lrow" data-l="${l.id}"><span class="sw" style="background:${LCOL[l.id]};${l.id.endsWith('pour') ? 'opacity:.5' : ''}"></span><span class="lname">${l.name}</span><span class="tog ${V.vis[l.id] ? 'on' : ''}"></span></div>`).join('');
  p.innerHTML = `<div class="lrow" data-act="flip"><span class="lname"><b>Widok od strony Bottom</b></span><span class="tog ${V.flip ? 'on' : ''}"></span></div>
    <div class="lrow" data-act="only-top"><span class="lname">Tylko Top</span></div>
    <div class="lrow" data-act="only-bot"><span class="lname">Tylko Bottom</span></div>
    <div class="lrow" data-act="all"><span class="lname">Wszystkie warstwy</span></div>
    <div class="lsep"></div>${rows}`;
  $$('.lrow', p).forEach((r) => (r.onclick = () => {
    const a = r.dataset.act;
    if (a === 'flip') { setFlip(!V.flip); return; }
    if (a) {
      const top = ['tcu', 'tpour', 'tsilk'], bot = ['bcu', 'bpour', 'bsilk'];
      for (const l of PCB_LAYERS) {
        if (a === 'all') V.vis[l.id] = l.id !== 'keepout';
        else if (a === 'only-top') V.vis[l.id] = bot.includes(l.id) ? false : top.includes(l.id) ? true : V.vis[l.id];
        else V.vis[l.id] = top.includes(l.id) ? false : bot.includes(l.id) ? true : V.vis[l.id];
      }
      if (a === 'only-bot' && !V.flip) { saveVis(); setFlip(true); return; }
      if (a === 'only-top' && V.flip) { saveVis(); setFlip(false); return; }
    } else V.vis[r.dataset.l] = !V.vis[r.dataset.l];
    saveVis();
    applyVis(); applySel(V.sel, 'none'); updateLayersUI();
  }));
}
function saveVis() { LS.set('layers', V.vis); }
$('#v-layers').onclick = () => {
  const p = $('#layers-pop');
  const open = p.classList.contains('hidden');
  closePops();
  if (open) { p.classList.remove('hidden'); $('#v-layers').classList.add('on'); }
};
function closePops() {
  $('#search-pop').classList.add('hidden'); $('#layers-pop').classList.add('hidden');
  $('#v-search').classList.remove('on'); $('#v-layers').classList.remove('on');
}
document.addEventListener('keydown', (e) => {
  if ($('#viewer').classList.contains('hidden')) return;
  if (e.key === 'Escape') { closePops(); applySel(null); }
  if ((e.key === 'f' || e.key === '/') && document.activeElement !== $('#q')) { e.preventDefault(); $('#v-search').click(); }
});


// ---------------- share target inbox ----------------
async function checkShareInbox() {
  if (!('caches' in window)) return;
  try {
    const c = await caches.open('av-share-inbox');
    const keys = await c.keys();
    if (!keys.length) return;
    const files = [];
    for (const k of keys) {
      const r = await c.match(k);
      const name = decodeURIComponent(new URL(k.url).searchParams.get('name') || 'plik');
      const blob = await r.blob();
      files.push(new File([blob], name, { lastModified: +(r.headers.get('x-lm') || Date.now()) }));
      await c.delete(k);
    }
    history.replaceState(null, '', location.pathname);
    if (files.length) await doImport(files, null);
  } catch (e) { console.warn(e); }
}

// ---------------- boot ----------------
if ('serviceWorker' in navigator && location.protocol !== 'file:' && document.querySelector('link[rel=manifest]')) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  // a new version took over -> reload once so the new files are used right away
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('./sw.js').then((r) => r.update()).catch(() => {});
}
$('#ver').textContent = 'wersja ' + APP_VERSION;
showHome().then(() => checkShareInbox());
window.__av = V; // debug
