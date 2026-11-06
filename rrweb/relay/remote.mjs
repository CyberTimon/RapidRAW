// "This computer": a folder on the browsing computer (browser, File System Access API) as the source and storage of
// photos for RapidRAW on the server. The browser is the "agent" (WebSocket /rfs) that reads and writes that folder.
//  - transfer: the browser uploads the whole folder into a mirror on the server (works on every OS). RapidRAW works
//              on the mirror, and new and changed files (edits in .rrdata, exports) go back into the folder on the
//              browsing computer automatically.
//  - ondemand: Linux (FUSE) or Windows (WinFsp), rrweb/fuse: the folder is a disk on the server, bytes are fetched
//              only when RapidRAW reads them (chunk cache + read-ahead), and everything RapidRAW writes goes straight
//              back to the browsing computer.
//  - keep:     a copy (fetched originals + edits) stays in a chosen folder on the server; otherwise a temporary
//              cache in RR_WORK that is deleted on Stop.
// Frames on /rfs in both directions: [u32 LE q][u32 LE length of the JSON header][header][data].
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(process.env.RR_WORK ?? path.join(os.tmpdir(), 'rrweb-remote'));
const CHUNK = 1 << 20;          // unit of the cache and of fetching = the largest piece in one WebSocket message
const MAX_RUN = 1;              // chunks per request: messages ≤ 1 MB (proxies/tunnels such as Cloudflare)
const PUSH = 1 << 20;           // piece size when sending a file to the browsing computer
const READS = 6;                // fetches from the browsing computer at a time (per shared folder; the focus has its own READS)
// Priorities of fetches from the browsing computer: the photo open in the editor, metadata for the library
// (exif.mjs), other RapidRAW reads (thumbnails…), the background fill. A lower class doesn't start while a higher
// one has work.
export const PRIO = { FOCUS: 0, META: 1, READ: 2, FILL: 3 };
const EDIT_QUIET = 15000;       // ms after the last editor action until background work continues
const EDIT_RECENT = 120000;     // this long after the last action a photo counts as open (the background works slower)
const LOAD_MAX = 60000;         // a photo opening that never reported back must not stop the background forever

// Editor (relay.mjs reports photo opening and slider changes): while it works, everything in the background waits,
// so the open photo gets the whole connection, and the sliders the CPU and GPU
export const editor = {
  last: 0,
  loads: new Map(),             // token → start of the opening
  touch() { this.last = Date.now(); },
  loading(token) { this.loads.set(token, Date.now()); this.touch(); },
  loaded(token) { if (this.loads.delete(token)) this.touch(); },
  busy() {
    for (const [t, at] of this.loads) if (Date.now() - at > LOAD_MAX) this.loads.delete(t);
    return this.loads.size > 0 || Date.now() - this.last < EDIT_QUIET;
  },
  recent() { return Date.now() - this.last < EDIT_RECENT; },
  // ms without any editor action (0 while a photo opens)
  idleFor() {
    this.busy(); // clears forgotten openings
    return this.loads.size ? 0 : Date.now() - this.last;
  },
  // May background work start: while a photo is open only in a pause between edits (gapMs without an action,
  // nothing opening), otherwise once the editor has been quiet for EDIT_QUIET
  open(gapMs) { return this.editing() ? this.idleFor() >= gapMs : !this.busy(); },
  async gap(gapMs, stop = () => false) { while (!this.open(gapMs()) && !stop()) await new Promise((r) => setTimeout(r, 250)); },
  // The UI (rrweb/files/progress.ts) reports its view, 'editor' or 'library', and repeats it every few seconds.
  // Every tab (client) separately: a photo is open if it is open in any of them
  views: new Map(), // client → { mode, at }
  setView(mode, who = null) {
    const was = this.editing();
    this.views.set(who, { mode, at: Date.now() });
    if (was && !this.editing()) this.last = 0; // back in the library: the background continues at once
  },
  dropView(who) { this.views.delete(who); },
  fresh() { return [...this.views.values()].filter((v) => Date.now() - v.at < 30000); },
  viewKnown() { return this.fresh().length > 0; },
  editing() { return this.fresh().some((v) => v.mode === 'editor'); }, // a photo is open in the editor
  // background work (fill) waits while the editor works and while a photo is open
  async idle(stop = () => false) { while ((this.busy() || this.editing()) && !stop()) await new Promise((r) => setTimeout(r, 300)); },
};
const RECONNECT_WAIT = 120000;  // how long a request waits for the browser to reconnect
const FILL_RESERVE = 5e9;       // the background fill stops when less than 5 GB is left on the server
// Listing of a folder on the browsing computer: readdir (RapidRAW lists a folder) wants one fresher than LIST_TTL;
// a stat of one file takes the stored listing (up to LIST_STALE old) and refreshes it in the background when it is
// older than LIST_REFRESH
const LIST_TTL = 3000;
const LIST_REFRESH = 15000;
const LIST_STALE = 10 * 60 * 1000;
const ERRNO = { ENOENT: 2, EIO: 5, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTEMPTY: 39, EACCES: 13 };

// server bundle: fuse/<arch>/; all-in-one package: a sidecar next to the bundled Node.js (/usr/bin, AppImage usr/bin,
// Windows install)
const WIN = process.platform === 'win32';
const VERBOSE = !!process.env.RR_VERBOSE; // also FUSE operations (without read/write)
const FUSE_NAME = WIN ? 'rrweb-fuse.exe' : 'rrweb-fuse';
const FUSE_BIN = process.env.RR_FUSE_BIN ?? [
  path.join(here, '..', 'fuse', { x64: 'x86_64', arm64: 'aarch64' }[process.arch] ?? process.arch, FUSE_NAME),
  path.join(path.dirname(process.execPath), FUSE_NAME),
].find((p) => fs.existsSync(p)) ?? path.join(path.dirname(process.execPath), FUSE_NAME);

