// rrweb Files tab: work with the photo folders on the server (download, upload, new folder, rename, copy, move,
// delete to the trash) next to RapidRAW's UI. vite.web.config.mjs adds it to index.html.
// Server side: rrweb/relay/files.mjs.
import { call, emitLocal } from '../shim/transport';
import { baseName, collator, copyText, el, errText, fmtSize, icon, joinPath, ls, rootName, type Item, type Listing } from './ui';
import { mountNetwork } from './network';
import { mountProgress } from './progress';
import { mountAdjustProgress } from './adjust';
import { mountRemote } from './remote';
import './files.css';

declare const __RR_VERSION__: string;

type SortKey = 'name' | 'size' | 'mtime';

let listing: Listing = { path: null, roots: [], library: null, sep: '/', crumbs: [], items: [] };
let selected = new Set<string>();
let anchor: string | null = null;
let clipboard: { mode: 'copy' | 'move'; paths: string[] } | null = null;
let showSidecars = false;
let sort: { key: SortKey; dir: 1 | -1 } = { key: 'name', dir: 1 };
let isOpen = false;
let busy = false;
let changed = false; // disk changed → RapidRAW's library needs a refresh

const join = (name: string) => joinPath(listing, name);
function visible() {
  return listing.items.filter((i) => showSidecars || !i.sidecar).sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const d = sort.key === 'name' ? collator.compare(a.name, b.name) : a[sort.key] - b[sort.key];
    return (d || collator.compare(a.name, b.name)) * sort.dir;
  });
}
const selectedItems = () => listing.items.filter((i) => selected.has(i.name));

// --- DOM ---
const tabEditor = el('button', { class: 'active', onclick: () => setTab(false) }, 'Editor');
const tabFiles = el('button', { onclick: () => setTab(true) }, 'Files');
const tabs = el('div', { id: 'rrf-tabs' }, tabEditor, tabFiles);

const btn = (label: string, title: string, onclick: () => void) => el('button', { title, onclick }, label);
const b = {
  up: btn('↑', 'Parent folder (Backspace)', () => goUp()),
  refresh: btn('⟳', 'Refresh', () => load(listing.path, [...selected])),
  upload: btn('Upload', 'Upload files (or drop them here)', () => fileInput.click()),
  mkdir: btn('New folder', 'New folder', () => newFolder()),
  download: btn('Download', 'Download (several items or folders as .zip)', () => download()),
  copy: btn('Copy', 'Copy (Ctrl+C), then Paste in another folder', () => toClipboard('copy')),
  cut: btn('Cut', 'Cut (Ctrl+X), then Paste in another folder', () => toClipboard('move')),
  paste: btn('Paste', 'Paste here (Ctrl+V)', () => paste()),
  rename: btn('Rename', 'Rename (F2)', () => rename()),
  path: btn('Copy path', 'Copy the server path of the selected item (or of this folder)', () => copyPath()),
  del: btn('Delete', 'Move to trash (Delete)', () => remove()),
};
const sep = () => el('span', { class: 'rrf-sep' });
const sidecarBox = el('input', { type: 'checkbox', onchange: () => { showSidecars = sidecarBox.checked; render(); } }) as HTMLInputElement;
const fileInput = el('input', { type: 'file', multiple: true, hidden: true,
  onchange: () => { upload([...fileInput.files!]); fileInput.value = ''; } }) as HTMLInputElement;
const sink = el('iframe', { name: 'rrf-dl', hidden: true, title: 'downloads' });

