// "This computer": a folder on the browsing computer as the source and storage of photos for RapidRAW on the server.
// The browser is the agent (WebSocket /rfs): it reads and writes the chosen folder through the File System Access
// API (Chrome/Edge, only on HTTPS or localhost). Server side: rrweb/relay/remote.mjs.
//  - transfer: the whole folder is copied to the server in the background; edits and exports come back into the folder here
//  - ondemand: (Linux server, or Windows server with WinFsp) photos are fetched only when RapidRAW opens them
import { call, emitLocal } from '../shim/transport';
import { pick } from './picker';
import { el, errText, fmtSize } from './ui';
import './files.css';

type Mode = 'transfer' | 'ondemand';
type ShareInfo = { id: string; name: string; mode: Mode; keep: boolean; fill?: boolean; view: string; mirror: string; online: boolean;
  stats: { fetched: number; complete: number; uploaded: number; pushed: number; total?: number; filled?: number; filling?: boolean; diskFull?: boolean } };
type Saved = { id: string; name: string; mode: Mode; keep: boolean; keepDir?: string; fill?: boolean; handle: FileSystemDirectoryHandle };
type Progress = { done: number; total: number; bytes: number; totalBytes: number; started: number; current?: string; error?: string; finished?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, any]>; queryPermission?(o: object): Promise<string>; requestPermission?(o: object): Promise<string> };

export const supported = () => 'showDirectoryPicker' in window && window.isSecureContext;