let winCheck = { at: 0, ok: false };
export function capabilities() {
  if (WIN) {
    if (!fs.existsSync(FUSE_BIN)) return { ondemand: false, reason: `rrweb-fuse not found (${FUSE_BIN}).` };
    if (Date.now() - winCheck.at > 30000) { // rrweb-fuse --check: can it load WinFsp
      const r = spawnSync(FUSE_BIN, ['--check'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
      winCheck = { at: Date.now(), ok: r.status === 0 };
    }
    return winCheck.ok ? { ondemand: true }
      : { ondemand: false, reason: 'On-demand mode needs WinFsp on the server: install it from winfsp.dev, then try again. Transfer mode works.' };
  }
  if (process.platform !== 'linux') return { ondemand: false, reason: 'On-demand mode needs a Linux or Windows server for now. Transfer mode works.' };
  if (!fs.existsSync('/dev/fuse')) return { ondemand: false, reason: '/dev/fuse is missing on the server (install fuse3).' };
  if (!fs.existsSync(FUSE_BIN)) return { ondemand: false, reason: `rrweb-fuse not found (${FUSE_BIN}).` };
  if (!['/usr/bin/fusermount3', '/bin/fusermount3', '/usr/local/bin/fusermount3'].some((p) => fs.existsSync(p))) {
    return { ondemand: false, reason: 'fusermount3 is missing on the server (install the fuse3 package).' };
  }
  return { ondemand: true };
}

const fail = (code, msg) => Object.assign(new Error(msg ?? code), { code });
function checkRel(rel) {
  if (typeof rel !== 'string') throw fail('EINVAL', 'bad path');
  if (rel === '') return rel;
  if (rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((s) => !s || s === '.' || s === '..')) throw fail('EINVAL', `bad path: ${rel}`);
  return rel;
}
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const exists = (p) => fsp.lstat(p).then(() => true, () => false);

// A mount whose rrweb-fuse is gone ("Transport endpoint is not connected") is detached lazily, so it can be used again
function lazyUnmount(dir) {
  if (process.platform !== 'linux') return; // a WinFsp mount goes away with its process
  spawnSync('fusermount3', ['-u', '-z', dir], { stdio: 'ignore' });
}

async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try { await fsp.rename(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

function frame(q, head, data) {
  const h = Buffer.from(JSON.stringify(head));
  const out = Buffer.allocUnsafe(8 + h.length + (data?.length ?? 0));
  out.writeUInt32LE(q, 0);
  out.writeUInt32LE(h.length, 4);
  h.copy(out, 8);
  if (data?.length) (Buffer.isBuffer(data) ? data : Buffer.from(data)).copy(out, 8 + h.length);
  return out;
}

// A file partly fetched from the browsing computer: a sparse file in the stage + a bitmap of chunks
class Cached {
  constructor(share, rel, size, mtime) {
    Object.assign(this, { share, rel, size, mtime });
    this.n = Math.max(1, Math.ceil(size / CHUNK));
    this.have = new Uint8Array(this.n);
    this.inflight = new Map();
    this.lastEnd = -1;
    this.seq = 0;        // how much was read in a row (sequentially)
    this.file = path.join(share.stage, rel);
    this.fd = null;      // stage file (read + write while it fills)
    this.rfd = null;     // promise: the finished file in the mirror (opened once)
    this.done = false;
    this.completing = null;
  }

  // one stage fd even when several fetches start at once
  open() {
    if (this.done) return Promise.reject(fail('EIO', 'internal: stage reopened after completion'));
    this.opening ??= (async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const fd = await fsp.open(this.file, 'w+');
      await fd.truncate(this.size);
      this.fd = fd;
      return fd;
    })();
    return this.opening;
  }

  // prio: PRIO.* (without it: the focus if this is the photo open in the editor, otherwise a normal read);
  // slotted = the slot is already taken (see fill)
  async fetchRun(start, count, prio = this.share.isFocus(this.rel) ? PRIO.FOCUS : PRIO.READ, slotted = false) {
    const off = start * CHUNK;
    const len = Math.min(count * CHUNK, this.size - off);
    if (!slotted) await this.share.slot(prio);
    let data;
    try {
      // a passing read error in the browser (e.g. the file was just written): try again, since an error through
      // mmap crashes RapidRAW
      for (let attempt = 0; ; attempt++) {
        try { ({ data } = await this.share.request({ op: 'read', path: this.rel, off, len })); break; } catch (e) {
          if (attempt >= 2 || e.code === 'ENOENT' || this.share.stopped) throw e;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    } finally { this.share.unslot(prio); }
    if (this.share.stopped) throw fail('EIO', 'stopped');
    const fd = await this.open();
    await fd.write(data, 0, data.length, off);
    this.share.stats.fetched += data.length;
    this.share.recordFetch(data.length);
    for (let i = start; i < start + count; i++) this.have[i] = 1;
  }

  async ensure(off, len) {
    if (this.done || this.size === 0) return;
    const first = Math.floor(off / CHUNK);
    const last = Math.min(this.n - 1, Math.floor((off + Math.max(len, 1) - 1) / CHUNK));
    // Read-ahead grows only with a longer sequential read (decoding a whole RAW); a thumbnail needs just the
    // start of the file and the embedded JPEG, so then nothing is fetched ahead.
    this.seq = off === this.lastEnd ? this.seq + len : len;
    this.lastEnd = off + len;
    const ahead = this.seq < (2 << 20) ? 0 : this.seq < (8 << 20) ? 2 : 8;
    const end = Math.min(this.n - 1, last + ahead);
    const waits = [];
    for (let i = first; i <= end;) {
      if (this.have[i]) { i++; continue; }
      if (this.inflight.has(i)) { if (i <= last) waits.push(this.inflight.get(i)); i++; continue; }
      let count = 1;
      while (i + count <= end && count < MAX_RUN && !this.have[i + count] && !this.inflight.has(i + count)) count++;
      const start = i;
      const p = this.fetchRun(start, count).finally(() => { for (let k = start; k < start + count; k++) this.inflight.delete(k); });
      for (let k = start; k < start + count; k++) this.inflight.set(k, p);
      if (start <= last) waits.push(p); else p.catch(() => {}); // read-ahead in the background
      i += count;
    }
    await Promise.all(waits);
    if (!this.done && this.have.every(Boolean)) await this.complete();
  }

  // Fetches every missing chunk: PRIO.FILL = background fill (waits until the editor is quiet and RapidRAW reads
  // nothing else), PRIO.FOCUS = the photo just opened in the editor (whole, in parallel, ahead of everything)
  async fill(prio = PRIO.FILL, parallel = 4) {
    const running = new Set();
    for (let i = 0; i < this.n && !this.done && !this.share.stopped; i++) {
      if (this.have[i] || this.inflight.has(i)) continue;
      if (prio === PRIO.FILL) await editor.idle(() => this.share.stopped);
      // take the slot before the chunk becomes "inflight": otherwise a read for RapidRAW would wait for a chunk that
      // is still queued
      await this.share.slot(prio);
      if (this.have[i] || this.inflight.has(i) || this.done || this.share.stopped) { this.share.unslot(prio); continue; }
      const p = this.fetchRun(i, 1, prio, true).finally(() => { this.inflight.delete(i); running.delete(p); });
      this.inflight.set(i, p);
      running.add(p);
      p.catch(() => {});
      if (running.size >= parallel) await Promise.race(running).catch(() => {});
    }
    await Promise.allSettled([...running]);
    if (!this.done && this.have.every(Boolean)) await this.complete();
  }

  // The whole file is fetched: move it into the mirror (keep: the server folder). The open stage fd stays valid
  // after the move, so reads in progress aren't disturbed; it is closed a little later.
  complete() {
    this.completing ??= (async () => {
      const dest = path.join(this.share.mirror, this.rel);
      await moveFile(this.file, dest);
      await fsp.utimes(dest, new Date(), new Date(this.mtime)).catch(() => {});
      this.file = dest;
      this.done = true;
      this.completedAt = Date.now();
      const old = this.fd;
      this.fd = null;
      setTimeout(() => old?.close().catch(() => {}), 5000);
      this.share.stats.complete++;
    })();
    return this.completing;
  }

  // how much of the file is already on the server (for the progress in the UI)
  fetchedBytes() {
    let n = 0;
    for (const h of this.have) n += h;
    return Math.min(this.size, n * CHUNK);
  }

  async read(off, len) {
    len = Math.max(0, Math.min(len, this.size - off));
    if (len === 0) return Buffer.alloc(0);
    await this.ensure(off, len);
    const fd = this.done ? await (this.rfd ??= fsp.open(this.file, 'r')) : this.fd ?? await this.open();
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fd.read(buf, 0, len, off);
    return buf.subarray(0, bytesRead);
  }

  async dispose() {
    const handles = [this.opening, this.rfd];
    this.fd = this.rfd = this.opening = null;
    for (const h of handles) await (await h?.catch(() => null))?.close().catch(() => {});
  }
}

class Share {
  constructor(opts, registry) {
    Object.assign(this, opts);
    this.registry = registry;
    this.agent = null;
    this.q = 0;
    this.pending = new Map();
    this.lists = new Map();        // rel dir → { at, entries: Map }
    this.listing = new Map();      // rel dir → listing fetch in progress (shared by everyone waiting for it)
    this.listGen = new Map();      // rel dir → number of changes made by the server (an older fetch must not undo them)
    this.files = new Map();        // rel → Cached (ondemand)
    this.local = new Set();        // rel of files written on the server (ondemand overlay)
    this.created = new Set();      // rel of files RapidRAW created in this session (may really be deleted)
    this.dirty = new Set();
    this.known = new Map();        // transfer: rel → "size:mtime" already in sync with the browsing computer
    this.timers = new Map();
    this.pushing = new Map();      // rel → queue of sends to the browsing computer (one at a time, the last content wins)
    this.started = Date.now();
    this.waiters = new Set();      // requests waiting for the browser to reconnect
    this.active = [0, 0, 0, 0];    // fetches from the browsing computer in progress, per priority (PRIO)
    this.waiting = [[], [], [], []];
    this.focus = null;             // rel of the photo open in the editor
    this.samples = [];             // [time, bytes] of fetches from the browsing computer, for the speed in the UI
    this.offlineSince = Date.now(); // until the browser connects (attach)
    // fill: total = size of the whole folder, filled = how much of it is already complete on the server
    this.stats = { fetched: 0, complete: 0, uploaded: 0, pushed: 0, total: 0, filled: 0, filling: false, diskFull: false };
    this.stage = path.join(WORK, 'stage', this.id);
  }

  get view() { return this.mode === 'ondemand' ? this.mount : this.mirror; }

  info() {
    return { id: this.id, name: this.name, mode: this.mode, keep: this.keep, fill: !!this.fill, view: this.view, mirror: this.mirror,
      online: !!this.agent, stats: this.stats };
  }

  // --- agent (browser) ---
  attach(ws) {
    this.agent?.close();
    this.agent = ws;
    this.offlineSince = 0;
    for (const w of this.waiters) w();
    this.waiters.clear();
    // tunnels and proxies close an idle WebSocket; a ping keeps it open
    const keepalive = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 20000);
    ws.on('error', (e) => console.warn(`[remote] ${this.name}: ${e.message}`));
    ws.on('message', (data, isBinary) => {
      if (!isBinary || data.length < 8) return;
      const q = data.readUInt32LE(0);
      const hlen = data.readUInt32LE(4);
      let head;
      try { head = JSON.parse(data.subarray(8, 8 + hlen)); } catch { return; }
      const p = this.pending.get(q);
      if (!p) return;
      this.pending.delete(q);
      if (head.err) p.reject(fail(head.err in ERRNO ? head.err : 'EIO', head.err));
      else p.resolve({ head, data: data.subarray(8 + hlen) });
    });
    ws.on('close', () => {
      clearInterval(keepalive);
      if (this.agent !== ws) return;
      this.agent = null;
      this.offlineSince = Date.now();
      for (const p of this.pending.values()) p.reject(fail('EOFFLINE', 'client folder disconnected'));
      this.pending.clear();
      console.log(`[remote] ${this.name}: client disconnected, waiting for it to reconnect`);
    });
    console.log(`[remote] ${this.name}: client connected`);
  }

  // When the connection to the browser breaks (tunnel, Wi-Fi, reloading the page), a request waits for it to
  // reconnect and tries again. Through mmap an error would turn into SIGBUS and crash RapidRAW, so it is reported
  // only after RECONNECT_WAIT.
  async request(head, data) {
    for (let attempt = 0; ; attempt++) {
      await this.online();
      try { return await this.send(head, data); } catch (e) {
        if (e.code !== 'EOFFLINE' || attempt >= 4) throw e.code === 'EOFFLINE' ? fail('EIO', e.message) : e;
      }
    }
  }

  // Waits at most until RECONNECT_WAIT after the disconnect; a folder disconnected for longer fails at once
  // (otherwise every listing of the folder and every RapidRAW stat on it would hang for two minutes)
  online() {
    if (this.agent) return Promise.resolve();
    if (this.stopped) return Promise.reject(fail('EIO', 'stopped'));
    const left = this.offlineSince + RECONNECT_WAIT - Date.now();
    if (left <= 0) return Promise.reject(fail('EIO', 'client folder is not connected'));
    return new Promise((resolve, reject) => {
      const w = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { this.waiters.delete(w); reject(fail('EIO', 'client folder is not connected')); }, left);
      w.fail = () => { clearTimeout(t); reject(fail('EIO', 'stopped')); };
      this.waiters.add(w);
    });
  }

  send(head, data) {
    if (!this.agent) return Promise.reject(fail('EOFFLINE', 'client folder disconnected'));
    this.q = (this.q + 1) >>> 0 || 1;
    const q = this.q;
    return new Promise((resolve, reject) => {
      this.pending.set(q, { resolve, reject });
      this.agent.send(frame(q, head, data), (e) => {
        if (e && this.pending.delete(q)) reject(fail('EOFFLINE', e.message));
      });
    });
  }

  // The focus (photo in the editor) may always have up to READS fetches, regardless of the others; the others share
  // READS, and a class starts only when no more important one runs or waits (thumbnails must not slow down opening
  // a photo)
  canStart(p) {
    if (p === PRIO.FOCUS) return this.active[0] < READS;
    if (this.active[1] + this.active[2] + this.active[3] >= READS) return false;
    for (let q = 0; q < p; q++) if (this.active[q] || this.waiting[q].length) return false;
    return true;
  }

  slot(p) {
    if (this.canStart(p)) { this.active[p]++; return Promise.resolve(); }
    return new Promise((r) => this.waiting[p].push(r));
  }

  unslot(p) {
    this.active[p]--;
    for (let q = 0; q < this.waiting.length; q++) {
      while (this.waiting[q].length && this.canStart(q)) { this.active[q]++; this.waiting[q].shift()(); }
    }
  }

  recordFetch(n) {
    const now = Date.now();
    this.samples.push([now, n]);
    while (this.samples.length && now - this.samples[0][0] > 3000) this.samples.shift();
  }

  // bytes/s over the last 3 s
  rate() {
    const now = Date.now();
    const recent = this.samples.filter(([t]) => now - t <= 3000);
    if (!recent.length) return 0;
    return recent.reduce((s, [, n]) => s + n, 0) / Math.max(1, (now - recent[0][0]) / 1000);
  }

  async requestAt(p, head, data) {
    await this.slot(p);
    try { return await this.request(head, data); } finally { this.unslot(p); }
  }

  // the photo and its sidecars (.rrdata, .rrexif, virtual copies)
  isFocus(rel) { return !!this.focus && (rel === this.focus || rel.startsWith(`${this.focus}.`)); }

  // The photo open in the editor: RapidRAW reads it whole anyway, so fetch it at once, in parallel, ahead of everything
  setFocus(rel) {
    this.focus = rel;
    this.cached(rel).then((c) => (c.done ? null : c.fill(PRIO.FOCUS, READS)))
      .catch((e) => { if (e.code !== 'ENOENT' && e.code !== 'EISDIR') console.warn(`[remote] ${this.name}: focus ${rel}: ${e.message}`); });
  }

  // ondemand + fill: the whole folder slowly fills up on the server while RapidRAW reads nothing else
  async fillAll() {
    this.stats.filling = true;
    const files = [];
    const walk = async (rel) => {
      for (const e of (await this.list(rel)).values()) {
        if (this.stopped || e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.kind === 'dir') await walk(r);
        else { files.push(r); this.stats.total += e.size ?? 0; }
      }
    };
    try {
      await walk('');
      console.log(`[remote] ${this.name}: filling ${files.length} files (${(this.stats.total / 1e9).toFixed(1)} GB) in the background`);
      for (const rel of files) {
        if (this.stopped) break;
        if (this.local.has(rel)) continue; // RapidRAW already overwrote it on the server
        await editor.idle(() => this.stopped);
        try {
          const c = await this.cached(rel);
          if (c.done) { this.stats.filled += c.size; continue; }
          // don't fill the server's disk to the end (the mirror may be in RR_WORK, i.e. on the system disk)
          const st = await fsp.statfs(this.mirror);
          if (st.bavail * st.bsize - c.size < FILL_RESERVE) {
            console.warn(`[remote] ${this.name}: background fill stopped, less than ${FILL_RESERVE / 1e9} GB free on the server`);
            this.stats.diskFull = true;
            break;
          }
          await c.fill();
          if (c.done) this.stats.filled += c.size;
        } catch (e) { if (!this.stopped) console.warn(`[remote] ${this.name}: fill ${rel}: ${e.message}`); }
      }
    } finally { this.stats.filling = false; }
  }

  // Listing a big folder takes time (1330 files: ~1 s, up to 10 s while the browser also sends other data), and
  // RapidRAW runs some file operations on its main thread (e.g. saving the edit after every change: stat and EXIF
  // of the photo), so everything waits meanwhile, slider previews too. So a stat doesn't wait for a new listing: it
  // takes the stored one and refreshes it in the background.
  async list(rel, fresh = true) {
    const c = this.lists.get(rel);
    const age = c ? Date.now() - c.at : Infinity;
    if (age < LIST_TTL) return c.entries;
    if (!fresh && age < LIST_STALE) {
      if (age >= LIST_REFRESH) this.fetchList(rel).catch(() => {});
      return c.entries;
    }
    return this.fetchList(rel);
  }

  fetchList(rel) {
    let p = this.listing.get(rel);
    if (p) return p;
    const gen = this.listGen.get(rel) ?? 0;
    p = this.request({ op: 'list', path: rel }).then(({ head }) => {
      const entries = new Map(head.entries.map((e) => [e.name, e]));
      const old = this.lists.get(rel);
      // the server changed something in the folder during the fetch: keep the listing with that change, refresh it
      // next time
      if ((this.listGen.get(rel) ?? 0) !== gen) {
        if (old) { old.at = Math.min(old.at, Date.now() - LIST_REFRESH); return old.entries; }
        this.lists.set(rel, { at: Date.now() - LIST_REFRESH, entries });
        return entries;
      }
      this.lists.set(rel, { at: Date.now(), entries });
      return entries;
    }).finally(() => { if (this.listing.get(rel) === p) this.listing.delete(rel); });
    this.listing.set(rel, p);
    return p;
  }

  invalidate(rel) { this.lists.delete(rel); }

  // A change made by the server (RapidRAW): straight into the stored listing, without fetching a new one
  patchList(dir, name, entry) {
    this.listGen.set(dir, (this.listGen.get(dir) ?? 0) + 1);
    const c = this.lists.get(dir);
    if (!c) return;
    if (entry) c.entries.set(name, { ...entry, name });
    else c.entries.delete(name);
  }

  // A file written/changed on the server → into the folder on the browsing computer (in pieces)
  async push(rel, file) {
    const st = await fsp.stat(file);
    const fd = await fsp.open(file, 'r');
    try {
      let off = 0;
      do {
        const buf = Buffer.allocUnsafe(Math.min(PUSH, st.size - off));
        const { bytesRead } = await fd.read(buf, 0, buf.length, off);
        await this.request({ op: 'write', path: rel, off, trunc: off === 0, done: off + bytesRead >= st.size, mtime: st.mtimeMs }, buf.subarray(0, bytesRead));
        off += bytesRead;
      } while (off < st.size);
    } finally { await fd.close(); }
    this.known.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`);
    this.stats.pushed++;
    this.patchList(parentOf(rel), nameOf(rel), { kind: 'file', size: st.size, mtime: Math.round(st.mtimeMs) });
  }

  // Sends of the same file go one after another (a FUSE release arrives asynchronously, after close), and deleting
  // and renaming wait for the send to finish, otherwise deleted or old content would still reach the browsing computer.
  queuePush(rel, file = this.localPath(rel)) {
    const p = (this.pushing.get(rel) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (await exists(file)) await this.push(rel, file);
    });
    this.pushing.set(rel, p);
    p.finally(() => { if (this.pushing.get(rel) === p) this.pushing.delete(rel); }).catch(() => {});
    return p;
  }

  async settled(rel) { await this.pushing.get(rel)?.catch(() => {}); }

  async remoteRemove(rel) {
    await this.request({ op: 'remove', path: rel, recursive: false }).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  // An original on the browsing computer is never deleted permanently: it goes into a hidden .rrweb-trash/ in the
  // same folder (RapidRAW on a FUSE disk sometimes can't use its trash and then deletes permanently)
  async remoteTrash(rel) {
    await this.request({ op: 'rename', from: rel, to: `.rrweb-trash/${Date.now()}-${rel.replaceAll('/', '__')}` })
      .catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  // --- ondemand: operations from rrweb-fuse ---
  localPath(rel) { return path.join(this.mirror, rel); }

  async attr(rel) {
    if (rel === '') return { kind: 'dir', size: 0, mtime: Date.now() };
    if (this.local.has(rel)) {
      const st = await fsp.stat(this.localPath(rel));
      return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: Math.round(st.mtimeMs) };
    }
    const e = (await this.list(parentOf(rel), false)).get(nameOf(rel));
    if (!e) throw fail('ENOENT');
    return { kind: e.kind, size: e.size ?? 0, mtime: e.mtime ?? this.started }; // folders from the browser have no date
  }

  async cached(rel) {
    const a = await this.attr(rel);
    if (a.kind === 'dir') throw fail('EISDIR');
    let c = this.files.get(rel);
    if (c && (c.size !== a.size || c.mtime !== a.mtime)) { await c.dispose(); c = null; } // changed on the browsing computer
    if (!c) {
      c = new Cached(this, rel, a.size, a.mtime);
      const kept = this.localPath(rel); // keep: already complete on the server from before?
      const st = await fsp.stat(kept).catch(() => null);
      if (st?.isFile() && st.size === a.size) { c.done = true; c.file = kept; }
      this.files.set(rel, c);
    }
    return c;
  }

  // Local (overlay) copy of a file for writing; existing content first fetched whole from the browsing computer
  async materialize(rel, keepContent) {
    if (this.local.has(rel)) return this.localPath(rel);
    const dest = this.localPath(rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (keepContent) {
      const c = await this.cached(rel);
      await c.ensure(0, c.size);
      if (c.file !== dest) await fsp.copyFile(c.file, dest);
    } else await fsp.writeFile(dest, '');
    this.local.add(rel);
    return dest;
  }

  async fuseOp(h, data) {
    const rel = h.path === undefined ? undefined : checkRel(h.path);
    switch (h.op) {
      case 'getattr': return this.attr(rel);
      case 'readdir': { // size and time for Windows (WinFsp reads them from the directory listing)
        const entries = new Map(await this.list(rel));
        for (const l of this.local) {
          if (parentOf(l) !== rel) continue;
          const st = await fsp.stat(this.localPath(l)).catch(() => null);
          if (st) entries.set(nameOf(l), { name: nameOf(l), kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: Math.round(st.mtimeMs) });
        }
        return { entries: [...entries.values()].map((e) => ({ name: e.name, kind: e.kind, size: e.size ?? 0, mtime: e.mtime ?? this.started })) };
      }
      case 'read': {
        if (this.local.has(rel)) {
          const fd = await fsp.open(this.localPath(rel), 'r');
          try {
            const buf = Buffer.allocUnsafe(h.len);
            const { bytesRead } = await fd.read(buf, 0, h.len, h.off);
            return [{}, buf.subarray(0, bytesRead)];
          } finally { await fd.close(); }
        }
        return [{}, await (await this.cached(rel)).read(h.off, h.len)];
      }
      case 'create': {
        await this.materialize(rel, false);
        this.created.add(rel);
        this.dirty.add(rel);
        this.patchList(parentOf(rel), nameOf(rel), { kind: 'file', size: 0, mtime: Date.now() });
        return { kind: 'file', size: 0, mtime: Date.now() };
      }
      case 'write': {
        const file = await this.materialize(rel, true);
        const fd = await fsp.open(file, 'r+');
        try { await fd.write(data, 0, data.length, h.off); } finally { await fd.close(); }
        this.dirty.add(rel);
        return {};
      }
      case 'truncate': {
        const file = await this.materialize(rel, h.size > 0);
        await fsp.truncate(file, h.size);
        this.dirty.add(rel);
        return {};
      }
      case 'release': {
        if (this.dirty.delete(rel)) await this.queuePush(rel);
        return {};
      }
      case 'mkdir': {
        await this.request({ op: 'mkdir', path: rel });
        await fsp.mkdir(this.localPath(rel), { recursive: true });
        this.patchList(parentOf(rel), nameOf(rel), { kind: 'dir' });
        this.invalidate(rel);
        return { kind: 'dir', size: 0, mtime: Date.now() };
      }
      case 'unlink':
      case 'rmdir': {
        this.dirty.delete(rel);
        await this.settled(rel);
        if (h.op === 'unlink' && !this.created.has(rel)) await this.remoteTrash(rel);
        else await this.remoteRemove(rel);
        this.created.delete(rel);
        this.local.delete(rel);
        await this.files.get(rel)?.dispose();
        this.files.delete(rel);
        await fsp.rm(this.localPath(rel), { recursive: h.op === 'rmdir', force: true });
        this.patchList(parentOf(rel), nameOf(rel), null);
        if (h.op === 'rmdir') this.invalidate(rel);
        return {};
      }
      case 'rename': {
        const from = checkRel(h.from);
        const to = checkRel(h.to);
        await this.settled(from);
        let remoteMissing = false;
        await this.request({ op: 'rename', from, to }).catch((e) => { if (e.code === 'ENOENT') remoteMissing = true; else throw e; });
        await this.files.get(from)?.dispose();
        this.files.delete(from);
        if (this.local.delete(from)) this.local.add(to);
        if (this.dirty.delete(from)) this.dirty.add(to);
        if (this.created.delete(from)) this.created.add(to);
        if (await exists(this.localPath(from))) await moveFile(this.localPath(from), this.localPath(to));
        if (remoteMissing && this.local.has(to) && !this.dirty.has(to)) await this.queuePush(to); // not sent yet
        const moved = this.lists.get(parentOf(from))?.entries.get(nameOf(from));
        this.patchList(parentOf(from), nameOf(from), null);
        this.patchList(parentOf(to), nameOf(to), moved ?? null);
        if (!moved) this.invalidate(parentOf(to)); // wasn't in the listing: fetch the target's listing again
        for (const d of [...this.lists.keys()]) if (d === from || d.startsWith(`${from}/`)) this.invalidate(d);
        return {};
      }
      default: throw fail('EINVAL', `unknown op ${h.op}`);
    }
  }

  async mountFuse() {
    lazyUnmount(this.mount); // left over from an earlier relay crash
    if (WIN) { // WinFsp creates the mount folder itself; it must not exist
      await fsp.mkdir(path.dirname(this.mount), { recursive: true });
      await fsp.rmdir(this.mount).catch(() => {});
    } else await fsp.mkdir(this.mount, { recursive: true });
    const child = spawn(FUSE_BIN, [this.mount], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.fuse = child;
    // the helper can disappear (crash, kill); writing to its stdin must not take the relay down
    child.stdin.on('error', (e) => console.warn(`[remote] ${this.name}: rrweb-fuse stdin: ${e.message}`));
    child.on('error', (e) => console.warn(`[remote] ${this.name}: rrweb-fuse: ${e.message}`));
    let buf = Buffer.alloc(0);
    const send = (head, data = Buffer.alloc(0)) => {
      const h = Buffer.from(JSON.stringify(head));
      const out = Buffer.allocUnsafe(8 + h.length + data.length);
      out.writeUInt32LE(h.length, 0);
      out.writeUInt32LE(data.length, 4);
      h.copy(out, 8);
      data.copy(out, 8 + h.length);
      if (child.stdin.writable) child.stdin.write(out);
    };
    const mounted = new Promise((resolve, reject) => {
      child.once('exit', (code) => reject(new Error(`rrweb-fuse exited (${code})`)));
      child.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const hlen = buf.readUInt32LE(0);
          const dlen = buf.readUInt32LE(4);
          if (buf.length < 8 + hlen + dlen) break;
          let head;
          try { head = JSON.parse(buf.subarray(8, 8 + hlen)); } catch { buf = buf.subarray(8 + hlen + dlen); continue; }
          const data = buf.subarray(8 + hlen, 8 + hlen + dlen);
          buf = buf.subarray(8 + hlen + dlen);
          if (head.op === 'mounted') { resolve(); continue; }
          if (VERBOSE && head.op !== 'read' && head.op !== 'write') console.log(`[fuse] ${head.op} ${head.path ?? `${head.from} → ${head.to}`}`);
          this.fuseOp(head, data).then(
            (r) => (Array.isArray(r) ? send({ id: head.id, ...r[0] }, r[1]) : send({ id: head.id, ...r })),
            (e) => {
              if (VERBOSE) console.log(`[fuse] ${head.op} ${head.path ?? `${head.from} → ${head.to}`}: ${e.code ?? e.message}`);
              if (e.code !== 'ENOENT') console.warn(`[remote] ${this.name}: ${head.op} ${head.path ?? ''}: ${e.message}`);
              send({ id: head.id, err: ERRNO[e.code] ?? ERRNO.EIO });
            });
        }
      });
    });
    child.on('exit', (code, sig) => {
      if (this.fuse === child) this.fuse = null;
      lazyUnmount(this.mount);
      if (!this.stopped) console.warn(`[remote] ${this.name}: rrweb-fuse exited (${sig ?? code})`);
    });
    await Promise.race([mounted, new Promise((_, r) => setTimeout(() => r(new Error('mount timeout')), 10000))]);
    console.log(`[remote] ${this.name}: mounted at ${this.mount}`);
  }

  // --- transfer: a mirror on the server, changes back to the browsing computer ---
  async receive(rel, req, mtime) {
    checkRel(rel);
    const tmp = path.join(this.stage, 'upload', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      const dest = path.join(this.mirror, rel);
      if (mtime) await fsp.utimes(tmp, new Date(), new Date(mtime));
      const st = await fsp.stat(tmp);
      this.known.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`); // before the move, so the watcher doesn't send it back
      await moveFile(tmp, dest);
      this.stats.uploaded++;
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  async have() {
    const out = {};
    const walk = async (dir, rel) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (e.isFile()) {
          const st = await fsp.stat(path.join(dir, e.name));
          out[r] = { size: st.size, mtime: Math.round(st.mtimeMs) };
          this.known.set(r, `${st.size}:${Math.round(st.mtimeMs)}`);
        }
      }
    };
    await walk(this.mirror, '');
    return out;
  }

  watch() {
    this.watcher = fs.watch(this.mirror, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const rel = name.split(path.sep).join('/');
      clearTimeout(this.timers.get(rel));
      this.timers.set(rel, setTimeout(() => { this.timers.delete(rel); this.sync(rel).catch((e) => console.warn(`[remote] ${this.name}: ${rel}: ${e.message}`)); }, 1500));
    });
  }

  async sync(rel) {
    if (!this.agent || rel.split('/').some((s) => s.startsWith('.rrweb'))) return;
    const st = await fsp.stat(path.join(this.mirror, rel)).catch(() => null);
    if (!st) return; // deletions are deliberately not sent to the browsing computer
    if (st.isDirectory()) { await this.request({ op: 'mkdir', path: rel }); return; }
    if (this.known.get(rel) === `${st.size}:${Math.round(st.mtimeMs)}`) return;
    await this.queuePush(rel, path.join(this.mirror, rel));
    console.log(`[remote] ${this.name}: ${rel} → client`);
  }

  async start() {
    await fsp.mkdir(this.mirror, { recursive: true });
    if (this.mode === 'ondemand') {
      await this.mountFuse();
      if (this.fill) this.online().then(() => this.fillAll()).catch(() => {});
    } else { await this.have(); this.watch(); }
  }

  async stop() {
    this.stopped = true;
    for (const w of this.waiters) w.fail();
    this.waiters.clear();
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const c of this.files.values()) await c.dispose();
    if (this.fuse) {
      const child = this.fuse;
      await new Promise((r) => { child.once('exit', r); child.stdin.end(); setTimeout(r, 5000); });
    }
    this.agent?.close();
    await fsp.rm(this.stage, { recursive: true, force: true });
    if (!this.keep) await fsp.rm(path.join(WORK, 'mirror', this.id), { recursive: true, force: true });
    if (this.mode === 'ondemand') {
      // never recursively: on a mount that is still attached, rm would go through FUSE (and hang, or delete on the
      // browsing computer)
      lazyUnmount(this.mount);
      await fsp.rmdir(this.mount).catch(() => {});
      await fsp.rmdir(path.dirname(this.mount)).catch(() => {});
    }
  }
}