const rootsBox = el('nav', { class: 'rrf-roots' });
const remoteBox = el('div', { class: 'rrr' });
const crumbs = el('div', { class: 'rrf-crumbs' });
const th = (label: string, key: SortKey, cls = '') => el('th', { class: cls, onclick: () => {
  sort = sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 };
  render();
} }, label);
const tbody = el('tbody');
const summary = el('span');
const message = el('span', { class: 'rrf-msg' });
const drop = el('div', { class: 'rrf-drop' }, 'Drop files to upload them into this folder');
const panel = el('div', { id: 'rrf', hidden: true },
  el('aside', {}, el('div', { class: 'rrf-h' }, 'Photo folders'), rootsBox,
    el('p', { class: 'rrf-note' }, 'Your photo library and the folders you open in RapidRAW are listed here.'),
    remoteBox,
    el('p', { class: 'rrf-ver' }, `RapidRAW ${__RR_VERSION__}`)),
  el('section', {},
    crumbs,
    el('div', { class: 'rrf-bar' }, b.up, b.refresh, sep(), b.upload, b.mkdir, sep(), b.download, sep(),
      b.copy, b.cut, b.paste, sep(), b.rename, b.del, sep(), b.path, el('span', { class: 'rrf-grow' }),
      el('label', { class: 'rrf-check', title: 'RapidRAW stores edits in .rrdata files next to each photo; they are moved, copied and deleted together with it' },
        sidecarBox, 'Show edit files')),
    el('div', { class: 'rrf-list' }, el('table', {},
      el('thead', {}, el('tr', {}, th('Name', 'name'), th('Size', 'size', 'num'), th('Modified', 'mtime', 'num'))), tbody)),
    el('div', { class: 'rrf-status' }, summary, message)),
  drop, fileInput, sink);
document.body.append(panel, tabs);
mountNetwork(tabs);
mountProgress(tabs);
mountAdjustProgress();
// the RapidRAW version, linked to its release
tabs.append(el('a', { class: 'rrf-tag', href: `https://github.com/CyberTimon/RapidRAW/releases/tag/v${__RR_VERSION__}`, target: '_blank', rel: 'noopener', title: 'RapidRAW version: open the release on GitHub' }, `v${__RR_VERSION__}`));
mountRemote(remoteBox, { open: (p) => load(p), refresh: () => { if (isOpen) load(listing.path, [...selected]); } });

function setMessage(text = '', error = false) {
  message.textContent = text;
  message.className = error ? 'rrf-msg err' : 'rrf-msg';
}

function render() {
  rootsBox.replaceChildren(...listing.roots.map((r) =>
    el('button', { class: listing.crumbs[0]?.path === r ? 'active' : '', title: r, onclick: () => load(r) }, icon(true), rootName(listing, r))));
  if (!listing.roots.length) {
    rootsBox.append(el('p', { class: 'rrf-note' }, 'No photo folders yet: choose the photo library in the RapidRAW Web window on the server, or open a folder in RapidRAW.'));
  }
  crumbs.replaceChildren(...listing.crumbs.flatMap((c, i) =>
    [...(i ? [el('span', { class: 'rrf-sep-char' }, '›')] : []), el('button', { onclick: () => load(c.path) }, c.name)]));

  const items = visible();
  tbody.replaceChildren(...items.map((it) => el('tr', {
    class: selected.has(it.name) ? 'sel' : '',
    onclick: (e: MouseEvent) => select(it.name, e),
    ondblclick: () => openItem(it),
  }, el('td', { class: 'name' }, icon(it.dir), el('span', {}, it.name)),
  el('td', { class: 'num' }, it.dir ? '' : fmtSize(it.size)),
  el('td', { class: 'num' }, new Date(it.mtime).toLocaleString()))));
  if (listing.path && !items.length) tbody.append(el('tr', {}, el('td', { colspan: 3, class: 'rrf-empty' }, 'This folder is empty')));

  const n = selected.size;
  const inFolder = !!listing.path;
  b.up.disabled = listing.crumbs.length < 2;
  b.refresh.disabled = b.upload.disabled = b.mkdir.disabled = b.path.disabled = !inFolder;
  b.download.disabled = b.copy.disabled = b.cut.disabled = b.del.disabled = !n;
  b.rename.disabled = n !== 1;
  b.paste.disabled = !clipboard || !inFolder;
  b.paste.textContent = clipboard ? `Paste ${clipboard.paths.length}` : 'Paste';
  const bytes = selectedItems().reduce((s, i) => s + i.size, 0);
  summary.textContent = inFolder ? `${items.length} item${items.length === 1 ? '' : 's'}${n ? ` · ${n} selected${bytes ? ` (${fmtSize(bytes)})` : ''}` : ''}` : '';
}