// --- IndexedDB: chosen folders (handles) survive a page reload ---
function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('rrweb', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('shares', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const r = fn(d.transaction('shares', mode).objectStore('shares'));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const loadSaved = () => store<Saved[]>('readonly', (s) => s.getAll() as IDBRequest<Saved[]>).catch(() => [] as Saved[]);
const save = (s: Saved) => store('readwrite', (st) => st.put(s));
const forget = (id: string) => store('readwrite', (st) => st.delete(id));

// --- agent ---
const segments = (rel: string) => {
  if (!rel) return [];
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new DOMException(`bad path ${rel}`, 'TypeMismatchError');
  return parts;
};
const errno = (e: unknown) => {
  const n = (e as DOMException)?.name;
  return n === 'NotFoundError' ? 'ENOENT' : n === 'TypeMismatchError' ? 'ENOTDIR' : n === 'InvalidModificationError' ? 'ENOTEMPTY'
    : n === 'NotAllowedError' || n === 'SecurityError' ? 'EACCES' : 'EIO';
};
function frame(q: number, head: object, data?: Uint8Array<ArrayBuffer>) {
  const h = new TextEncoder().encode(JSON.stringify(head));
  const out = new Uint8Array(8 + h.length + (data?.length ?? 0));
  const v = new DataView(out.buffer);
  v.setUint32(0, q, true);
  v.setUint32(4, h.length, true);
  out.set(h, 8);
  if (data) out.set(data, 8 + h.length);
  return out;
}

class Agent {
  ws?: WebSocket;
  stopped = false;
  files = new Map<string, { file: File; at: number }>();
  writers = new Map<string, FileSystemWritableFileStream>();
  progress?: Progress;
  // onGone: the server doesn't know this folder (the relay restarted) → register it again
  constructor(public share: ShareInfo, public root: Dir, private onChange: () => void, private onGone?: () => void) {}

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rfs?id=${this.share.id}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.share.online = true; this.onChange(); };
    ws.onmessage = (m) => this.handle(m.data as ArrayBuffer);
    ws.onclose = (ev) => {
      this.share.online = false;
      this.onChange();
      if (this.stopped) return;
      if (ev.code === 4004 && this.onGone) { this.stopped = true; this.onGone(); return; }
      setTimeout(() => this.connect(), 2000);
    };
    this.ws = ws;
  }

  stop() { this.stopped = true; this.ws?.close(); }

  async dir(rel: string, create = false) {
    let d: Dir = this.root;
    for (const s of segments(rel)) d = await d.getDirectoryHandle(s, { create }) as Dir;
    return d;
  }

  async file(rel: string) {
    const c = this.files.get(rel);
    if (c && Date.now() - c.at < 2000) return c.file;
    const parts = segments(rel);
    const fh = await (await this.dir(parts.slice(0, -1).join('/'))).getFileHandle(parts.at(-1)!);
    const file = await fh.getFile();
    this.files.set(rel, { file, at: Date.now() });
    return file;
  }

  // Fuji RAF: where the embedded JPEG is (header: its offset and length at 84 and 88, big-endian)
  async rafPreview(rel: string) {
    const f = await this.file(rel);
    const head = new DataView(await f.slice(0, 92).arrayBuffer());
    const magic = head.byteLength >= 92 ? new TextDecoder().decode(new Uint8Array(head.buffer, 0, 15)) : '';
    const off = magic ? head.getUint32(84) : 0;
    const len = magic ? head.getUint32(88) : 0;
    if (magic !== 'FUJIFILMCCD-RAW' || !len || off + len > f.size) throw new DOMException('no embedded preview', 'TypeMismatchError');
    return { f, off, len };
  }

  async op(h: Record<string, any>, data: Uint8Array<ArrayBuffer>): Promise<[object, Uint8Array<ArrayBuffer>?]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const parent = (rel: string) => rel.split('/').slice(0, -1).join('/');
    const name = (rel: string) => rel.split('/').at(-1)!;
    switch (h.op) {
      case 'list': {
        const entries = [];
        const files: [string, FileSystemFileHandle][] = [];
        for await (const [n, handle] of (await this.dir(h.path)).entries()) {
          if (n.startsWith('.')) continue;
          if (handle.kind === 'directory') entries.push({ name: n, kind: 'dir' });
          else files.push([n, handle as FileSystemFileHandle]);
        }
        // getFile() one by one is slow on big folders (1330 files ~1 s): 64 in parallel
        for (let i = 0; i < files.length; i += 64) {
          await Promise.all(files.slice(i, i + 64).map(async ([n, handle]) => {
            const f = await handle.getFile().catch(() => null); // deleted meanwhile
            if (f) entries.push({ name: n, kind: 'file', size: f.size, mtime: f.lastModified });
          }));
        }
        return [{ entries }];
      }
      case 'read': {
        try {
          const f = await this.file(h.path);
          return [{}, new Uint8Array(await f.slice(h.off, h.off + h.len).arrayBuffer())];
        } catch { // the cached File is stale (the file changed meanwhile): get a fresh one and try once more
          this.files.delete(h.path);
          const f = await this.file(h.path);
          return [{}, new Uint8Array(await f.slice(h.off, h.off + h.len).arrayBuffer())];
        }
      }
      case 'write': { // pieces of the same file share one writable (otherwise Chrome copies the whole file for each piece)
        let w = this.writers.get(h.path);
        if (!w || h.trunc) {
          await w?.close().catch(() => {});
          const fh = await (await this.dir(parent(h.path), true)).getFileHandle(name(h.path), { create: true });
          w = await fh.createWritable({ keepExistingData: !h.trunc });
          this.writers.set(h.path, w);
        }
        await w.write({ type: 'write', position: h.off, data });
        if (h.done) { await w.close(); this.writers.delete(h.path); }
        this.files.delete(h.path);
        return [{}];
      }
      case 'rafexif': { // Fuji RAF: only the EXIF header of the embedded JPEG (SOI … APP1 Exif, EOI) for RapidRAW (rrweb/relay/exif.mjs)
        const { f, off, len } = await this.rafPreview(h.path);
        const j = new Uint8Array(await f.slice(off, off + Math.min(len, 1 << 18)).arrayBuffer());
        const v = new DataView(j.buffer);
        for (let i = 2; i + 10 <= j.length && j[i] === 0xff;) {
          const seg = 2 + v.getUint16(i + 2);
          if (j[i + 1] === 0xe1 && new TextDecoder().decode(j.subarray(i + 4, i + 8)) === 'Exif') {
            const out = new Uint8Array(i + seg + 2);
            out.set(j.subarray(0, i + seg));
            out.set([0xff, 0xd9], i + seg);
            return [{}, out];
          }
          i += seg;
        }
        throw new DOMException('no EXIF in the embedded preview', 'TypeMismatchError');
      }
      case 'mkdir': await this.dir(h.path, true); return [{}];
      case 'remove': await (await this.dir(parent(h.path))).removeEntry(name(h.path), { recursive: !!h.recursive }); return [{}];
      case 'rename': {
        const src = await (await this.dir(parent(h.from))).getFileHandle(name(h.from));
        const destDir = await this.dir(parent(h.to), true);
        if ('move' in src) await (src as unknown as { move(d: Dir, n: string): Promise<void> }).move(destDir, name(h.to));
        else { // older Chromium: copy + delete
          const w = await (await destDir.getFileHandle(name(h.to), { create: true })).createWritable();
          await w.write(await src.getFile());
          await w.close();
          await (await this.dir(parent(h.from))).removeEntry(name(h.from));
        }
        this.files.delete(h.from);
        return [{}];
      }
      default: throw new Error(`unknown op ${h.op}`);
    }
  }

  async handle(buf: ArrayBuffer) {
    const v = new DataView(buf);
    const q = v.getUint32(0, true);
    const hlen = v.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
    const data = new Uint8Array(buf, 8 + hlen);
    let reply: Uint8Array<ArrayBuffer>;
    try {
      const [res, payload] = await this.op(head, data);
      reply = frame(q, res, payload);
    } catch (e) {
      reply = frame(q, { err: errno(e), message: errText(e) });
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(reply);
  }

  // transfer: the whole folder (with subfolders) to the server; what is already there is skipped, so it can resume
  async transfer() {
    const have = await call<Record<string, { size: number; mtime: number }>>('__rr_share_have', { id: this.share.id });
    const list: { rel: string; file: File }[] = [];
    const walk = async (d: Dir, rel: string) => {
      for await (const [n, h] of d.entries()) {
        if (n.startsWith('.')) continue;
        const r = rel ? `${rel}/${n}` : n;
        if (h.kind === 'directory') await walk(h, r);
        else list.push({ rel: r, file: await h.getFile() });
      }
    };
    await walk(this.root, '');
    list.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    const p: Progress = this.progress = { done: 0, total: list.length, bytes: 0, totalBytes: list.reduce((s, f) => s + f.file.size, 0), started: Date.now() };
    let sinceRefresh = 0;
    for (const { rel, file } of list) {
      if (this.stopped) return;
      const h = have[rel];
      if (!h || h.size !== file.size || Math.abs(h.mtime - file.lastModified) > 2000) {
        p.current = rel;
        this.onChange();
        await this.put(rel, file, (sent) => { p.current = rel; this.onChange(); void sent; });
        sinceRefresh++;
      }
      p.done++;
      p.bytes += file.size;
      this.onChange();
      if (sinceRefresh >= 10) { sinceRefresh = 0; emitLocal('indexing-finished'); } // RapidRAW sees the new photos
    }
    p.finished = true;
    p.current = undefined;
    emitLocal('indexing-finished');
    this.onChange();
  }

  put(rel: string, file: File, progress: (sent: number) => void) {
    return new Promise<void>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `/rfs/put?id=${this.share.id}&path=${encodeURIComponent(rel)}&mtime=${file.lastModified}`);
      x.upload.onprogress = (e) => progress(e.loaded);
      x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`${rel}: ${x.responseText || x.status}`)));
      x.onerror = () => reject(new Error(`${rel}: connection failed`));
      x.send(file);
    });
  }
}