// onChange(): the list of shared folders changed (the relay refreshes the Files tab roots)
export function createRemote({ validName, insideRoots, onChange = () => {} }) {
  const shares = new Map();
  const id = () => Math.random().toString(36).slice(2, 10);

  async function start({ id: wanted, name, mode, keep, keepDir, fill = true }) {
    validName(name);
    if (mode !== 'transfer' && mode !== 'ondemand') throw new Error('mode must be transfer or ondemand');
    if (mode === 'ondemand' && !capabilities().ondemand) throw new Error(capabilities().reason);
    const existing = wanted && shares.get(wanted);
    if (existing) return existing.info();
    const sid = wanted && /^[a-z0-9]{6,16}$/.test(wanted) ? wanted : id();
    let mirror = path.join(WORK, 'mirror', sid, name);
    if (keep) {
      if (!keepDir) throw new Error('choose a server folder for the kept copy');
      const dir = await insideRoots(keepDir); // only inside the photo folders
      mirror = path.join(dir, name);
    }
    const share = new Share({ id: sid, name, mode, keep: !!keep, fill: mode === 'ondemand' && fill !== false, mirror,
      mount: path.join(WORK, 'mnt', sid, name) }, shares);
    await share.start();
    shares.set(sid, share);
    onChange();
    console.log(`[remote] ${name}: ${mode}${keep ? ` (copy kept in ${mirror})` : ''} → ${share.view}`);
    return share.info();
  }

  async function stop({ id: sid }) {
    const s = shares.get(sid);
    if (!s) return;
    shares.delete(sid);
    onChange();
    await s.stop();
  }

  return {
    commands: {
      __rr_share_caps: () => ({ ...capabilities(), work: WORK }),
      __rr_share_start: start,
      __rr_share_stop: stop,
      __rr_share_list: () => [...shares.values()].map((s) => s.info()),
      __rr_share_have: async ({ id: sid }) => shares.get(sid)?.have() ?? {},
    },
    // /rfs?id=… WebSocket of the browser that shares the folder
    attach(ws, sid) {
      const s = shares.get(sid);
      if (!s) { ws.on('error', () => {}); ws.close(4004, 'unknown share'); return; }
      s.attach(ws);
    },
    // PUT /rfs/put?id=…&path=…&mtime=… (transfer upload)
    async http(req, res, u) {
      try {
        const s = shares.get(u.searchParams.get('id'));
        if (!s || req.method !== 'PUT' || u.pathname !== '/rfs/put') { res.writeHead(404).end(); return; }
        await s.receive(u.searchParams.get('path') ?? '', req, Number(u.searchParams.get('mtime')) || 0);
        res.writeHead(204).end();
      } catch (e) {
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' }).end(e.message);
      }
    },
    work: WORK,
    // Mounts left over from an earlier relay crash. Only once the relay has taken the port: while another relay runs
    // (same RR_WORK), its mounts are not dead
    sweep() {
      if (process.platform !== 'linux') return;
      try {
        for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
          const [, raw, type] = line.split(' ');
          const dir = raw?.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))); // a space = \040
          if (type === 'fuse.rrweb' && dir?.startsWith(WORK + path.sep)) { lazyUnmount(dir); console.log(`[remote] cleaned up stale mount ${dir}`); }
        }
      } catch { /* no /proc/mounts */ }
    },
    roots: () => [...shares.values()].map((s) => s.view),
    // a file from an on-demand folder whose browser has been disconnected for more than a few seconds (a short
    // interruption is waited out)
    offline(p) {
      const hit = typeof p === 'string' ? this.locate(p.split('?vc=')[0]) : null;
      return !!hit && !hit.share.agent && Date.now() - hit.share.offlineSince > 5000;
    },
    // Progress of opening a photo for the UI (rrweb/files/progress.ts): null for photos outside on-demand folders
    progress(p) {
      const hit = typeof p === 'string' ? this.locate(p.split('?vc=')[0]) : null;
      if (!hit) return null;
      const { share, rel } = hit;
      if (!share.agent && Date.now() - share.offlineSince > 5000) return { phase: 'offline' };
      const c = share.files.get(rel);
      if (c?.done) return { phase: 'decoding', completedAt: c.completedAt ?? 0 };
      return { phase: 'downloading', fetched: c ? c.fetchedBytes() : 0, total: c?.size ?? 0, rate: Math.round(share.rate()) };
    },
    // a file from an on-demand folder that is being fetched right now: { fetched, total } (thumbnails in the UI)
    fetching(p) {
      const hit = typeof p === 'string' ? this.locate(p.split('?vc=')[0]) : null;
      const c = hit?.share.files.get(hit.rel);
      return c && !c.done && c.inflight.size ? { fetched: c.fetchedBytes(), total: c.size } : null;
    },
    // load_image from the editor: if the photo is in an on-demand folder, fetch it ahead of everything else
    focus(p) {
      const hit = typeof p === 'string' && !p.includes('?vc=') ? this.locate(p) : null;
      if (hit) hit.share.setFocus(hit.rel);
    },
    // a path on the mount of an on-demand folder → { share, rel } (rrweb/relay/exif.mjs)
    locate(p) {
      for (const s of shares.values()) {
        if (s.mode !== 'ondemand' || (p !== s.view && !p.startsWith(s.view + path.sep))) continue;
        const rel = p.slice(s.view.length + 1).split(path.sep).join('/');
        try { return { share: s, rel: checkRel(rel) }; } catch { return null; }
      }
      return null;
    },
    labels: () => Object.fromEntries([...shares.values()].map((s) => [s.view, `${s.name} (this computer${s.agent ? '' : ', not connected'})`])),
    async shutdown() { for (const s of shares.values()) await s.stop().catch(() => {}); },
  };
}