async function load(path: string | null, keep: string[] = []) {
  try {
    const next = await ls(path);
    if (!next.path && next.roots.length) return load(next.roots[0]);
    if (next.path !== listing.path) anchor = null;
    listing = next;
    selected = new Set(keep.filter((k) => listing.items.some((i) => i.name === k)));
    render();
  } catch (e) {
    setMessage(errText(e), true);
    if (path) return load(null); // the folder is gone or outside the allowed ones
  }
}

// A change on disk, then a refresh of the listing; an error goes to the status bar
async function act(label: string, fn: () => Promise<unknown>, keep?: string[]) {
  if (busy) return;
  busy = true;
  setMessage(`${label}…`);
  try {
    await fn();
    changed = true;
    setMessage(`${label}: done`);
  } catch (e) {
    setMessage(errText(e), true);
  } finally {
    busy = false;
  }
  await load(listing.path, keep ?? [...selected]);
}

function select(name: string, e: MouseEvent) {
  const names = visible().map((i) => i.name);
  if (e.shiftKey && anchor && names.includes(anchor)) {
    const [from, to] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
    if (!(e.ctrlKey || e.metaKey)) selected.clear();
    names.slice(from, to + 1).forEach((n) => selected.add(n));
  } else if (e.ctrlKey || e.metaKey) {
    if (!selected.delete(name)) selected.add(name);
    anchor = name;
  } else {
    selected = new Set([name]);
    anchor = name;
  }
  render();
}

function moveCursor(step: number, extend: boolean) {
  const names = visible().map((i) => i.name);
  if (!names.length) return;
  const cur = anchor && names.includes(anchor) ? names.indexOf(anchor) : step > 0 ? -1 : names.length;
  const next = names[Math.max(0, Math.min(names.length - 1, cur + step))];
  if (!extend) selected.clear();
  selected.add(next);
  anchor = next;
  render();
  tbody.children[names.indexOf(next)]?.scrollIntoView({ block: 'nearest' });
}

function openItem(it: Item) {
  if (it.dir) load(join(it.name));
  else { selected = new Set([it.name]); download(); }
}

function goUp() {
  if (listing.crumbs.length > 1) load(listing.crumbs[listing.crumbs.length - 2].path, [baseName(listing.path!)]);
}

function download() {
  const items = selectedItems();
  if (!items.length) return;
  if (items.length === 1 && !items[0].dir) {
    sink.src = `/fm/dl?path=${encodeURIComponent(join(items[0].name))}&t=${Date.now()}`;
    return;
  }
  const form = el('form', { method: 'POST', action: '/fm/zip', target: 'rrf-dl' },
    ...items.map((i) => el('input', { type: 'hidden', name: 'path', value: join(i.name) })),
    el('input', { type: 'hidden', name: 'name', value: items.length === 1 ? items[0].name : baseName(listing.path!) })) as HTMLFormElement;
  document.body.append(form);
  form.submit();
  form.remove();
  setMessage(`Preparing ${items.length === 1 ? items[0].name : `${items.length} items`} as .zip…`);
}