// --- UI u Files tabu ---
export function mountRemote(box: HTMLElement, hooks: { open(path: string): void; refresh(): void }) {
  const agents = new Map<string, Agent>();
  let saved: Saved[] = [];
  let server: ShareInfo[] = [];
  let caps: { ondemand: boolean; reason?: string } = { ondemand: false };
  const list = el('div', { class: 'rrr-list' });

  const rate = (p: Progress) => {
    const s = (Date.now() - p.started) / 1000;
    const bps = s > 1 ? p.bytes / s : 0;
    const eta = bps > 0 ? Math.round((p.totalBytes - p.bytes) / bps / 60) : 0;
    return `${fmtSize(bps)}/s${eta ? ` · ~${eta} min left` : ''}`;
  };

  function status(s: Saved, info?: ShareInfo, a?: Agent) {
    if (!info) return 'Not active on the server';
    if (!a) return 'Waiting for this folder: click Reconnect';
    if (!info.online) return 'Connecting…';
    const p = a.progress;
    if (s.mode === 'transfer') {
      if (!p) return 'Preparing…';
      if (p.error) return `Stopped: ${p.error}`;
      if (!p.finished) return `Copying ${p.done}/${p.total} · ${fmtSize(p.bytes)} of ${fmtSize(p.totalBytes)} · ${rate(p)}`;
      return `${p.total} files on the server · edits and exports come back here`;
    }
    const st = info.stats;
    if (st.diskFull) return `On demand · background copy paused: the server disk is almost full · edits are saved here`;
    if (st.filling && st.total) return `On demand · copying the rest in the background: ${fmtSize(st.filled ?? 0)} of ${fmtSize(st.total)} · edits are saved here`;
    if (info.fill && st.total && !st.filling) return `On demand · whole folder on the server (${fmtSize(st.total)}) · edits are saved here`;
    return `On demand · ${fmtSize(st.fetched)} fetched · edits are saved here`;
  }

  function render() {
    list.replaceChildren(...saved.map((s) => {
      const info = server.find((i) => i.id === s.id);
      const a = agents.get(s.id);
      return el('div', { class: 'rrr-item' },
        el('button', { class: 'rrr-name', title: info?.view ?? '', onclick: () => info && hooks.open(info.view) },
          el('span', { class: `rrr-dot${info?.online ? ' on' : ''}` }), s.name),
        el('div', { class: 'rrr-status' }, status(s, info, a)),
        el('div', { class: 'rrr-actions' },
          ...(!a || !info ? [el('button', { onclick: () => resume(s) }, 'Reconnect')] : []),
          el('button', { onclick: () => stopShare(s) }, 'Stop')));
    }));
    // folders another browser or tab added to the server (or this one, before the site data was cleared)
    for (const info of server.filter((i) => !saved.some((s) => s.id === i.id))) {
      list.append(el('div', { class: 'rrr-item' },
        el('button', { class: 'rrr-name', title: info.view, onclick: () => hooks.open(info.view) },
          el('span', { class: `rrr-dot${info.online ? ' on' : ''}` }), info.name),
        el('div', { class: 'rrr-status' }, info.online
          ? 'Shared from another browser or tab'
          : 'Shared from another browser or tab · not connected (its photos can\'t be opened until it reconnects)'),
        el('div', { class: 'rrr-actions' }, el('button', { onclick: () => stopOther(info) }, 'Stop'))));
    }
    if (!saved.length && !server.length) list.append(el('p', { class: 'rrf-note' }, 'Use photos from this computer: they stay here, RapidRAW on the server edits them.'));
  }

  async function stopOther(info: ShareInfo) {
    const what = info.keep ? 'The copy on the server is kept.' : 'The temporary copy on the server is deleted; the photos on that computer stay.';
    if (!confirm(`Stop using "${info.name}" (shared from another browser or tab)?\n\n${what}`)) return;
    await call('__rr_share_stop', { id: info.id }).catch(() => {});
    await refresh();
    hooks.refresh();
  }

  async function refresh() {
    server = await call<ShareInfo[]>('__rr_share_list').catch(() => []);
    render();
  }

  async function activate(s: Saved) {
    const info = await call<ShareInfo>('__rr_share_start', { id: s.id, name: s.name, mode: s.mode, keep: s.keep, keepDir: s.keepDir, fill: s.fill ?? true });
    s.id = info.id;
    await save(s);
    agents.get(s.id)?.stop();
    const a = new Agent(info, s.handle as Dir, render, () => reactivate(s));
    agents.set(s.id, a);
    a.connect();
    if (s.mode === 'transfer') {
      await new Promise((r) => setTimeout(r, 300)); // the agent connects; the upload doesn't need it, but sending changes back does
      a.transfer().catch((e) => { a.progress = { ...(a.progress ?? { done: 0, total: 0, bytes: 0, totalBytes: 0, started: Date.now() }), error: errText(e) }; render(); });
    }
    await refresh();
    hooks.refresh();
  }

  // the server restarted: same id → same path on the server, so RapidRAW's pinned folders keep working
  function reactivate(s: Saved) {
    if (!saved.includes(s)) return;
    activate(s).catch(() => setTimeout(() => reactivate(s), 3000));
  }

  async function resume(s: Saved) {
    const h = s.handle as Dir;
    if ((await h.requestPermission?.({ mode: 'readwrite' })) === 'denied') return;
    await activate(s).catch((e) => alert(errText(e)));
  }

  async function stopShare(s: Saved) {
    const info = server.find((i) => i.id === s.id);
    const what = s.keep ? 'The copy on the server is kept.' : 'The temporary copy on the server is deleted; your photos and edits here stay.';
    if (!confirm(`Stop using "${s.name}" from this computer?\n\n${what}`)) return;
    agents.get(s.id)?.stop();
    agents.delete(s.id);
    if (info) await call('__rr_share_stop', { id: s.id }).catch(() => {});
    await forget(s.id);
    saved = saved.filter((x) => x.id !== s.id);
    await refresh();
    hooks.refresh();
  }

  function dialog() {
    let handle: Dir | null = null;
    let keepDir: string | null = null;
    const chosen = el('code', {}, 'no folder chosen');
    const keepPath = el('code', {}, 'not chosen');
    const transfer = el('input', { type: 'radio', name: 'rrr-mode', checked: true }) as HTMLInputElement;
    const ondemand = el('input', { type: 'radio', name: 'rrr-mode', disabled: !caps.ondemand }) as HTMLInputElement;
    const keep = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const fill = el('input', { type: 'checkbox', checked: true, disabled: true }) as HTMLInputElement;
    const fillRow = el('label', { class: 'rrr-sub off' }, fill,
      el('span', {}, 'Meanwhile copy the rest to the server in the background (only while RapidRAW is not reading; stops when the server disk is almost full)'));
    const modeChanged = () => { fill.disabled = !ondemand.checked; fillRow.classList.toggle('off', !ondemand.checked); };
    transfer.onchange = modeChanged;
    ondemand.onchange = modeChanged;
    const msg = el('div', { class: 'rrp-msg' });
    const close = () => back.remove();
    const back = el('div', { class: 'rrp-back' }, el('div', { class: 'rrp rrr-dialog' },
      el('div', { class: 'rrp-head' }, el('b', {}, 'Use a folder from this computer')),
      el('div', { class: 'rrr-body' },
        el('div', { class: 'rrr-row' }, el('button', { onclick: async () => {
          try {
            handle = await (window as unknown as { showDirectoryPicker(o: object): Promise<Dir> }).showDirectoryPicker({ mode: 'readwrite', id: 'rrweb' });
            chosen.textContent = handle.name;
          } catch { /* odustao */ }
        } }, 'Choose folder…'), chosen),
        el('label', { class: 'rrr-opt' }, transfer, el('span', {}, el('b', {}, 'Copy to the server in the background'),
          el('small', {}, 'The whole folder with subfolders is copied first; edit as photos arrive. Best when you are not in a hurry. Works with any server.'))),
        el('label', { class: `rrr-opt${caps.ondemand ? '' : ' off'}` }, ondemand, el('span', {}, el('b', {}, 'On demand: edit right away'),
          el('small', {}, caps.ondemand
            ? 'Nothing is copied up front: a photo is fetched when RapidRAW opens it. Browsing needs only a small part of each file (Canon CR3: the whole file, so its first thumbnails take longer).'
            : caps.reason ?? 'Not available on this server.'))),
        fillRow,
        el('label', { class: 'rrr-opt' }, keep, el('span', {}, el('b', {}, 'Also keep a copy on the server'),
          el('small', {}, 'Photos that reach the server and all edits stay in a server folder (otherwise a temporary copy is deleted when you stop).'),
          el('span', { class: 'rrr-row' }, el('button', { onclick: async () => {
            const p = await pick({ mode: 'dir', title: 'Server folder for the copy' });
            if (typeof p === 'string') { keepDir = p; keepPath.textContent = p; keep.checked = true; }
          } }, 'Server folder…'), keepPath))),
        el('p', { class: 'rrf-note' }, 'Your photos and edits stay in the folder on this computer. Keep this tab open while editing.')),
      msg,
      el('div', { class: 'rrp-foot' }, el('span', { class: 'rrf-grow' }),
        el('button', { onclick: close }, 'Cancel'),
        el('button', { class: 'rrp-ok', onclick: async () => {
          if (!handle) { msg.textContent = 'Choose a folder first'; return; }
          if (keep.checked && !keepDir) { msg.textContent = 'Choose the server folder for the copy'; return; }
          const s: Saved = { id: '', name: handle.name, mode: ondemand.checked ? 'ondemand' : 'transfer', keep: keep.checked, keepDir: keepDir ?? undefined,
            fill: ondemand.checked ? fill.checked : undefined, handle };
          msg.textContent = 'Starting…';
          try {
            await activate(s);
            saved = [...saved.filter((x) => x.id !== s.id), s];
            render();
            close();
          } catch (e) { msg.textContent = errText(e); }
        } }, 'Start'))));
    document.body.append(back);
  }

  box.append(el('div', { class: 'rrf-h rrr-h' }, 'This computer'));
  if (!supported()) { // adding isn't possible, but folders from other computers are still shown (and can be stopped)
    box.append(list, el('p', { class: 'rrf-note' }, window.isSecureContext
      ? 'Using a folder from this computer needs Chrome or Edge.'
      : 'Using a folder from this computer needs HTTPS (or localhost) and Chrome or Edge. On your own network, Chrome can treat this address as secure: chrome://flags/#unsafely-treat-insecure-origin-as-secure'));
    refresh();
    setInterval(() => { if (box.isConnected) refresh(); }, 5000);
    return { refresh };
  }
  box.append(list, el('button', { class: 'rrr-add', onclick: dialog }, '+ Use a folder from this computer'));

  window.addEventListener('beforeunload', (e) => {
    if ([...agents.values()].some((a) => !a.stopped)) { e.preventDefault(); e.returnValue = ''; }
  });

  (async () => {
    caps = await call<typeof caps>('__rr_share_caps').catch(() => caps);
    saved = await loadSaved();
    await refresh();
    // permission for the folder lasts while the tab is open; after a reload it sometimes needs a click (Reconnect)
    for (const s of saved) {
      if ((await (s.handle as Dir).queryPermission?.({ mode: 'readwrite' })) === 'granted') activate(s).catch(() => {});
    }
  })();
  setInterval(() => { if (box.isConnected && (saved.length || server.length)) refresh(); }, 3000);
  return { refresh };
}