function put(dir: string, file: File, overwrite: boolean, progress: (pct: number) => void) {
  return new Promise<{ status: number; text: string }>((resolve) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/fm/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`);
    x.upload.onprogress = (e) => { if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => resolve({ status: x.status, text: x.responseText });
    x.onerror = () => resolve({ status: 0, text: 'connection failed' });
    x.send(file);
  });
}

async function upload(files: File[]) {
  const dir = listing.path;
  if (!dir || !files.length || busy) return;
  busy = true;
  const done: string[] = [];
  try {
    for (const [i, f] of files.entries()) {
      let overwrite = false;
      for (;;) {
        const r = await put(dir, f, overwrite, (pct) => setMessage(`Uploading ${i + 1}/${files.length}: ${f.name} ${pct}%`));
        if (r.status === 409 && !overwrite) {
          if (confirm(`"${f.name}" already exists in this folder. Replace it?`)) { overwrite = true; continue; }
        } else if (r.status >= 300 || r.status === 0) {
          throw new Error(`Upload of ${f.name} failed: ${r.text || r.status}`);
        } else { done.push(f.name); changed = true; }
        break;
      }
    }
    setMessage(`Uploaded ${done.length} of ${files.length} files`);
  } catch (e) {
    setMessage(errText(e), true);
  } finally {
    busy = false;
  }
  await load(dir, done);
}

function newFolder() {
  if (!listing.path) return;
  const name = prompt('New folder name:')?.trim();
  if (name) act('Creating folder', () => call('__rr_fs_mkdir', { dir: listing.path, name }), [name]);
}

function rename() {
  const [it] = selectedItems();
  if (!it || selected.size !== 1) return;
  const name = prompt(`Rename "${it.name}" to:`, it.name)?.trim();
  if (name && name !== it.name) act('Renaming', () => call('__rr_fs_rename', { path: join(it.name), name }), [name]);
}

async function copyPath() {
  const [it] = selectedItems();
  const p = it && selected.size === 1 ? join(it.name) : listing.path;
  if (!p) return;
  await copyText(p);
  setMessage(`Copied: ${p}`);
}

function toClipboard(mode: 'copy' | 'move') {
  const items = selectedItems();
  if (!items.length) return;
  clipboard = { mode, paths: items.map((i) => join(i.name)) };
  setMessage(`${items.length} item(s) ready to ${mode === 'copy' ? 'copy' : 'move'}: open the destination folder and click Paste`);
  render();
}

function paste() {
  if (!clipboard || !listing.path) return;
  const { mode, paths } = clipboard;
  if (mode === 'move') clipboard = null;
  act(mode === 'copy' ? 'Copying' : 'Moving', () => call(mode === 'copy' ? '__rr_fs_copy' : '__rr_fs_move', { paths, dest: listing.path }),
    paths.map(baseName));
}

function remove() {
  const items = selectedItems();
  if (!items.length) return;
  const names = items.slice(0, 5).map((i) => `  ${i.name}${i.dir ? '/' : ''}`).join('\n') + (items.length > 5 ? `\n  …and ${items.length - 5} more` : '');
  if (confirm(`Move ${items.length} item(s) to the trash on the server?\n\n${names}`)) {
    act('Moving to trash', () => call('__rr_fs_delete', { paths: items.map((i) => join(i.name)) }), []);
  }
}

function setTab(open: boolean) {
  isOpen = open;
  panel.hidden = !open;
  tabFiles.classList.toggle('active', open);
  tabEditor.classList.toggle('active', !open);
  if (open) load(listing.path, [...selected]);
  else if (changed) {
    changed = false;
    emitLocal('indexing-finished'); // RapidRAW then reloads the list of images in the current folder
  }
}

// While the Files tab is open, the keyboard must not reach RapidRAW (Delete would e.g. delete the selected images in the editor)
window.addEventListener('keydown', (e) => {
  if (!isOpen) return;
  e.stopImmediatePropagation();
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = e.ctrlKey || e.metaKey;
  const actions: Record<string, () => void> = mod
    ? { a: () => { selected = new Set(visible().map((i) => i.name)); render(); }, c: () => toClipboard('copy'), x: () => toClipboard('move'), v: paste }
    : { Delete: remove, F2: rename, Backspace: goUp, Escape: () => { selected.clear(); render(); },
      Enter: () => { const [it] = selectedItems(); if (it && selected.size === 1) openItem(it); },
      ArrowDown: () => moveCursor(1, e.shiftKey), ArrowUp: () => moveCursor(-1, e.shiftKey) };
  if (actions[k]) { e.preventDefault(); actions[k](); }
}, true);
for (const type of ['keyup', 'keypress', 'wheel'] as const) {
  window.addEventListener(type, (e) => { if (isOpen) e.stopImmediatePropagation(); }, true);
}

panel.addEventListener('dragover', (e) => {
  if (!listing.path || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  panel.classList.add('dragging');
});
drop.addEventListener('dragleave', () => panel.classList.remove('dragging'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  panel.classList.remove('dragging');
  const entries = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.());
  const files = [...(e.dataTransfer?.files ?? [])].filter((_, i) => !entries[i]?.isDirectory);
  if (files.length < (e.dataTransfer?.files.length ?? 0)) setMessage('Folders cannot be uploaded yet, only files', true);
  upload(files);
});
